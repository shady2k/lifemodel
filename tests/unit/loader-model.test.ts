import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { CHECK_SESSION_ID, createModelChecker, ModelCheckError } from '../../loader/src/model.js';
import { modelEndpointUrl } from '../../loader/src/model-url.js';

const servers: Array<Server | HttpsServer> = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});
async function listen(
  handler: Parameters<typeof createServer>[0]
): Promise<{ url: string; port: number }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  return { url: `http://${localPrivateAddress()}:${address.port}/v1`, port: address.port };
}
function localPrivateAddress(): string {
  const addresses = Object.values(networkInterfaces())
    .flatMap((items) => items ?? [])
    .filter(
      (item) =>
        item.family === 'IPv4' &&
        !item.internal &&
        /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(item.address)
    );
  const address = addresses[0]?.address;
  if (address === undefined) throw new Error('test container has no private IPv4 address');
  return address;
}
const validReply = JSON.stringify({ choices: [{ message: { content: 'OK' } }] });
describe('loader model endpoint checker', () => {
  it.each([undefined, 'none', 'minimal', 'low', 'medium', 'high'] as const)(
    'checks the same effort the slot sends upstream (%s)',
    async (reasoningEffort) => {
      const bodies: Record<string, unknown>[] = [];
      const check = createModelChecker({
        resolveHost: async () => ['192.168.1.20'],
        request: async (_url, _address, body) => {
          bodies.push(JSON.parse(body));
          return { status: 200, body: validReply };
        },
      });
      await check({
        kind: 'openai',
        baseUrl: 'https://model.example/v1',
        model: 'm',
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      });
      expect(bodies[0]?.reasoning_effort).toBe(reasoningEffort);
      expect(Object.hasOwn(bodies[0]!, 'reasoning_effort')).toBe(reasoningEffort !== undefined);
    }
  );
  it('keeps a complete API base prefix when building the chat check URL', () => {
    expect(modelEndpointUrl('https://models.example/prefix/v1').pathname).toBe(
      '/prefix/v1/chat/completions'
    );
  });
  it('accepts the named in-cluster Ollama service after validating its resolved service address', async () => {
    let target: URL | undefined;
    const check = createModelChecker({
      resolveHost: async (hostname) => {
        expect(hostname).toBe('ollama.ollama.svc.cluster.local');
        return ['10.43.6.2'];
      },
      request: async (url) => {
        target = url;
        return { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'OK' } }] }) };
      },
    });
    await expect(
      check({
        kind: 'ollama',
        baseUrl: 'http://ollama.ollama.svc.cluster.local:11434/v1',
        model: 'tiny',
      })
    ).resolves.toBeUndefined();
    expect(target?.pathname).toBe('/v1/chat/completions');
  });
  it('refuses another cluster Service even when its address is private', async () => {
    const check = createModelChecker({
      resolveHost: async () => ['10.44.6.2'],
      request: async () => ({ status: 200, body: '{"choices":[]}' }),
    });
    await expect(
      check({
        kind: 'ollama',
        baseUrl: 'http://other.ollama.svc.cluster.local:11434/v1',
        model: 'm',
      })
    ).rejects.toMatchObject({ code: 'blocked_destination' });
  });
  it('refuses an unrelated cluster Service resolving inside the Service CIDR before connecting', async () => {
    const request = vi.fn(async () => ({ status: 200, body: '{"choices":[]}' }));
    const check = createModelChecker({
      resolveHost: async () => ['10.43.6.2'],
      request,
    });
    await expect(
      check({
        kind: 'ollama',
        baseUrl: 'http://other.ollama.svc.cluster.local:11434/v1',
        model: 'm',
      })
    ).rejects.toMatchObject({ code: 'blocked_destination' });
    expect(request).not.toHaveBeenCalled();
  });
  it('refuses public plaintext and mapped IPv6 destinations before connecting', async () => {
    const check = createModelChecker({ resolveHost: async () => ['::ffff:10.0.0.1'] });
    await expect(
      check({ kind: 'ollama', baseUrl: 'http://example.com/v1', model: 'm' })
    ).rejects.toMatchObject({ code: 'blocked_destination' });
    await expect(
      check({ kind: 'openai', baseUrl: 'https://[::ffff:10.0.0.1]/v1', model: 'm' })
    ).rejects.toBeInstanceOf(ModelCheckError);
  });
  it('blocks IPv6, mapped IPv6, and metadata literals before a request', async () => {
    const check = createModelChecker({
      request: async () => {
        throw new Error('must not connect');
      },
    });
    for (const baseUrl of [
      'https://[::1]/v1',
      'https://[fe80::1]/v1',
      'https://[::ffff:169.254.169.254]/v1',
      'http://169.254.1.2/v1',
    ]) {
      await expect(check({ kind: 'openai', baseUrl, model: 'm' })).rejects.toMatchObject({
        code: 'blocked_destination',
      });
    }
  });

  it('never exposes an echoed key from a real endpoint on success or error', async () => {
    for (const status of [200, 500]) {
      const secret = 'real-upstream-secret';
      const server = await listen((req, res) => {
        expect(req.headers.authorization).toBe(`Bearer ${secret}`);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(
          status === 200
            ? JSON.stringify({ choices: [], echo: secret })
            : JSON.stringify({ message: secret })
        );
      });
      const check = createModelChecker();
      let failure: unknown;
      try {
        await check({ kind: 'ollama', baseUrl: server.url, model: 'tiny', key: secret });
      } catch (error) {
        failure = error;
      }
      if (status === 200) expect(failure).toBeUndefined();
      else expect(failure).toBeInstanceOf(ModelCheckError);
      expect(JSON.stringify(failure ?? {})).not.toContain(secret);
      if (failure instanceof Error) expect(failure.message).not.toContain(secret);
    }
  });

  it('allows RFC1918 HTTP Ollama endpoints but rejects cluster and link-local resolutions', async () => {
    const accepted = createModelChecker({
      resolveHost: async () => ['192.168.1.20'],
      request: async () => ({ status: 200, body: '{"choices":[]}' }),
    });
    await expect(
      accepted({ kind: 'ollama', baseUrl: 'http://ollama.lan/v1', model: 'm' })
    ).resolves.toBeUndefined();
    const cluster = createModelChecker({
      resolveHost: async () => ['10.42.1.3'],
      request: async () => ({ status: 200, body: '{"choices":[]}' }),
    });
    await expect(
      cluster({ kind: 'openai', baseUrl: 'https://example.com/v1', model: 'm' })
    ).rejects.toMatchObject({ code: 'blocked_destination' });
    const metadata = createModelChecker({ resolveHost: async () => ['169.254.169.254'] });
    await expect(
      metadata({ kind: 'openai', baseUrl: 'https://metadata.example/v1', model: 'm' })
    ).rejects.toMatchObject({ code: 'blocked_destination' });
  });
  it('uses a real local HTTP server pinned to the one resolved private address', async () => {
    let requests = 0;
    const server = await listen((req, res) => {
      requests += 1;
      expect(req.url).toBe('/v1/chat/completions');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(validReply);
    });
    const check = createModelChecker();
    await expect(
      check({ kind: 'ollama', baseUrl: server.url, model: 'tiny' })
    ).resolves.toBeUndefined();
    expect(requests).toBe(1);
  });

  it('resolves a real HTTP hostname once, pins the peer, and preserves Host', async () => {
    let calls = 0;
    let seenHost: string | undefined;
    let peer: string | undefined;
    const server = await listen((req, res) => {
      seenHost = req.headers.host;
      peer = req.socket.remoteAddress;
      res.end(validReply);
    });
    const port = new URL(server.url).port;
    const check = createModelChecker({
      resolveHost: async (hostname) => {
        calls += 1;
        expect(hostname).toBe('model.test');
        return calls === 1 ? [localPrivateAddress()] : ['169.254.169.254'];
      },
    });
    await expect(
      check({ kind: 'ollama', baseUrl: `http://model.test:${port}/v1`, model: 'tiny' })
    ).resolves.toBeUndefined();
    expect(calls).toBe(1);
    expect(seenHost).toBe(`model.test:${port}`);
    expect(peer).toBeDefined();
  });

  it('resolves a real HTTPS hostname once, pins the peer, and preserves Host and SNI', async () => {
    let calls = 0;
    let seenHost: string | undefined;
    let seenSni: string | undefined;
    const server = createHttpsServer(
      {
        key: readFileSync(join(process.cwd(), 'tests/fixtures/model-test.key')),
        cert: readFileSync(join(process.cwd(), 'tests/fixtures/model-test.crt')),
      },
      (req, res) => {
        seenHost = req.headers.host;
        seenSni = req.socket.servername;
        res.end(validReply);
      }
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const cert = readFileSync(join(process.cwd(), 'tests/fixtures/model-test.crt'));
    const check = createModelChecker({
      tlsCa: cert,
      resolveHost: async (hostname) => {
        calls += 1;
        expect(hostname).toBe('model.test');
        return calls === 1 ? [localPrivateAddress()] : ['169.254.169.254'];
      },
    });
    await expect(
      check({ kind: 'openai', baseUrl: `https://model.test:${address.port}/v1`, model: 'tiny' })
    ).resolves.toBeUndefined();
    expect(calls).toBe(1);
    expect(seenHost).toBe(`model.test:${address.port}`);
    expect(seenSni).toBe('model.test');
  });

  it('rejects trusted wrong-host and untrusted certificates before sending HTTP or the key', async () => {
    let requests = 0;
    const server = createHttpsServer(
      {
        key: readFileSync(join(process.cwd(), 'tests/fixtures/model-test.key')),
        cert: readFileSync(join(process.cwd(), 'tests/fixtures/model-test.crt')),
      },
      (_req, res) => {
        requests += 1;
        res.end(validReply);
      }
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const tlsCa = readFileSync(join(process.cwd(), 'tests/fixtures/model-test.crt'));
    for (const [hostname, trusted] of [
      ['wrong.test', true],
      ['model.test', false],
    ] as const) {
      const check = createModelChecker({
        ...(trusted ? { tlsCa } : {}),
        resolveHost: async () => [localPrivateAddress()],
      });
      let failure: unknown;
      try {
        await check({
          kind: 'openai',
          baseUrl: `https://${hostname}:${address.port}/v1`,
          model: 'tiny',
          key: 'must-not-reach-server',
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'tls' });
      expect(JSON.stringify(failure)).not.toContain('must-not-reach-server');
    }
    expect(requests).toBe(0);
  });

  it('refuses a rebinding result and redirect to a private target before following it', async () => {
    let requests = 0;
    const server = await listen((_req, res) => {
      requests += 1;
      res.writeHead(302, { location: 'http://127.0.0.1/private' });
      res.end();
    });
    const redirectCheck = createModelChecker();
    await expect(
      redirectCheck({ kind: 'ollama', baseUrl: server.url, model: 'tiny' })
    ).rejects.toMatchObject({ code: 'bad_response' });
    expect(requests).toBe(1);
    const rebinding = createModelChecker({
      resolveHost: async () => [localPrivateAddress(), '169.254.169.254'],
    });
    await expect(
      rebinding({ kind: 'openai', baseUrl: 'https://model.test/v1', model: 'tiny' })
    ).rejects.toMatchObject({ code: 'blocked_destination' });
    expect(requests).toBe(1);
  });
  it('applies the whole-check deadline to stalled DNS resolution', async () => {
    const check = createModelChecker({
      timeoutMs: 25,
      resolveHost: async () => new Promise<string[]>(() => {}),
    });
    await expect(
      check({ kind: 'ollama', baseUrl: 'http://model.test/v1', model: 'tiny' })
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('shares one deadline across DNS and transport', async () => {
    const server = await listen((_req, res) => {
      setTimeout(() => res.end(validReply), 35);
    });
    const check = createModelChecker({
      timeoutMs: 60,
      resolveHost: async () => {
        await new Promise((resolve) => setTimeout(resolve, 35));
        return [localPrivateAddress()];
      },
    });
    const target = new URL(server.url);
    target.hostname = 'model.test';
    await expect(
      check({ kind: 'ollama', baseUrl: target.toString(), model: 'm' })
    ).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('does not start a request when DNS resolves after the check deadline', async () => {
    const request = vi.fn(async () => ({ status: 200, body: validReply }));
    const check = createModelChecker({
      timeoutMs: 20,
      resolveHost: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return [localPrivateAddress()];
      },
      request,
    });
    await expect(
      check({ kind: 'ollama', baseUrl: 'http://model.test/v1', model: 'm' })
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(request).not.toHaveBeenCalled();
  });

  it('bounds real local response time and response size', async () => {
    const slow = await listen((_req, _res) => {});
    // Keep this test fast while exercising the same checker deadline via a controllable timer is not possible;
    // the request is destroyed by the checker's 15-second hard bound.
    const exact = await listen((_req, res) => {
      const prefix = '{"choices":[],"padding":"';
      const suffix = '"}';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        prefix +
          'x'.repeat(64 * 1024 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) +
          suffix
      );
    });
    let oversizedClosed = false;
    let closed!: () => void;
    const oversizedClose = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const oversized = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.on('close', () => {
        oversizedClosed = true;
        closed();
      });
      res.write('{"choices":[],"padding":"' + 'x'.repeat(65 * 1024));
    });
    const bounded = createModelChecker();
    await expect(
      bounded({ kind: 'ollama', baseUrl: exact.url, model: 'tiny' })
    ).resolves.toBeUndefined();
    await expect(
      bounded({ kind: 'ollama', baseUrl: oversized.url, model: 'tiny' })
    ).rejects.toMatchObject({ code: 'bad_response' });
    await expect(oversizedClose).resolves.toBeUndefined();
    expect(oversizedClosed).toBe(true);
    // The slow listener is intentionally never completed; closeAllConnections prevents a dangling test handle.
    await expect(
      bounded({ kind: 'ollama', baseUrl: slow.url, model: 'tiny' })
    ).rejects.toMatchObject({ code: 'timeout' }, { timeout: 17000 });
  }, 35_000);
});

describe('complete model API bases', () => {
  it.each([
    ['https://models.example/v1', '/v1/'],
    ['https://models.example/v1/', '/v1/'],
    ['https://models.example/prefix/v1', '/prefix/v1/'],
    ['https://models.example', '/'],
    ['https://models.example/prefix/v1///', '/prefix/v1/'],
    ['https://models.example/prefix//v1/', '/prefix//v1/'],
    ['https://models.example/v1?x=1#frag', '/v1/'],
    ['https://models.example?x=1#frag', '/'],
  ])('preserves %s and normalizes its trailing slash', (base, prefix) => {
    for (const endpoint of ['chat/completions', 'models'] as const) {
      expect(modelEndpointUrl(base, endpoint).href).toBe(
        `https://models.example${prefix}${endpoint}`
      );
    }
  });
  it('sends the slot custom headers upstream with a probe session id', async () => {
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    const server = await listen((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(validReply);
    });
    const check = createModelChecker();
    await expect(
      check({
        kind: 'openai',
        baseUrl: server.url,
        model: 'm',
        headers: [
          { name: 'x-opencode-session', value: '{session}' },
          { name: 'x-static', value: 'static-value' },
        ],
      })
    ).resolves.toBeUndefined();
    expect(seen[0]?.['x-opencode-session']).toBe(CHECK_SESSION_ID);
    expect(seen[0]?.['x-static']).toBe('static-value');
  });
  it('sets its own host, content type, accept and authorization over the custom headers', async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    const server = await listen((req, res) => {
      seen = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(validReply);
    });
    const check = createModelChecker();
    await expect(
      check({
        kind: 'openai',
        baseUrl: server.url,
        model: 'm',
        key: 'the-key',
        headers: [
          { name: 'host', value: 'other.example' },
          { name: 'content-type', value: 'text/plain' },
          { name: 'accept', value: 'text/plain' },
          { name: 'authorization', value: 'Bearer override' },
          { name: 'x-ok', value: 'yes' },
        ],
      })
    ).resolves.toBeUndefined();
    expect(seen['content-type']).toBe('application/json');
    expect(seen['accept']).toBe('application/json');
    expect(seen['authorization']).toBe('Bearer the-key');
    expect(seen['x-ok']).toBe('yes');
    expect(JSON.stringify(seen['host'])).toContain(new URL(server.url).hostname);
  });
  it('hands an injected request the rendered custom headers and the fixed probe id', async () => {
    let received: Record<string, string> | undefined;
    const check = createModelChecker({
      resolveHost: async () => ['192.168.1.20'],
      request: async (_url, _address, _body, _key, headers) => {
        received = headers;
        return { status: 200, body: validReply };
      },
    });
    await expect(
      check({
        kind: 'openai',
        baseUrl: 'http://models.lan/v1',
        model: 'm',
        headers: [{ name: 'x-opencode-session', value: '{session}' }],
      })
    ).resolves.toBeUndefined();
    expect(received).toEqual({ 'x-opencode-session': CHECK_SESSION_ID });
  });
});
