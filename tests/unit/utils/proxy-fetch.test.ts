/**
 * The product's own outbound transport through the environment's proxy
 * (lifemodel-q4x.3.2 review finding 3).
 *
 * Node's own fetch tunnels EVERY target through CONNECT when the proxy
 * environment says so - including plain http ones, whose tunnel body is
 * plaintext, and Agent Vault's CONNECT handler expects TLS. The standard
 * forward-proxy path for an http target is instead an absolute-form request TO
 * the proxy, which curl uses and Agent Vault serves. These tests pin the
 * routing decision of src/utils/proxy-fetch.ts at real sockets: the http
 * target arrives at the upstream through an absolute-form request with the
 * proxy's own credential, a NO_PROXY target never touches the proxy, and the
 * https target stays with Node's own tunnelling fetch (the tunnel's MITM
 * certificate itself is proven against the real vault in the walk and in the
 * e2e proof of this finding).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, Server } from 'node:http';
import http from 'node:http';

import { proxyFetch } from '../../../src/utils/proxy-fetch.js';

interface SeenRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Start a recording HTTP server; it answers a fixed JSON body. */
async function startRecordingServer(): Promise<{
  server: Server;
  port: number;
  seen: SeenRequest[];
}> {
  const seen: SeenRequest[] = [];
  const server = http.createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { server, port: address.port, seen };
}

