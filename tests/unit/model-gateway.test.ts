import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { createModelGateway } from '../../loader/src/model-gateway-app.js';
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
async function fixture(options: Parameters<typeof createModelGateway>[0]['timeouts'] = {}) {
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
      const slot = req.url?.endsWith('/reserve') ? slots.reserve : slots.primary;
      res.writeHead(baoStatus === 200 && !slot ? 404 : baoStatus);
      res.end(
        baoStatus === 200
          ? JSON.stringify({ data: { data: slot, metadata: {} } })
          : 'PRIVATE BAO BODY'
      );
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
  const app = createModelGateway({ slots: cache, logger, timeouts: options });
  const url = await listen(app.api);
  const statusUrl = await listen(app.status);
  const post = (
    payload: unknown = { model: 'default', messages: [{ role: 'user', content: 'Hi' }] }
  ) =>
    fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer INBOUND-PRIVATE',
        cookie: 'PRIVATE-COOKIE',
        'x-forwarded-for': 'PRIVATE-FORWARDED',
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
    set baoStatus(value: number) {
      baoStatus = value;
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
      ? { tool_calls: [{ index: tool, function: { arguments: content } }] }
      : { [field]: content };
  return `data: ${JSON.stringify({ id: 'stream-1', model: 'stream-real', choices: [{ index: choice, delta }] })}\n\n`;
}
const streamPayload = { model: 'default', messages: [], stream: true };
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
      void finish.promise.then(() => res.end(event('{}', 'arguments') + 'data: [DONE]\n\n'));
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
          res.end(event('SECRET', field) + 'data: [DONE]\n\n');
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
          setImmediate(() => res.end(frame.slice(50) + 'data: [DONE]\n\n'));
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
          'data: [DONE]\n\n'
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
      res.end(event('reserve good') + 'data: [DONE]\n\n');
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
      const bytes = Buffer.from((event('Привет') + 'data: [DONE]\n\n').replaceAll('\n', '\r\n'));
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
          'data: [DONE]\n\n'
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
      res.end(event('reserve') + 'data: [DONE]\n\n');
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
      void finish.promise.then(() => res.end('data: [DONE]\n\n'));
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
      res.end('data: [DONE]\r\r');
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
          'data: {"model":"m","choices":[],"usage":{"total_tokens":2}}\n\ndata: [DONE]\n\n'
      );
    };
    const response = await f.post(streamPayload);
    const text = await response.text();
    expect(text).toContain('total_tokens');
    expect(text).toContain('[DONE]');
  });
});
