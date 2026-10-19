import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { createModelGateway, GATEWAY_LIMITS } from '../../loader/src/model-gateway-app.js';
import { connect } from 'node:net';
import { createRoleBaoClient, createCachedSlotReader } from '../../loader/src/model-bao.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';
import type { ModelSlot, ModelSlotName } from '../../loader/src/model.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
function privateAddress() {
  const address = Object.values(networkInterfaces())
    .flatMap((a) => a ?? [])
    .find(
      (a) =>
        a.family === 'IPv4' &&
        !a.internal &&
        /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(a.address)
    );
  if (!address) throw new Error('no private test address');
  return address.address;
}
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('not listening');
  return `http://${privateAddress()}:${address.port}`;
}
const answer = (model = 'upstream-model', content: string | null = 'OK') => ({
  id: 'chat-1',
  object: 'chat.completion',
  model,
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
});
type Handler = (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void;
async function fixture(
  options?: Parameters<typeof createModelGateway>[0]['timeouts'],
  timers?: Parameters<typeof createModelGateway>[0]['timers'],
  recheck?: Parameters<typeof createModelGateway>[0]['recheck']
) {
  const attempts: Array<{
    slot: ModelSlotName;
    body: Record<string, unknown>;
    headers: IncomingMessage['headers'];
    path: string;
  }> = [];
  const handlers: Record<ModelSlotName, Handler> = {
    primary: (_req, res) => res.end(JSON.stringify(answer())),
    reserve: (_req, res) => res.end(JSON.stringify(answer('reserve-real'))),
  };
  const slots: Record<ModelSlotName, ModelSlot | null> = { primary: null, reserve: null };
  for (const name of ['primary', 'reserve'] as const) {
    const url = await listen(
      createServer(async (req, res) => {
        let text = '';
        for await (const chunk of req) text += String(chunk);
        const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        attempts.push({ slot: name, body, headers: req.headers, path: req.url ?? '' });
        handlers[name](req, res, body);
      })
    );
    slots[name] = {
      kind: 'openai',
      baseUrl: `${url}/prefix/v1/`,
      model: `${name}-model`,
      key: `${name}-SUPER-SECRET`,
    };
  }
  let baoStatus = 200;
  let holdReads = false;
  let interceptRead: ((name: ModelSlotName, reply: () => void) => boolean) | undefined;
  const baoStatuses: Partial<Record<ModelSlotName, number>> = {};
  const versions: Record<ModelSlotName, number> = { primary: 1, reserve: 1 };
  const reads: string[] = [];
  const logins: unknown[] = [];
  const bao = await listen(
    createServer(async (req, res) => {
      if (req.url === '/v1/auth/kubernetes/login') {
        let body = '';
        for await (const chunk of req) body += String(chunk);
        logins.push(JSON.parse(body));
        res.end(
          JSON.stringify({
            auth: { client_token: 'bao-token', lease_duration: 300, renewable: false },
          })
        );
        return;
      }
      reads.push(req.url ?? '');
      // A held read answers nothing: the re-check's own bound must end the wait.
      if (holdReads) return;
      const name: ModelSlotName = req.url?.endsWith('/reserve') ? 'reserve' : 'primary';
      const slot = slots[name];
      const status = baoStatuses[name] ?? baoStatus;
      const body =
        status === 200
          ? JSON.stringify({ data: { data: slot, metadata: { version: versions[name] } } })
          : 'PRIVATE BAO BODY';
      const reply = () => {
        res.writeHead(status === 200 && !slot ? 404 : status);
        res.end(body);
      };
      if (!interceptRead?.(name, reply)) reply();
    })
  );
  const lines: RecordedLine[] = [];
  const logger = createRecordingLogger(lines);
  const client = createRoleBaoClient({
    address: bao,
    role: 'model-gateway',
    readJwt: async () => 'projected-jwt',
    logger,
  });
  const cache = createCachedSlotReader(client.readSlot);
  const app = createModelGateway({
    slots: cache,
    logger,
    ...(options ? { timeouts: options } : {}),
    ...(timers ? { timers } : {}),
    ...(recheck ? { recheck } : {}),
  });
  const url = await listen(app.api);
  const statusUrl = await listen(app.status);
  const post = (
    payload: unknown = { model: 'default', messages: [{ role: 'user', content: 'Hi' }] },
    extra: Record<string, string> = {}
  ) =>
    fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer INBOUND-PRIVATE',
        cookie: 'PRIVATE-COOKIE',
        'x-forwarded-for': 'PRIVATE-FORWARDED',
        ...extra,
      },
      body: JSON.stringify(payload),
    });
  return {
    app,
    url,
    statusUrl,
    post,
    slots,
    handlers,
    attempts,
    reads,
    logins,
    lines,
    cache,
    versions,
    baoStatuses,
    set interceptRead(value: typeof interceptRead) {
      interceptRead = value;
    },
    set baoStatus(value: number) {
      baoStatus = value;
    },
    set holdReads(value: boolean) {
      holdReads = value;
    },
  };
}