/** A forward proxy: absolute-form requests are relayed; CONNECTs are refused. */
async function startRecordingProxy(): Promise<{
  server: Server;
  port: number;
  seen: SeenRequest[];
  connects: string[];
}> {
  const seen: SeenRequest[] = [];
  const connects: string[] = [];
  const server = http.createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      });
      // A real proxy strips its own hop-by-hop credential before relaying
      // (the vault connects upstream itself, so nothing travels on).
      const relayed: Record<string, string | string[] | undefined> = { ...req.headers };
      delete relayed['proxy-authorization'];
      delete relayed['proxy-connection'];
      delete relayed['connection'];
      const upstream = http.request(
        req.url ?? '',
        { method: req.method, headers: relayed },
        (ur) => {
          res.writeHead(ur.statusCode ?? 502, ur.headers);
          ur.pipe(res);
        }
      );
      upstream.on('error', (error: Error) => {
        res.writeHead(502);
        res.end(`proxy could not relay: ${error.message}`);
      });
      chunks.length === 0 ? upstream.end() : upstream.end(Buffer.concat(chunks));
    });
  });
  server.on('connect', (req, socket) => {
    connects.push(req.url ?? '');
    socket.end('HTTP/1.1 405 no tunnels\r\n\r\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { server, port: address.port, seen, connects };
}

describe('proxyFetch (the product transport through the proxy)', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let stub: Awaited<ReturnType<typeof startRecordingServer>>;
  let proxy: Awaited<ReturnType<typeof startRecordingProxy>>;

  beforeAll(async () => {
    stub = await startRecordingServer();
    proxy = await startRecordingProxy();
    for (const name of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'http_proxy',
      'https_proxy',
      'NO_PROXY',
      'no_proxy',
      'NODE_USE_ENV_PROXY',
    ]) {
      savedEnv[name] = process.env[name];
    }
    process.env['NODE_USE_ENV_PROXY'] = '1';
  });

  afterAll(() => {
    stub.server.close();
    proxy.server.close();
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  afterEach(() => {
    proxy.seen.length = 0;
    proxy.connects.length = 0;
    stub.seen.length = 0;
    delete process.env['HTTP_PROXY'];
    delete process.env['http_proxy'];
    delete process.env['HTTPS_PROXY'];
    delete process.env['https_proxy'];
    delete process.env['NO_PROXY'];
    delete process.env['no_proxy'];
  });

  it('sends an http target through the proxy as an absolute-form request with the proxy credential', async () => {
    process.env['HTTP_PROXY'] = `http://agent-token:lifemodel@127.0.0.1:${String(proxy.port)}`;
    process.env['NO_PROXY'] = 'localhost,127.0.0.1';

    const response = await proxyFetch(`http://127.0.0.2:${String(stub.port)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer no-key-required' },
      body: JSON.stringify({ model: 'stub', messages: [] }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    // The proxy saw the absolute-form request line, with its own credential.
    expect(proxy.seen).toHaveLength(1);
    expect(proxy.seen[0].url).toBe(`http://127.0.0.2:${String(stub.port)}/v1/chat/completions`);
    expect(proxy.seen[0].headers['proxy-authorization']).toBe(
      `Basic ${Buffer.from('agent-token:lifemodel').toString('base64')}`
    );
    // The proxy never tunnelled a CONNECT: this is curl's path, not the TLS one.
    expect(proxy.connects).toHaveLength(0);
    // And the upstream got the request's body and headers - the proxy's
    // credential does NOT travel on.
    expect(stub.seen).toHaveLength(1);
    expect(stub.seen[0].body).toContain('stub');
    expect(stub.seen[0].headers['authorization']).toBe('Bearer no-key-required');
    expect(stub.seen[0].headers['proxy-authorization']).toBeUndefined();
  });

  it('never touches the proxy for a NO_PROXY target', async () => {
    process.env['HTTP_PROXY'] = `http://agent-token:lifemodel@127.0.0.1:${String(proxy.port)}`;
    process.env['NO_PROXY'] = 'localhost,127.0.0.1';

    const response = await proxyFetch(`http://127.0.0.1:${String(stub.port)}/v1/models`);
    expect(response.status).toBe(200);
    expect(proxy.seen).toHaveLength(0);
    expect(proxy.connects).toHaveLength(0);
    expect(stub.seen).toHaveLength(1);
    expect(stub.seen[0].url).toBe('/v1/models');
  });

  it('leaves an https target with the tunnelling fetch of Node itself', async () => {
    const direct = vi.spyOn(globalThis, 'fetch');
    process.env['HTTPS_PROXY'] = `http://agent-token:lifemodel@127.0.0.1:${String(proxy.port)}`;
    try {
      await expect(proxyFetch('https://example.invalid/v1/models')).rejects.toThrow();
      // The https branch delegates to Node's own fetch (whose tunnelling
      // CONNECT and NODE_EXTRA_CA_CERTS handling are proven against the real
      // vault in the e2e proof): it was called, and no forward-proxy request
      // was made to the http proxy listener.
      expect(direct).toHaveBeenCalled();
      expect(proxy.seen).toHaveLength(0);
    } finally {
      direct.mockRestore();
    }
  });

  it('goes direct when no proxy is in the environment', async () => {
    const direct = vi.spyOn(globalThis, 'fetch');
    try {
      const response = await proxyFetch(`http://127.0.0.2:${String(stub.port)}/v1/models`);
      expect(response.status).toBe(200);
      expect(direct).toHaveBeenCalled();
      expect(proxy.seen).toHaveLength(0);
    } finally {
      direct.mockRestore();
    }
  });

  it('follows a redirect through the proxy with the GET the status asks for', async () => {
    process.env['HTTP_PROXY'] = `http://agent-token:lifemodel@127.0.0.1:${String(proxy.port)}`;
    process.env['NO_PROXY'] = 'localhost,127.0.0.1';

    // A stub hop that redirects once, then answers.
    const hop: SeenRequest[] = [];
    const redirectServer = http.createServer((req, res) => {
      if (req.url === '/moved') {
        res.writeHead(302, { location: '/settled' });
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        hop.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: '' });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"settled":true}');
      });
    });
    await new Promise<void>((resolve) => redirectServer.listen(0, '0.0.0.0', resolve));
    const redirectPort = (redirectServer.address() as { port: number }).port;
    try {
      const response = await proxyFetch(`http://127.0.0.2:${String(redirectPort)}/moved`);
      expect(await response.json()).toEqual({ settled: true });
      expect(hop).toEqual([expect.objectContaining({ method: 'GET', url: '/settled' })]);
    } finally {
      redirectServer.close();
    }
  });

  it('aborts a proxied request the caller aborted, instead of hanging', async () => {
    process.env['HTTP_PROXY'] = `http://agent-token:lifemodel@127.0.0.1:${String(proxy.port)}`;
    process.env['NO_PROXY'] = 'localhost,127.0.0.1';

    // An upstream that never answers.
    const slow = http.createServer(() => {
      /* no response */
    });
    await new Promise<void>((resolve) => slow.listen(0, '0.0.0.0', resolve));
    const slowPort = (slow.address() as { port: number }).port;
    try {
      const controller = new AbortController();
      const request = proxyFetch(`http://127.0.0.2:${String(slowPort)}/v1/chat/completions`, {
        method: 'POST',
        body: '{}',
        signal: controller.signal,
      });
      const after = new Promise<unknown>((resolve) => {
        controller.abort();
        request.catch(resolve);
      });
      // A bounded wait: the abort must come back, not hang the test.
      const outcome = await Promise.race([
        after,
        new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 5_000)),
      ]);
      expect(outcome).not.toBe('hung');
    } finally {
      slow.close();
    }
  });
});
