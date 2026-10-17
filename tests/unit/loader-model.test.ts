import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import { createModelChecker, ModelCheckError } from '../../loader/src/model.js';
import { modelEndpointUrl } from '../../loader/src/model-url.js';

const servers: Server[] = [];
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
  it('keeps a complete API base prefix when building the chat check URL', () => {
    expect(modelEndpointUrl('https://models.example/prefix/v1').pathname).toBe(
      '/prefix/v1/chat/completions'
    );
  });
  it('accepts the named in-cluster Ollama service after validating its resolved service address', async () => {
    let target: URL | undefined;
    const check = createModelChecker({
      resolveHost: async () => ['10.43.3.4'],
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
  it('refuses public plaintext and mapped IPv6 destinations before connecting', async () => {
    const check = createModelChecker({ resolveHost: async () => ['::ffff:10.0.0.1'] });
    await expect(
      check({ kind: 'ollama', baseUrl: 'http://example.com/v1', model: 'm' })
    ).rejects.toMatchObject({ code: 'blocked_destination' });
    await expect(
      check({ kind: 'openai', baseUrl: 'https://[::ffff:10.0.0.1]/v1', model: 'm' })
    ).rejects.toBeInstanceOf(ModelCheckError);
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
  it('bounds real local response time and response size', async () => {
    const slow = await listen((_req, _res) => {});
    // Keep this test fast while exercising the same checker deadline via a controllable timer is not possible;
    // the request is destroyed by the checker's 15-second hard bound.
    const oversized = await listen((_req, res) => {
      res.writeHead(200);
      res.end('x'.repeat(65 * 1024));
    });
    const bounded = createModelChecker();
    await expect(
      bounded({ kind: 'ollama', baseUrl: oversized.url, model: 'tiny' })
    ).rejects.toMatchObject({ code: 'bad_response' });
    // The slow listener is intentionally never completed; closeAllConnections prevents a dangling test handle.
    await expect(
      bounded({ kind: 'ollama', baseUrl: slow.url, model: 'tiny' })
    ).rejects.toMatchObject({ code: 'timeout' }, { timeout: 17000 });
  }, 20_000);
});