describe('model gateway buffered HTTP contract', () => {
  it('injects only the Bao key, maps default, preserves the base prefix and allows only return headers', async () => {
    const f = await fixture();
    f.handlers.primary = (_req, res) => {
      res.writeHead(200, {
        'x-secret': 'primary-SUPER-SECRET',
        'set-cookie': 'PRIVATE',
        'content-type': 'application/json',
        'retry-after': '12',
      });
      res.end(JSON.stringify(answer()));
    };
    const response = await f.post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(answer());
    expect(response.headers.get('x-lifemodel-slot')).toBe('primary');
    expect(response.headers.get('x-secret')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('retry-after')).toBe('12');
    expect(f.attempts).toHaveLength(1);
    expect(f.attempts[0]).toMatchObject({
      path: '/prefix/v1/chat/completions',
      body: { model: 'primary-model' },
    });
    expect(f.attempts[0]?.headers.authorization).toBe('Bearer primary-SUPER-SECRET');
    for (const name of ['cookie', 'x-forwarded-for'])
      expect(f.attempts[0]?.headers[name]).toBeUndefined();
    expect(f.logins).toEqual([{ role: 'model-gateway', jwt: 'projected-jwt' }]);
    expect(JSON.stringify(f.lines)).not.toContain('SECRET');
  });
  it.each([500, 503, 429, 'malformed', 'connection'] as const)(
    'fails over exactly once on %s, replacing an explicit role model on reserve',
    async (failure) => {
      const f = await fixture();
      f.handlers.primary = (req, res) => {
        if (failure === 'connection') {
          req.socket.destroy();
          return;
        }
        res.writeHead(typeof failure === 'number' ? failure : 200);
        res.end(failure === 'malformed' ? '{"unexpected":true}' : 'Bearer primary-SUPER-SECRET');
      };
      const response = await f.post({ model: 'owner-fast', messages: [] });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-lifemodel-slot')).toBe('reserve');
      expect(await response.json()).toEqual(answer('reserve-real'));
      expect(f.attempts.map((a) => [a.slot, a.body.model])).toEqual([
        ['primary', 'owner-fast'],
        ['reserve', 'reserve-model'],
      ]);
    }
  );
  it.each([400, 401, 403, 404, 422])(
    'returns owned errors for %s without reserve or secret headers',
    async (status) => {
      const f = await fixture();
      f.handlers.primary = (req, res) => {
        res.writeHead(status, {
          'x-secret': req.headers.authorization ?? '',
          'retry-after': 'primary-SUPER-SECRET',
        });
        res.end(req.headers.authorization);
      };
      const response = await f.post();
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: { type: 'gateway_error', code: `upstream_${status}` },
      });
      expect(response.headers.get('x-secret')).toBeNull();
      expect(response.headers.get('retry-after')).toBeNull();
      expect(f.attempts).toHaveLength(1);
      expect(JSON.stringify(f.lines)).not.toContain('SECRET');
    }
  );
  it('invalidates a 401 credential for the next request only', async () => {
    const f = await fixture();
    f.handlers.primary = (_req, res) => {
      f.slots.primary = { ...f.slots.primary!, key: 'rotated-key' };
      res.writeHead(401);
      res.end('primary-SUPER-SECRET');
    };
    expect((await f.post()).status).toBe(401);
    expect(f.attempts).toHaveLength(1);
    f.handlers.primary = (_req, res) => res.end(JSON.stringify(answer()));
    expect((await f.post()).status).toBe(200);
    expect(f.attempts.map((a) => a.headers.authorization)).toEqual([
      'Bearer primary-SUPER-SECRET',
      'Bearer rotated-key',
    ]);
    expect(f.reads.filter((p) => p.endsWith('/primary'))).toHaveLength(2);
  });
  it.each(['plain', 'escaped'])(
    'blocks an upstream key in %s success JSON on either slot',
    async (encoding) => {
      const f = await fixture();
      for (const name of ['primary', 'reserve'] as const)
        f.handlers[name] = (_req, res) => {
          const text = JSON.stringify(answer('real', `${name}-SUPER-SECRET`));
          res.end(encoding === 'plain' ? text : text.replaceAll('S', '\\u0053'));
        };
      const response = await f.post();
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain('SECRET');
      expect(f.attempts.map((a) => a.slot)).toEqual(['primary', 'reserve']);
      expect(JSON.stringify(f.lines)).not.toContain('SECRET');
    }
  );
  it('returns safe 502 with no reserve and never follows redirects', async () => {
    const f = await fixture();
    f.slots.reserve = null;
    f.handlers.primary = (_req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1/private' });
      res.end('private');
    };
    const response = await f.post();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { type: 'gateway_error', code: 'bad_response' },
    });
    expect(f.attempts).toHaveLength(1);
  });
  it('accepts null content with tool calls and a keyless endpoint', async () => {
    const f = await fixture();
    delete f.slots.primary!.key;
    const reply = answer('tools', null);
    Object.assign(reply.choices[0]!.message, {
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'tool', arguments: '{}' } }],
    });
    f.handlers.primary = (_req, res) => res.end(JSON.stringify(reply));
    const response = await f.post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(reply);
    expect(f.attempts[0]?.headers.authorization).toBeUndefined();
  });
  it('exposes only declared routes on each listener and passes model listings', async () => {
    const f = await fixture();
    f.handlers.primary = (_req, res) =>
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'real', object: 'model' }] }));
    const models = await fetch(`${f.url}/v1/models`);
    expect(models.status).toBe(200);
    expect((await models.json()).data[0].id).toBe('real');
    expect(f.attempts[0]?.path).toBe('/prefix/v1/models');
    for (const [base, path, method] of [
      [f.url, '/status', 'GET'],
      [f.statusUrl, '/v1/models', 'GET'],
      [f.url, '/v1/chat/completions', 'GET'],
      [f.statusUrl, '/status', 'POST'],
      [f.url, '/v1/models?x=1', 'GET'],
    ] as const)
      expect((await fetch(base + path, { method })).status).toBe(404);
  });
  it('tracks unknown, reserve success, repeated whole-request failures, and recovery', async () => {
    const f = await fixture();
    const status = async () => (await fetch(`${f.statusUrl}/status`)).json();
    expect(await status()).toMatchObject({
      state: 'unknown',
      outageSince: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
    });
    f.handlers.primary = (_req, res) => {
      res.writeHead(500);
      res.end('PRIVATE');
    };
    await f.post();
    expect(await status()).toMatchObject({
      state: 'ok',
      outageSince: null,
      lastErrorCode: null,
      primary: { lastErrorCode: 'upstream_500' },
    });
    f.handlers.reserve = f.handlers.primary;
    await f.post();
    const down = await status();
    expect(down.state).toBe('down');
    expect(down.outageSince).not.toBeNull();
    await f.post();
    expect((await status()).outageSince).toBe(down.outageSince);
    f.handlers.primary = (_req, res) => res.end(JSON.stringify(answer()));
    await f.post();
    expect(await status()).toMatchObject({ state: 'ok', outageSince: null, lastErrorCode: null });
  });
  it('fails closed on unavailable storage and unset primary without an upstream request', async () => {
    const f = await fixture();
    f.baoStatus = 503;
    let response = await f.post();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { type: 'gateway_error', code: 'storage_unavailable' },
    });
    expect(f.attempts).toHaveLength(0);
    f.baoStatus = 200;
    f.slots.primary = null;
    response = await f.post();
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('not_configured');
  });
});

