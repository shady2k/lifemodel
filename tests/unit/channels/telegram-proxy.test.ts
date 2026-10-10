/**
 * The proxy transport under grammY's real client (lifemodel-q4x.3.2 review
 * finding 4).
 *
 * The channel's wiring of the transport is pinned in
 * telegram-proxy-wiring.test.ts; this file drives the REAL grammY client —
 * the one the channel runs, with its timeouts, signals and JSON handling —
 * against a Telegram-shaped recording stub over real sockets, with a
 * recording forward proxy in between. No real Telegram, no real token
 * (decision 16): the token is the vault's placeholder, and the e2e proof of
 * this finding shows the vault substituting it in the path.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Bot } from 'grammy';
import type { Server } from 'node:http';
import http from 'node:http';

import { proxyFetch } from '../../../src/utils/proxy-fetch.js';

interface SeenRequest {
  method: string;
  url: string;
  body: string;
}

/** The Telegram-shaped answer every method gets: ok, with a fitting result. */
function telegramAnswer(res: http.ServerResponse, url: string): void {
  const method = /\/bot[^/]+\/(\w+)/.exec(url)?.[1] ?? '';
  const result =
    method === 'getUpdates'
      ? []
      : method === 'sendMessage'
        ? { message_id: 4242, chat: { id: 1 }, text: 'echo' }
        : { id: 7, is_bot: true, first_name: 'stub', username: 'q4xstub_bot' };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, result }));
}

async function startRecordingServer(): Promise<{
  server: Server;
  port: number;
  seen: SeenRequest[];
}> {
  const seen: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = req.url ?? '';
      seen.push({ method: req.method ?? '', url, body: Buffer.concat(chunks).toString('utf-8') });
      telegramAnswer(res, url);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { server, port: address.port, seen };
}

/** A forward proxy that relays absolute-form requests and records them. */
async function startRecordingProxy(): Promise<{
  server: Server;
  port: number;
  seen: SeenRequest[];
}> {
  const seen: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf-8'),
      });
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { server, port: address.port, seen };
}

describe('grammY through the proxy transport (finding 4)', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let stub: Awaited<ReturnType<typeof startRecordingServer>>;
  let proxy: Awaited<ReturnType<typeof startRecordingProxy>>;

  beforeAll(async () => {
    stub = await startRecordingServer();
    proxy = await startRecordingProxy();
    for (const name of ['HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'NODE_USE_ENV_PROXY']) {
      savedEnv[name] = process.env[name];
    }
    process.env['HTTP_PROXY'] = `http://agent-token:lifemodel@127.0.0.1:${String(proxy.port)}`;
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
    stub.seen.length = 0;
    proxy.seen.length = 0;
  });

  /** Wait, bounded, for a request a recording list shows. */
  async function waitForRecord(
    list: SeenRequest[],
    urlPart: string,
    timeoutMs = 10_000
  ): Promise<SeenRequest> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = list.find((record) => record.url.includes(urlPart));
      if (found !== undefined) return found;
      if (Date.now() > deadline) {
        throw new Error(`no request with ${urlPart} arrived; saw ${JSON.stringify(list)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** The Bot the channel builds: the placeholder token, the shared transport. */
  function channelBot(): Bot {
    return new Bot('__bot_token__', {
      client: { fetch: proxyFetch, apiRoot: `http://127.0.0.2:${String(stub.port)}` },
    });
  }

  it('initializes through the proxy: getMe leaves as a forward-proxy request', async () => {
    const bot = channelBot();
    const me = await bot.api.getMe();
    expect(me.is_bot).toBe(true);
    const throughProxy = await waitForRecord(proxy.seen, '/getMe');
    expect(throughProxy.url).toContain('/bot__bot_token__/getMe');
    expect(throughProxy.method).toBe('POST');
    // Nothing dialled the stub directly: the proxy is in the path of every
    // request the stub recorded.
    expect(stub.seen.length).toBe(proxy.seen.length);
  });

  it('sends through the proxy: sendMessage arrives with its payload', async () => {
    const bot = channelBot();
    const sent = await bot.api.sendMessage(1, 'hello through the proxy');
    expect(sent.message_id).toBe(4242);
    const throughProxy = await waitForRecord(proxy.seen, '/sendMessage');
    expect(throughProxy.url).toContain('/bot__bot_token__/sendMessage');
    expect(throughProxy.body).toContain('hello through the proxy');
  });

  it('polls through the proxy: getUpdates arrives while the bot runs', async () => {
    const bot = channelBot();
    const stopped = bot.start();
    try {
      const throughProxy = await waitForRecord(proxy.seen, 'getUpdates', 15_000);
      expect(throughProxy.url).toContain('/bot__bot_token__/getUpdates');
    } finally {
      await bot.stop();
      await stopped.catch(() => undefined);
    }
  }, 30_000);
});