function event(content: string, field = 'content', choice = 0, tool = 0): string {
  const delta =
    field === 'arguments'
      ? {
          tool_calls: [
            {
              index: tool,
              id: `call-${tool}`,
              type: 'function',
              function: { name: 'tool', arguments: content },
            },
          ],
        }
      : { [field]: content };
  return `data: ${JSON.stringify({ id: 'stream-1', model: 'stream-real', choices: [{ index: choice, delta }] })}\n\n`;
}
const streamPayload = { model: 'default', messages: [], stream: true };
function endStream(indices = [0]): string {
  return `data: ${JSON.stringify({ model: 'stream-real', choices: indices.map((index) => ({ index, delta: {}, finish_reason: 'stop' })) })}\n\ndata: [DONE]\n\n`;
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('model gateway event stream boundary', () => {
  it('passes streamed deltas and tool metadata through without buffering a complete response', async () => {
    const f = await fixture();
    const finish = latch();
    f.handlers.primary = (_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-secret': 'primary-SUPER-SECRET',
      });
      res.write(event('hello '));
      void finish.promise.then(() => res.end(event('{}', 'arguments') + endStream()));
    };
    const response = await f.post(streamPayload);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-secret')).toBeNull();
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('hello ');
    finish.resolve();
    let tail = '';
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      tail += new TextDecoder().decode(next.value);
    }
    expect(tail).toContain('tool_calls');
    expect(tail).toContain('[DONE]');
    expect(f.attempts).toHaveLength(1);
  });
  it.each(['content', 'arguments', 'reasoning', 'reasoning_content'])(
    'withholds a key prefix split across two %s deltas, without replay after downstream output',
    async (field) => {
      const f = await fixture();
      const finish = latch();
      const closed = latch();
      f.handlers.primary = (_req, res) => {
        res.on('close', closed.resolve);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(event('safe initial'));
        void finish.promise.then(() => {
          res.write(event('primary-SUPER-', field));
          res.end(event('SECRET', field) + endStream());
        });
      };
      const response = await f.post(streamPayload);
      const reader = response.body!.getReader();
      const initial = await reader.read();
      expect(new TextDecoder().decode(initial.value)).toContain('safe initial');
      finish.resolve();
      let returned = '';
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        returned += new TextDecoder().decode(part.value);
      }
      expect(returned).toContain('unsafe_response');
      expect(returned).not.toContain('primary-SUPER-');
      expect(returned).not.toContain('SECRET');
      expect(f.attempts.map((a) => a.slot)).toEqual(['primary']);
      await closed.promise;
      expect(JSON.stringify(f.lines)).not.toContain('SECRET');
    }
  );
  it.each(['plain', 'escaped'])(
    'refuses a %s secret frame split across HTTP chunks before downstream output, including reserve',
    async (encoding) => {
      const f = await fixture();
      for (const name of ['primary', 'reserve'] as const)
        f.handlers[name] = (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          let frame = event(`${name}-SUPER-SECRET`);
          if (encoding === 'escaped') frame = frame.replaceAll('S', '\\u0053');
          res.write(frame.slice(0, 50));
          setImmediate(() => res.end(frame.slice(50) + endStream()));
        };
      const response = await f.post(streamPayload);
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain('SECRET');
      expect(f.attempts.map((a) => a.slot)).toEqual(['primary', 'reserve']);
      expect(JSON.stringify(f.lines)).not.toContain('SECRET');
    }
  );
  it('keeps choice and tool-call fields separate and releases a harmless final prefix', async () => {
    const f = await fixture();
    f.handlers.primary = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        event('primary-SUPER-', 'arguments', 0, 0) +
          event('SECRET', 'arguments', 0, 1) +
          event('SECRET', 'content', 1) +
          endStream([0, 1])
      );
    };
    const response = await f.post(streamPayload);
    const text = await response.text();
    expect(text).toContain('primary-SUPER-');
    expect(text).toContain('[DONE]');
    expect(text).not.toContain('unsafe_response');
    expect(f.attempts).toHaveLength(1);
  });
  it('aborts an upstream stream when the client disconnects, with no reserve attempt', async () => {
    const f = await fixture();
    const closed = latch();
    f.handlers.primary = (_req, res) => {
      res.on('close', closed.resolve);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(event('visible'));
    };
    const controller = new AbortController();
    const response = await fetch(`${f.url}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify(streamPayload),
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('visible');
    controller.abort();
    await closed.promise;
    expect(f.attempts.map((a) => a.slot)).toEqual(['primary']);
  });
  it.each(['malformed', 'truncated', 'oversized'])(
    'never switches after first downstream byte on %s streaming input',
    async (failure) => {
      const f = await fixture();
      const finish = latch();
      f.handlers.primary = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(event('visible'));
        void finish.promise.then(() =>
          res.end(
            failure === 'malformed'
              ? 'data: not-json\n\n'
              : failure === 'oversized'
                ? 'x'.repeat(1024 * 1024 + 1)
                : 'data: {'
          )
        );
      };
      const response = await f.post(streamPayload);
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('visible');
      finish.resolve();
      let text = '';
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        text += new TextDecoder().decode(part.value);
      }
      expect(text).toContain('bad_response');
      expect(f.attempts).toHaveLength(1);
    }
  );
  it('switches on a malformed first event before any downstream bytes', async () => {
    const f = await fixture();
    f.handlers.primary = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: garbage\n\n');
    };
    f.handlers.reserve = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(event('reserve good') + endStream());
    };
    const response = await f.post(streamPayload);
    expect(response.headers.get('x-lifemodel-slot')).toBe('reserve');
    expect(await response.text()).toContain('reserve good');
    expect(f.attempts).toHaveLength(2);
  });
  it('decodes UTF-8 and CRLF across network boundaries', async () => {
    const f = await fixture();
    f.handlers.primary = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const bytes = Buffer.from((event('Привет') + endStream()).replaceAll('\n', '\r\n'));
      const split = bytes.indexOf(Buffer.from('П')) + 1;
      res.write(bytes.subarray(0, split));
      setImmediate(() => res.end(bytes.subarray(split)));
    };
    const response = await f.post(streamPayload);
    expect(await response.text()).toContain('Привет');
  });
});

describe('model gateway deadlines and bounds', () => {
  it('switches on the first-byte timeout and aborts the old request', async () => {
    const f = await fixture({ firstByte: 35 });
    const closed = latch();
    f.handlers.primary = (_req, res) => {
      res.on('close', closed.resolve);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
    };
    const response = await f.post();
    expect(response.status).toBe(200);
    expect(response.headers.get('x-lifemodel-slot')).toBe('reserve');
    await closed.promise;
    expect(f.attempts).toHaveLength(2);
  });
  it('ends an idle stream without reserve replay', async () => {
    const f = await fixture({ idle: 35 });
    const closed = latch();
    f.handlers.primary = (_req, res) => {
      res.on('close', closed.resolve);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(event('visible'));
    };
    const response = await f.post(streamPayload);
    const text = await response.text();
    expect(text).toContain('visible');
    expect(text).toContain('timeout');
    await closed.promise;
    expect(f.attempts).toHaveLength(1);
  });
  it('shares the overall deadline across primary and reserve, aborting the final request', async () => {
    const f = await fixture({ firstByte: 80, overall: 120 });
    const primaryClosed = latch();
    const reserveClosed = latch();
    f.handlers.primary = (_req, res) => {
      res.on('close', primaryClosed.resolve);
    };
    f.handlers.reserve = (_req, res) => {
      res.on('close', reserveClosed.resolve);
    };
    const response = await f.post();
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('timeout');
    await Promise.all([primaryClosed.promise, reserveClosed.promise]);
    expect(f.attempts.map((a) => a.slot)).toEqual(['primary', 'reserve']);
  });
  it('aborts a buffered request on disconnect before its first upstream byte', async () => {
    const f = await fixture();
    const entered = latch();
    const closed = latch();
    f.handlers.primary = (_req, res) => {
      res.on('close', closed.resolve);
      entered.resolve();
    };
    const controller = new AbortController();
    const pending = fetch(`${f.url}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'default', messages: [] }),
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await entered.promise;
    controller.abort();
    await pending;
    await closed.promise;
    expect(f.attempts).toHaveLength(1);
  });
  it('bounds buffered success and inbound bodies', async () => {
    const f = await fixture();
    f.handlers.primary = (_req, res) =>
      res.end(JSON.stringify(answer('m', 'x'.repeat(1024 * 1024))));
    const response = await f.post();
    expect(response.headers.get('x-lifemodel-slot')).toBe('reserve');
    const oversized = await f.post({
      model: 'default',
      messages: [{ content: 'x'.repeat(1024 * 1024) }],
    });
    expect(oversized.status).toBe(413);
    expect(f.attempts).toHaveLength(2);
  });
  it('does not start an upstream for invalid requests', async () => {
    const f = await fixture();
    for (const body of [{ messages: [] }, { model: '', messages: [] }, { model: 'default' }, null])
      expect((await f.post(body)).status).toBe(400);
    expect(f.attempts).toHaveLength(0);
  });
});

describe('model gateway adversarial stream paths', () => {
  it('cannot reset a tool argument key prefix through an aliased arbitrary field', async () => {
    const f = await fixture();
    f.slots.primary!.key = 'sk-secret';
    f.slots.reserve = null;
    f.handlers.primary = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        event('sk-', 'arguments') +
          event('X', 'tool_calls:0:function:arguments') +
          event('secret', 'arguments') +
          endStream()
      );
    };
    const response = await f.post(streamPayload);
    const text = await response.text();
    const args = text
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)))
      .flatMap((frame) => frame.choices ?? [])
      .flatMap((choice) => choice.delta?.tool_calls ?? [])
      .map((call) => call.function?.arguments ?? '')
      .join('');
    expect(args).not.toContain('sk-secret');
    expect(text).not.toContain('[DONE]');
  });
});

describe('model gateway configuration and storage boundaries', () => {
  it.each(['/v1', '/v1/', '/prefix/v1'])(
    'joins the complete API base %s for both endpoints',
    async (prefix) => {
      const f = await fixture();
      const target = new URL(f.slots.primary!.baseUrl);
      target.pathname = prefix;
      f.slots.primary!.baseUrl = target.toString();
      expect((await f.post()).status).toBe(200);
      f.handlers.primary = (_req, res) => res.end('{"data":[]}');
      expect((await fetch(`${f.url}/v1/models`)).status).toBe(200);
      expect(f.attempts.map((a) => a.path)).toEqual([
        `${prefix.replace(/\/$/, '')}/chat/completions`,
        `${prefix.replace(/\/$/, '')}/models`,
      ]);
    }
  );
  it('validates the slot destination before sending credentials', async () => {
    const f = await fixture();
    f.slots.primary!.baseUrl = 'http://127.0.0.1:1/v1';
    f.slots.reserve = null;
    const response = await f.post();
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('blocked_destination');
    expect(f.attempts).toHaveLength(0);
  });
  it.each(['echo', 'escaped'])('guards model listings against an %s key', async (encoding) => {
    const f = await fixture();
    f.slots.reserve = null;
    f.handlers.primary = (_req, res) => {
      let text = JSON.stringify({ data: [{ id: 'real', owned_by: 'primary-SUPER-SECRET' }] });
      if (encoding === 'escaped') text = text.replaceAll('S', '\\u0053');
      res.end(text);
    };
    const response = await fetch(`${f.url}/v1/models`);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('SECRET');
  });
});

describe('model gateway protocol validation', () => {
  it.each([
    { model: 'm', choices: [{ message: { content: null, tool_calls: [123] } }] },
    { model: 'm', choices: [{ message: { content: 'OK', tool_calls: [123] } }] },
    { model: 'm', choices: [{ message: { content: null } }] },
  ])('fails over on malformed completion message %j', async (reply) => {
    const f = await fixture();
    f.handlers.primary = (_req, res) => res.end(JSON.stringify(reply));
    const response = await f.post();
    expect(response.headers.get('x-lifemodel-slot')).toBe('reserve');
    expect(f.attempts).toHaveLength(2);
  });
  it.each([
    'data: [DONE]\n\n',
    'data: {"choices":[]}\n\ndata: [DONE]\n\n',
    'data: {"choices":[{"index":0,"delta":{"nonsense":true}}]}\n\ndata: [DONE]\n\n',
  ])('fails over on an invalid initial SSE completion %s', async (text) => {
    const f = await fixture();
    f.handlers.primary = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(text);
    };
    f.handlers.reserve = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(event('reserve') + endStream());
    };
    const response = await f.post(streamPayload);
    expect(response.headers.get('x-lifemodel-slot')).toBe('reserve');
    expect(await response.text()).toContain('reserve');
  });
  it('refuses malformed UTF-8 instead of replacing it in success JSON', async () => {
    const f = await fixture();
    f.handlers.primary = (_req, res) => {
      const [before, after] = JSON.stringify(answer()).split('OK');
      res.end(Buffer.concat([Buffer.from(before!), Buffer.from([0xff]), Buffer.from(after!)]));
    };
    const response = await f.post();
    expect(response.headers.get('x-lifemodel-slot')).toBe('reserve');
  });
});

describe('model gateway strict streaming transport', () => {
  it('does not withhold static role metadata that happens to end in a key prefix', async () => {
    const f = await fixture({ firstByte: 100, idle: 100 });
    const finish = latch();
    f.slots.primary!.key = 't-secret';
    f.handlers.primary = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const role = {
        model: 'm',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' } }],
      };
      res.write(`data: ${JSON.stringify(role)}\n\n` + event('hello'));
      void finish.promise.then(() => res.end(endStream()));
    };
    const response = await f.post(streamPayload);
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('hello');
    expect(first).not.toContain('timeout');
    finish.resolve();
    await reader.cancel();
  });
  it('accepts CR-only SSE frames and split CRLF sequences', async () => {
    const f = await fixture();
    f.handlers.primary = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const frame = event('hello').replaceAll('\n', '\r');
      res.write(frame);
      res.end(endStream().replaceAll('\n', '\r'));
    };
    const response = await f.post(streamPayload);
    expect(await response.text()).toContain('[DONE]');
    expect(f.attempts).toHaveLength(1);
  });
  it('accepts a final usage-only event after a valid completion', async () => {
    const f = await fixture();
    f.handlers.primary = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        event('hello') +
          endStream().replace(
            'data: [DONE]',
            'data: {"model":"m","choices":[],"usage":{"total_tokens":2}}\n\ndata: [DONE]'
          )
      );
    };
    const response = await f.post(streamPayload);
    const text = await response.text();
    expect(text).toContain('total_tokens');
    expect(text).toContain('[DONE]');
  });
});

describe('model gateway terminal stream validation', () => {
  it.each(['tools', 'role'])(
    'ends an incomplete %s stream with a safe error and down status',
    async (kind) => {
      const f = await fixture();
      f.handlers.primary = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const delta =
          kind === 'tools'
            ? { tool_calls: [{ index: 0, function: { arguments: '{}' } }] }
            : { role: 'assistant' };
        res.end(
          `data: ${JSON.stringify({ model: 'm', choices: [{ index: 0, delta }] })}\n\ndata: [DONE]\n\n`
        );
      };
      const response = await f.post(streamPayload);
      const text = await response.text();
      expect(text).toContain('bad_response');
      expect(text).not.toContain('[DONE]');
      expect(f.attempts).toHaveLength(1);
      expect(await (await fetch(`${f.statusUrl}/status`)).json()).toMatchObject({ state: 'down' });
    }
  );
});

describe('model gateway review regressions', () => {
  it.each([
    ['completion', '12345', '1.2345e4'],
    ['models', '12345', '1.2345e4'],
    ['stream', '12345', '1.2345e4'],
    ['completion', '12346', '12345.9999999999999'],
    ['models', '12346', '12345.9999999999999'],
    ['stream', '12346', '12345.9999999999999'],
  ] as const)(
    'scans final serialized %s bytes for numeric key %s from %s on both slots',
    async (kind, key, numeric) => {
      const f = await fixture();
      for (const name of ['primary', 'reserve'] as const) {
        f.slots[name]!.key = key;
        f.handlers[name] = (_req, res) => {
          if (kind === 'stream') {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(event('ok').replace('"id":"stream-1"', `"usage":${numeric}`) + endStream());
          } else {
            const value = kind === 'models' ? { data: [{ id: 'm' }] } : answer();
            res.end(JSON.stringify(value).replace(/}$/, `,"usage":${numeric}}`));
          }
        };
      }
      const response =
        kind === 'models'
          ? await fetch(`${f.url}/v1/models`)
          : await f.post(kind === 'stream' ? streamPayload : undefined);
      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).toContain('unsafe_response');
      expect(text).not.toContain(key);
      expect(f.attempts.map((a) => a.slot)).toEqual(['primary', 'reserve']);
    }
  );
  it.each(['completion', 'models', 'stream', 'split stream'] as const)(
    'refuses a cached primary key echoed by reserve in %s',
    async (kind) => {
      const f = await fixture();
      f.handlers.primary = (_req, res) => {
        res.writeHead(500);
        res.end();
      };
      f.handlers.reserve = (_req, res) => {
        if (kind.includes('stream')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(
            (kind === 'split stream'
              ? event('primary-SUPER-') + event('SECRET')
              : event('primary-SUPER-SECRET')) + endStream()
          );
        } else
          res.end(
            JSON.stringify(
              kind === 'models'
                ? { data: [{ id: 'primary-SUPER-SECRET' }] }
                : answer('m', 'primary-SUPER-SECRET')
            )
          );
      };
      const response =
        kind === 'models'
          ? await fetch(`${f.url}/v1/models`)
          : await f.post(kind.includes('stream') ? streamPayload : undefined);
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain('SECRET');
      expect(JSON.stringify(f.lines)).not.toContain('SECRET');
    }
  );
  it.each([false, true])(
    'caller rejections preserve all health fields, healthy=%s',
    async (healthy) => {
      const f = await fixture();
      if (healthy) await (await f.post()).text();
      const before = await (await fetch(`${f.statusUrl}/status`)).json();
      const warnBefore = f.lines.filter((line) => line.level === 'warn');
      for (const body of [
        {},
        { model: 42, messages: [] },
        { model: 'default', messages: 'wrong' },
        { model: 'default', messages: [{ content: 'x'.repeat(1024 * 1024) }] },
      ]) {
        const response = await f.post(body);
        expect([400, 413]).toContain(response.status);
        await response.text();
        expect(await (await fetch(`${f.statusUrl}/status`)).json()).toEqual(before);
      }
      const malformed = await fetch(`${f.url}/v1/chat/completions`, {
        method: 'POST',
        body: 'not-json',
      });
      expect(malformed.status).toBe(400);
      await malformed.text();
      expect(await (await fetch(`${f.statusUrl}/status`)).json()).toEqual(before);
      expect(f.lines.filter((line) => line.level === 'warn')).toEqual(warnBefore);
      expect(f.attempts).toHaveLength(healthy ? 1 : 0);
    }
  );
  it.each([false, true])(
    'client disconnect preserves model health, healthy=%s',
    async (healthy) => {
      const f = await fixture();
      if (healthy) await (await f.post()).text();
      const before = await (await fetch(`${f.statusUrl}/status`)).json();
      const closed = latch();
      f.handlers.primary = (_req, res) => {
        res.on('close', closed.resolve);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(event('visible'));
      };
      const controller = new AbortController();
      const response = await fetch(`${f.url}/v1/chat/completions`, {
        method: 'POST',
        body: JSON.stringify(streamPayload),
        signal: controller.signal,
      });
      await response.body!.getReader().read();
      controller.abort();
      await closed.promise;
      expect(await (await fetch(`${f.statusUrl}/status`)).json()).toEqual(before);
      expect(f.lines.filter((line) => line.level === 'warn')).toEqual([]);
    }
  );
  it('disconnect after a primary failure records only that slot failure', async () => {
    const f = await fixture();
    f.handlers.primary = (_req, res) => {
      res.writeHead(500);
      res.end();
    };
    const entered = latch();
    const closed = latch();
    f.handlers.reserve = (_req, res) => {
      res.on('close', closed.resolve);
      entered.resolve();
    };
    const controller = new AbortController();
    const pending = fetch(`${f.url}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'default', messages: [] }),
      signal: controller.signal,
    }).catch(() => undefined);
    await entered.promise;
    controller.abort();
    await pending;
    await closed.promise;
    expect(await (await fetch(`${f.statusUrl}/status`)).json()).toMatchObject({
      state: 'unknown',
      outageSince: null,
      lastSuccessAt: null,
      lastErrorCode: null,
      primary: { lastErrorCode: 'upstream_500' },
      reserve: { lastErrorCode: null, lastErrorAt: null },
    });
    expect(f.lines.filter((line) => line.level === 'warn')).toEqual([]);
  });
  it.each(['blocked', 'unset', 'storage'] as const)(
    'platform %s failure reports down before any success',
    async (failure) => {
      const f = await fixture();
      if (failure === 'blocked') f.slots.primary!.baseUrl = 'http://127.0.0.1:1/v1';
      if (failure === 'unset') {
        f.slots.primary = null;
        f.slots.reserve = null;
      }
      if (failure === 'storage') f.baoStatus = 503;
      f.handlers.reserve = (_req, res) => {
        res.writeHead(500);
        res.end();
      };
      expect((await f.post()).status).toBe(502);
      const status = await (await fetch(`${f.statusUrl}/status`)).json();
      expect(status.state).toBe('down');
      expect(status.outageSince).not.toBeNull();
      expect(status.lastAttemptAt).not.toBeNull();
      expect(status.lastErrorCode).toBe(
        failure === 'blocked'
          ? 'upstream_500'
          : failure === 'storage'
            ? 'storage_unavailable'
            : 'not_configured'
      );
      expect(f.attempts.map((a) => a.slot)).toEqual(failure === 'blocked' ? ['reserve'] : []);
    }
  );

  it.each(['blocked', 'unset', 'storage'] as const)(
    'platform %s failure reports down after healthy traffic',
    async (failure) => {
      const f = await fixture();
      await (await f.post()).text();
      const healthy = await (await fetch(`${f.statusUrl}/status`)).json();
      if (failure === 'blocked') f.slots.primary!.baseUrl = 'http://127.0.0.1:1/v1';
      if (failure === 'unset') f.slots.primary = null;
      if (failure === 'storage') f.baoStatus = 503;
      f.cache.invalidate('primary');
      f.handlers.reserve = (_req, res) => {
        res.writeHead(500);
        res.end();
      };
      await (await f.post()).text();
      const status = await (await fetch(`${f.statusUrl}/status`)).json();
      expect(status.state).toBe('down');
      expect(status.outageSince).not.toBeNull();
      expect(status.lastSuccessAt).toBe(healthy.lastSuccessAt);
      expect(status.lastErrorCode).toBe(
        failure === 'blocked'
          ? 'upstream_500'
          : failure === 'unset'
            ? 'not_configured'
            : 'storage_unavailable'
      );
      if (failure === 'blocked')
        expect(status).toMatchObject({
          primary: { lastErrorCode: 'blocked_destination' },
          reserve: { lastErrorCode: 'upstream_500' },
        });
    }
  );
  it('primary refuses a reserve key already held in the cache', async () => {
    const f = await fixture();
    await f.cache.read('reserve');
    f.handlers.primary = (_req, res) =>
      res.end(JSON.stringify(answer('m', 'reserve-SUPER-SECRET')));
    f.handlers.reserve = (_req, res) =>
      res.end(JSON.stringify(answer('m', 'primary-SUPER-SECRET')));
    const response = await f.post();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('SECRET');
  });
  it('rotation removes old keys from the inspected cache set', async () => {
    const f = await fixture();
    await (await f.post()).text();
    f.slots.primary!.key = 'new-credential';
    f.cache.invalidate('primary');
    f.handlers.primary = (_req, res) =>
      res.end(JSON.stringify(answer('m', 'primary-SUPER-SECRET')));
    const response = await f.post();
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe('primary-SUPER-SECRET');
    expect(f.cache.keys()).toEqual(['new-credential']);
  });
  it('guards escaped decoded model-list strings on both slots', async () => {
    const f = await fixture();
    for (const name of ['primary', 'reserve'] as const)
      f.handlers[name] = (_req, res) =>
        res.end(
          JSON.stringify({ data: [{ id: `${name}-SUPER-SECRET` }] }).replaceAll('S', '\u0053')
        );
    const response = await fetch(`${f.url}/v1/models`);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('SECRET');
    expect(f.attempts.map((a) => a.slot)).toEqual(['primary', 'reserve']);
  });
  it('status has exact safe key sets after a primary failure', async () => {
    const f = await fixture();
    f.handlers.primary = (_req, res) => {
      res.writeHead(500);
      res.end('PRIVATE');
    };
    await (await f.post()).text();
    const status = await (await fetch(`${f.statusUrl}/status`)).json();
    expect(Object.keys(status).sort()).toEqual(
      [
        'state',
        'outageSince',
        'lastAttemptAt',
        'lastSuccessAt',
        'lastErrorCode',
        'primary',
        'reserve',
      ].sort()
    );
    for (const name of ['primary', 'reserve'] as const) {
      expect(Object.keys(status[name]).sort()).toEqual(['lastErrorAt', 'lastErrorCode']);
      expect(JSON.stringify(status)).not.toContain(f.slots[name]!.key);
      expect(JSON.stringify(status)).not.toContain(f.slots[name]!.baseUrl);
    }
    expect(JSON.stringify(status)).not.toContain('http');
    expect(JSON.stringify(status)).not.toContain('PRIVATE');
  });
  it.each([false, true])(
    'validates a live reserve destination including after invalidation=%s',
    async (rotated) => {
      const f = await fixture();
      if (rotated) {
        f.handlers.primary = (_req, res) => {
          res.writeHead(500);
          res.end();
        };
        await (await f.post()).text();
        f.attempts.length = 0;
      }
      const blocked = new URL(f.slots.reserve!.baseUrl);
      blocked.hostname = '127.0.0.1';
      f.slots.reserve!.baseUrl = blocked.toString();
      f.cache.invalidate('reserve');
      f.handlers.primary = (_req, res) => {
        res.writeHead(500);
        res.end();
      };
      const response = await f.post();
      expect(response.status).toBe(502);
      expect(await response.text()).toContain('blocked_destination');
      expect(f.attempts.map((a) => a.slot)).toEqual(['primary']);
    }
  );
});

describe('model gateway production timer and inbound boundaries', () => {
  it('pins the production connect, first-byte, overall and idle budgets', () => {
    expect(GATEWAY_LIMITS).toEqual({
      connect: 5000,
      firstByte: 45000,
      overall: 110000,
      idle: 30000,
    });
  });
  it('enforces the default overall 110-second deadline across slots with no timeout override', async () => {
    // A controlled timer queue advances only gateway timers. Real HTTP uses the event loop normally.
    let now = 0;
    let sequence = 0;
    const scheduled = new Map<number, { at: number; callback: () => void }>();
    const timers = {
      set: ((callback: () => void, ms: number) => {
        const id = ++sequence;
        scheduled.set(id, { at: now + ms, callback });
        return id;
      }) as unknown as typeof setTimeout,
      clear: ((id: number) => {
        scheduled.delete(id);
      }) as unknown as typeof clearTimeout,
    };
    const advance = (ms: number) => {
      now += ms;
      for (const [id, timer] of [...scheduled])
        if (timer.at <= now) {
          scheduled.delete(id);
          timer.callback();
        }
    };
    const f = await fixture(undefined, timers);
    const primaryEntered = latch();
    const primaryClosed = latch();
    const reserveEntered = latch();
    const reserveClosed = latch();
    let sendFrame!: () => void;
    f.handlers.primary = (_req, res) => {
      res.on('close', primaryClosed.resolve);
      primaryEntered.resolve();
    };
    f.handlers.reserve = (_req, res) => {
      res.on('close', reserveClosed.resolve);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(event('visible'));
      reserveEntered.resolve();
      sendFrame = () => {
        res.write(event('still active'));
      };
    };
    const pending = f.post(streamPayload);
    await primaryEntered.promise;
    advance(45000);
    const response = await pending;
    await reserveEntered.promise;
    await primaryClosed.promise;
    const reader = response.body!.getReader();
    await reader.read();
    // Keep the stream active: neither first-byte nor idle can cause the final cut.
    for (const ms of [20000, 20000, 20000, 4999]) {
      advance(ms);
      sendFrame();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('still active');
    }
    expect(now).toBe(109999);
    expect([...scheduled.values()].some((timer) => timer.at === 110000)).toBe(true);
    expect(f.attempts.map((a) => a.slot)).toEqual(['primary', 'reserve']);
    advance(1);
    let text = '';
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      text += new TextDecoder().decode(part.value);
    }
    expect(text).toContain('timeout');
    await reserveClosed.promise;
    expect(f.attempts.map((a) => a.slot)).toEqual(['primary', 'reserve']);
    expect(scheduled.size).toBe(0);
  });
  it('ignores a spoofed inbound slot header', async () => {
    const f = await fixture();
    const response = await fetch(`${f.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'x-lifemodel-slot': 'reserve' },
      body: JSON.stringify({ model: 'default', messages: [] }),
    });
    expect(response.headers.get('x-lifemodel-slot')).toBe('primary');
    await response.text();
    expect(f.attempts.map((a) => a.slot)).toEqual(['primary']);
    expect(f.attempts[0]!.headers['x-lifemodel-slot']).toBeUndefined();
  });
  it.each([
    'Content-Length: 2\r\nContent-Length: 2',
    'Content-Length: 2\r\nTransfer-Encoding: chunked',
  ])('rejects ambiguous inbound framing %s without an upstream request', async (headers) => {
    const f = await fixture();
    const url = new URL(f.url);
    const text = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(url.port), url.hostname);
      let text = '';
      socket.on('error', reject);
      socket.on('data', (chunk) => {
        text += String(chunk);
      });
      socket.on('end', () => resolve(text));
      socket.on('connect', () =>
        socket.write(
          `POST /v1/chat/completions HTTP/1.1\r\nHost: gateway\r\n${headers}\r\nConnection: close\r\n\r\n{}`
        )
      );
    });
    expect(text).toContain('400 Bad Request');
    expect(f.attempts).toEqual([]);
    expect(f.reads).toEqual([]);
  });
});

describe('model gateway clears a stale outage on a slot change', () => {
  const statusOf = async (f: Awaited<ReturnType<typeof fixture>>) =>
    (await fetch(`${f.statusUrl}/status`)).json();
  const failing = (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(503);
    res.end();
  };

  it('turns down/not_configured into unknown once the absent primary is saved', async () => {
    const f = await fixture(undefined, undefined, { cache: 0 });
    const saved = { ...f.slots.primary! };
    f.slots.primary = null;
    expect((await f.post()).status).toBe(502);
    expect(await statusOf(f)).toMatchObject({
      state: 'down',
      lastErrorCode: 'not_configured',
    });
    // The owner saves the primary: the slot now exists at a new version.
    f.slots.primary = saved;
    f.versions.primary = 2;
    expect(await statusOf(f)).toMatchObject({
      state: 'unknown',
      outageSince: null,
      lastErrorCode: null,
      primary: { lastErrorCode: null, lastErrorAt: null },
    });
  });

  it('turns down/upstream_503 into unknown when both failing slots changed', async () => {
    const f = await fixture(undefined, undefined, { cache: 0 });
    f.handlers.primary = failing;
    f.handlers.reserve = failing;
    expect((await f.post()).status).toBe(502);
    const down = await statusOf(f);
    expect(down).toMatchObject({ state: 'down', lastErrorCode: 'upstream_503' });
    expect(down.outageSince).not.toBeNull();
    f.versions.primary = 2;
    f.versions.reserve = 2;
    expect(await statusOf(f)).toMatchObject({
      state: 'unknown',
      outageSince: null,
      lastErrorCode: null,
      primary: { lastErrorCode: null, lastErrorAt: null },
      reserve: { lastErrorCode: null, lastErrorAt: null },
    });
  });

  it('keeps the outage while the slots keep their versions', async () => {
    const f = await fixture(undefined, undefined, { cache: 0 });
    f.handlers.primary = failing;
    f.handlers.reserve = failing;
    await (await f.post()).text();
    const first = await statusOf(f);
    expect(first.state).toBe('down');
    const outage = {
      state: 'down',
      outageSince: first.outageSince,
      lastErrorCode: 'upstream_503',
      primary: { lastErrorCode: 'upstream_503' },
      reserve: { lastErrorCode: 'upstream_503' },
    };
    expect(await statusOf(f)).toMatchObject(outage);
    // A request still fails on the unchanged slots and shows the same outage.
    await (await f.post()).text();
    expect(await statusOf(f)).toMatchObject(outage);
  });

  it('answers within the bound while the re-check read does not answer', async () => {
    const f = await fixture(undefined, undefined, { cache: 0 });
    f.handlers.primary = failing;
    f.handlers.reserve = failing;
    await (await f.post()).text();
    f.holdReads = true;
    const startedAt = Date.now();
    const body = await statusOf(f);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(body.state).toBe('down');
    expect(body.outageSince).not.toBeNull();
  });

  it('changes nothing when Bao refuses the re-check read', async () => {
    const f = await fixture(undefined, undefined, { cache: 0 });
    f.handlers.primary = failing;
    f.handlers.reserve = failing;
    await (await f.post()).text();
    const down = await statusOf(f);
    expect(down.state).toBe('down');
    // A saved slot behind a Bao error is not a change the gateway can see.
    f.versions.primary = 2;
    f.baoStatus = 503;
    expect(await statusOf(f)).toEqual(down);
  });

  it('re-reads the failing slots at most once per cache window', async () => {
    const f = await fixture();
    f.handlers.primary = failing;
    f.handlers.reserve = failing;
    await (await f.post()).text();
    const reads = f.reads.length;
    expect((await statusOf(f)).state).toBe('down');
    expect(f.reads.length - reads).toBe(2);
    // The same answer serves the next poll: no second read inside the window.
    expect((await statusOf(f)).state).toBe('down');
    expect(f.reads.length - reads).toBe(2);
  });

  it('keeps the request down when only one failing slot changed', async () => {
    const f = await fixture(undefined, undefined, { cache: 0 });
    f.handlers.primary = failing;
    f.handlers.reserve = failing;
    await (await f.post()).text();
    f.versions.primary = 2;
    const body = await statusOf(f);
    expect(body.state).toBe('down');
    expect(body.outageSince).not.toBeNull();
    expect(body.primary).toEqual({ lastErrorCode: null, lastErrorAt: null });
    expect(body.reserve.lastErrorCode).toBe('upstream_503');
  });

  it('shows down again when the saved slot really fails', async () => {
    const f = await fixture(undefined, undefined, { cache: 0 });
    const saved = { ...f.slots.primary! };
    f.slots.primary = null;
    await (await f.post()).text();
    f.slots.primary = saved;
    f.versions.primary = 2;
    expect(await statusOf(f)).toMatchObject({ state: 'unknown' });
    f.handlers.primary = failing;
    f.handlers.reserve = failing;
    await (await f.post()).text();
    // The reset dropped the cached absence: the request reached the upstream again.
    expect(f.attempts.map((attempt) => attempt.slot)).toEqual(['primary', 'reserve']);
    expect(await statusOf(f)).toMatchObject({
      state: 'down',
      lastErrorCode: 'upstream_503',
    });
    expect((await statusOf(f)).outageSince).not.toBeNull();
  });

  function holdRead(f: Awaited<ReturnType<typeof fixture>>, slot: ModelSlotName = 'primary') {
    const entered = latch();
    let release!: () => void;
    f.interceptRead = (name, reply) => {
      if (name !== slot) return false;
      f.interceptRead = undefined;
      release = reply;
      entered.resolve();
      return true;
    };
    return { entered: entered.promise, release: () => release() };
  }

  it.each(['buffered', 'stream', 'header'] as const)(
    'pins active credentials across a status reset for %s responses (F1)',
    async (mode) => {
      const f = await fixture(undefined, undefined, { cache: 0 });
      // Numeric credentials can also fit the only forwarded header's syntax.
      f.slots.primary!.key = '123456';
      f.slots.reserve = null;
      f.handlers.primary = failing;
      await (await f.post()).text();
      const entered = latch();
      let release!: () => void;
      f.handlers.primary = (_req, res) => {
        release = () => {
          if (mode === 'stream') {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(event('123456') + endStream());
          } else {
            res.writeHead(200, { 'retry-after': '123456' });
            res.end(JSON.stringify(answer('real', mode === 'header' ? 'safe' : '123456')));
          }
        };
        entered.resolve();
      };
      const pending = f.post(mode === 'stream' ? streamPayload : undefined);
      await entered.promise;
      f.slots.primary = { ...f.slots.primary!, key: 'new-key' };
      f.versions.primary = 2;
      const reset = await statusOf(f);
      const keys = f.cache.keys();
      release();
      const response = await pending;
      expect(reset).toMatchObject({ primary: { lastErrorCode: null } });
      expect(keys).not.toContain('123456');
      expect(await response.text()).not.toContain('123456');
      expect(response.headers.get('retry-after')).toBeNull();
      expect(response.status).toBe(mode === 'header' ? 200 : 502);
      expect(JSON.stringify(f.lines)).not.toContain('123456');
    }
  );

  it.each(['failure', 'success', 'in-flight'] as const)(
    'does not overwrite a newer %s during a re-check (F2)',
    async (outcome) => {
      const f = await fixture(undefined, undefined, { cache: 0, bound: 500 });
      f.handlers.primary = failing;
      f.handlers.reserve = failing;
      await (await f.post()).text();
      f.versions.primary = 2;
      f.versions.reserve = 2;
      const held = holdRead(f);
      const pendingStatus = statusOf(f);
      await held.entered;
      const entered = latch();
      let finish!: () => void;
      f.handlers.primary = (_req, res) => {
        finish = () => {
          res.writeHead(outcome === 'success' ? 200 : 401);
          res.end(outcome === 'success' ? JSON.stringify(answer()) : 'private');
        };
        entered.resolve();
        if (outcome !== 'in-flight') finish();
      };
      const pendingRequest = f.post();
      await entered.promise;
      if (outcome !== 'in-flight') await (await pendingRequest).text();
      held.release();
      const status = await pendingStatus;
      if (outcome === 'in-flight') {
        finish();
        await (await pendingRequest).text();
      }
      expect(status.state).toBe(outcome === 'success' ? 'ok' : 'down');
      if (outcome === 'failure') {
        expect(status.lastErrorCode).toBe('upstream_401');
        expect(status.primary.lastErrorCode).toBe('upstream_401');
      }
    }
  );

  it('resets a repaired primary without an optional reserve (F3)', async () => {
    const f = await fixture(undefined, undefined, { cache: 0 });
    f.slots.reserve = null;
    f.handlers.primary = failing;
    await (await f.post()).text();
    expect(await statusOf(f)).toMatchObject({
      state: 'down',
      reserve: { lastErrorCode: null, lastErrorAt: null },
    });
    f.versions.primary = 2;
    expect(await statusOf(f)).toMatchObject({ state: 'unknown', outageSince: null });
  });

  it('treats an appearing reserve as recovery, not a prior failure (F3)', async () => {
    const f = await fixture(undefined, undefined, { cache: 0 });
    const reserve = f.slots.reserve;
    f.slots.reserve = null;
    f.handlers.primary = failing;
    await (await f.post()).text();
    const down = await statusOf(f);
    f.slots.reserve = reserve;
    expect(await statusOf(f)).toMatchObject({
      state: 'unknown',
      outageSince: null,
      primary: down.primary,
      reserve: { lastErrorCode: null, lastErrorAt: null },
    });
    const response = await f.post();
    expect(response.headers.get('x-lifemodel-slot')).toBe('reserve');
    await response.text();
  });

  it('shares unsettled Bao reads across overlapping and after-bound polls (F4)', async () => {
    const f = await fixture(undefined, undefined, { cache: 0, bound: 40 });
    f.handlers.primary = failing;
    f.handlers.reserve = failing;
    await (await f.post()).text();
    const reads = f.reads.length;
    f.versions.primary = 2;
    f.versions.reserve = 2;
    const both = latch();
    const replies: Array<() => void> = [];
    f.interceptRead = (_name, reply) => {
      replies.push(reply);
      if (replies.length === 2) both.resolve();
      return true;
    };
    const first = statusOf(f);
    await both.promise;
    const second = statusOf(f);
    expect((await first).state).toBe('down');
    expect((await second).state).toBe('down');
    expect((await statusOf(f)).state).toBe('down');
    const readCount = f.reads.length - reads;
    // Drain the held responses before asserting, including when a mutation fails.
    // Any next batch fails; only the expired replies carry the changed versions.
    f.baoStatus = 503;
    replies.forEach((reply) => reply());
    f.interceptRead = undefined;
    expect((await statusOf(f)).state).toBe('down');
    expect(readCount).toBe(2);
  });

  it('skips only the identity-less failure and invalidates a changed known slot (F5)', async () => {
    const f = await fixture(undefined, undefined, { cache: 0 });
    f.handlers.primary = failing;
    f.baoStatuses.reserve = 503;
    await (await f.post()).text();
    f.versions.primary = 2;
    expect(await statusOf(f)).toMatchObject({
      state: 'down',
      lastErrorCode: 'storage_unavailable',
      primary: { lastErrorCode: null, lastErrorAt: null },
      reserve: { lastErrorCode: 'storage_unavailable' },
    });
    f.slots.primary = { ...f.slots.primary!, key: 'new-primary-key' };
    f.handlers.primary = (_req, res) => res.end(JSON.stringify(answer()));
    await (await f.post()).text();
    expect(f.attempts.at(-1)?.headers.authorization).toBe('Bearer new-primary-key');
  });

  it('never re-checks ok even with a changed retained failure (F7)', async () => {
    const f = await fixture(undefined, undefined, { cache: 0 });
    f.handlers.primary = failing;
    await (await f.post()).text();
    const reads = f.reads.length;
    f.versions.primary = 2;
    expect(await statusOf(f)).toMatchObject({
      state: 'ok',
      primary: { lastErrorCode: 'upstream_503' },
    });
    expect(f.reads.length).toBe(reads);
  });

  it('never reads Bao for initial unknown (F7)', async () => {
    const f = await fixture(undefined, undefined, { cache: 0 });
    expect(await statusOf(f)).toMatchObject({ state: 'unknown' });
    expect(f.reads).toEqual([]);
  });
});

describe('model gateway custom slot headers', () => {
  it('fills {session} from the caller and sends a static value as is, copying no other inbound header', async () => {
    const f = await fixture();
    f.slots.primary = {
      ...f.slots.primary!,
      headers: [
        { name: 'x-opencode-session', value: '{session}' },
        { name: 'x-static', value: 'static-value' },
      ],
    };
    const response = await f.post(undefined, { 'x-lifemodel-session': 'conv-1' });
    expect(response.status).toBe(200);
    expect(f.attempts).toHaveLength(1);
    expect(f.attempts[0]?.headers['x-opencode-session']).toBe('conv-1');
    expect(f.attempts[0]?.headers['x-static']).toBe('static-value');
    expect(f.attempts[0]?.headers['x-lifemodel-session']).toBeUndefined();
    expect(f.attempts[0]?.headers['x-forwarded-for']).toBeUndefined();
    expect(f.attempts[0]?.headers['cookie']).toBeUndefined();
  });

  it('never lets a custom header replace the gateway own host, content type, accept, authorization or length', async () => {
    const f = await fixture();
    await (await f.post()).text();
    const first = f.attempts[0]?.headers ?? {};
    const baseline = Object.keys(first).sort();
    expect(first['authorization']).toBe('Bearer primary-SUPER-SECRET');
    f.slots.primary = {
      ...f.slots.primary!,
      headers: [{ name: 'x-custom-a', value: '1' }],
    };
    f.cache.invalidate('primary');
    await (await f.post()).text();
    const headers = f.attempts[1]?.headers;
    expect(headers?.['authorization']).toBe('Bearer primary-SUPER-SECRET');
    expect(headers?.['content-type']).toBe('application/json');
    expect(headers?.['accept']).toBe('application/json');
    expect(String(headers?.['content-length'])).toBe(String(first['content-length']));
    expect(headers?.['x-custom-a']).toBe('1');
    expect(Object.keys(headers ?? {}).sort()).toEqual([...baseline, 'x-custom-a'].sort());
  });

  it('refuses a slot whose stored headers name a reserved header: nothing reaches an upstream', async () => {
    const f = await fixture();
    for (const name of ['primary', 'reserve'] as const)
      f.slots[name] = {
        ...f.slots[name]!,
        headers: [{ name: 'Authorization', value: 'Bearer override' }],
      };
    const response = await f.post();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { type: 'gateway_error', code: 'storage_unavailable' },
    });
    expect(f.attempts).toEqual([]);
    expect(f.attempts[0]?.headers['authorization']).toBeUndefined();
  });

  it('sends one fixed process id when the caller names none or a malformed one, logging without it', async () => {
    const f = await fixture();
    f.slots.primary = {
      ...f.slots.primary!,
      headers: [{ name: 'x-opencode-session', value: 'id-{session}' }],
    };
    expect((await f.post()).status).toBe(200);
    expect((await f.post(undefined, { 'x-lifemodel-session': 'not a session id!' })).status).toBe(
      200
    );
    expect((await f.post(undefined, { 'x-lifemodel-session': 'conv-1' })).status).toBe(200);
    const fallback = f.attempts[0]?.headers['x-opencode-session'];
    expect(fallback).toMatch(/^id-[0-9a-f-]{36}$/);
    expect(f.attempts[1]?.headers['x-opencode-session']).toBe(fallback);
    expect(f.attempts[2]?.headers['x-opencode-session']).toBe('id-conv-1');
    const logged = JSON.stringify(f.lines);
    expect(logged).not.toContain(String(fallback));
    expect(logged).toContain('session placeholder');
    // Only the two requests that had to fall back log the line.
    expect(
      f.lines.filter((line) => line.message.includes('session placeholder'))
    ).toHaveLength(2);
    expect(f.lines.map((line) => line.fields['header'])).not.toContain('id-conv-1');
  });

  it('never puts a header value in the status answer, a log line or a response', async () => {
    const f = await fixture();
    for (const name of ['primary', 'reserve'] as const) {
      f.slots[name] = {
        ...f.slots[name]!,
        headers: [{ name: 'x-opencode-session', value: 'HEADER-SUPER-SECRET' }],
      };
      f.handlers[name] = (_req, res) =>
        res.end(JSON.stringify(answer(name, 'echo HEADER-SUPER-SECRET')));
    }
    const response = await f.post();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('HEADER-SUPER-SECRET');
    const status = await (await fetch(`${f.statusUrl}/status`)).text();
    expect(status).not.toContain('HEADER-SUPER-SECRET');
    expect(JSON.stringify(f.lines)).not.toContain('HEADER-SUPER-SECRET');
  });

  it('sends exactly the headers of today for a slot that carries none', async () => {
    const f = await fixture();
    await (await f.post()).text();
    expect(Object.keys(f.attempts[0]?.headers ?? {}).sort()).toEqual([
      'accept',
      'authorization',
      'connection',
      'content-length',
      'content-type',
      'host',
    ]);
  });
});
