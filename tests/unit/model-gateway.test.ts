import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { createModelGateway, GATEWAY_LIMITS } from '../../loader/src/model-gateway-app.js';
import { connect } from 'node:net';
import { createRoleBaoClient, createCachedSlotReader } from '../../loader/src/model-bao.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';
import type { ModelSlot, ModelSlotName } from '../../loader/src/model.js';
import { createExchangeCapture, type CaptureRow } from '../../loader/src/model-exchange-capture.js';

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
  recheck?: Parameters<typeof createModelGateway>[0]['recheck'],
  capture?: Parameters<typeof createModelGateway>[0]['capture']
) {
  const attempts: Array<{
    slot: ModelSlotName;
    body: Record<string, unknown>;
    text: string;
    headers: IncomingMessage['headers'];
    rawHeaders: string[];
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
        attempts.push({
          slot: name,
          body,
          text,
          headers: req.headers,
          rawHeaders: req.rawHeaders,
          path: req.url ?? '',
        });
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
    ...(capture ? { capture } : {}),
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

describe('model gateway failure diagnostics', () => {
  it('warns on a failed upstream even when reserve recovers, with trusted task trace and bounded safe excerpt', async () => {
    const f = await fixture();
    const traceId = 'task-trace-123';
    const taskId = 'trusted-task';
    const door = createServer((req, res) => {
      void f.app.serveTask(req, res, taskId, async () => undefined, { taskId, traceId });
    });
    const url = await listen(door);
    f.handlers.primary = (_req, res) => {
      res.writeHead(500, { authorization: 'HEADER-CANARY' });
      res.end(
        JSON.stringify({
          error: { message: '界'.repeat(500), type: 'ignored' },
          prompt: 'PROMPT-CANARY',
          token: 'TOKEN-CANARY',
        })
      );
    };
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'local', messages: [] }),
      headers: { authorization: 'Bearer INBOUND-CANARY', 'x-trace-id': 'SPOOFED-CANARY' },
    });
    expect(response.status).toBe(200);
    const warnings = f.lines.filter((line) => line.message === 'Model gateway upstream failed');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      level: 'warn',
      fields: {
        traceId,
        taskId,
        status: 500,
        modelRoute: 'primary',
        errorExcerpt: '界'.repeat(100),
      },
    });
    expect(JSON.stringify(f.lines)).not.toContain('CANARY');
  });

  it('returns only a safe JSON error excerpt and warns for every non-2xx, including redirects', async () => {
    const f = await fixture();
    f.slots.reserve = null;
    f.handlers.primary = (_req, res) => {
      res.writeHead(429);
      res.end(JSON.stringify({ error: { message: 'Capacity exhausted' }, body: 'BODY-CANARY' }));
    };
    const response = await f.post();
    expect(await response.json()).toEqual({
      error: { type: 'gateway_error', code: 'upstream_429', message: 'Capacity exhausted' },
    });
    expect(f.lines.find((line) => line.message === 'Model gateway upstream failed')).toMatchObject({
      level: 'warn',
      fields: { status: 429, errorExcerpt: 'Capacity exhausted' },
    });
    f.handlers.primary = (_req, res) => {
      res.writeHead(302);
      res.end();
    };
    await f.post();
    expect(
      f.lines.filter((line) => line.message === 'Model gateway upstream failed').at(-1)
    ).toMatchObject({ fields: { status: 302 } });
    expect(JSON.stringify(f.lines)).not.toContain('CANARY');
  });

  it('drops a prompt echo from error.message and masks key forms in gateway logs and responses', async () => {
    const f = await fixture();
    f.slots.reserve = null;
    const prompt = 'REJECTED-PRIVATE-USER-TEXT-CANARY';
    f.handlers.primary = (_req, res) => {
      res.writeHead(400);
      res.end(
        JSON.stringify({
          error: { message: `input_value='${prompt}'`, type: 'validation_error', code: 'invalid' },
        })
      );
    };
    const response = await f.post({
      model: 'default',
      messages: [{ role: 'user', content: prompt }],
    });
    expect(await response.json()).toMatchObject({
      error: { message: 'validation_error; invalid' },
    });
    expect(JSON.stringify(f.lines)).not.toContain(prompt);
    expect(f.lines.filter((line) => line.level === 'warn')).toHaveLength(1);
    f.handlers.primary = (_req, res) => {
      res.writeHead(400);
      res.end(JSON.stringify({ error: { message: 'rejected sk-or-v1-ab…z or sk-…' } }));
    };
    const masked = await f.post();
    expect(await masked.text()).not.toContain('sk-');
    expect(JSON.stringify(f.lines)).not.toContain('sk-');
  });

  it.each(['first-byte', 'overall'] as const)(
    'keeps a non-2xx status when its body hits the %s timeout',
    async (deadline) => {
      const f = await fixture(
        deadline === 'overall'
          ? { overall: 100, firstByte: 1000 }
          : { overall: 1000, firstByte: 100 }
      );
      f.slots.reserve = null;
      f.handlers.primary = (_req, res) => {
        res.writeHead(500);
        res.flushHeaders();
      };
      const response = await f.post();
      expect(response.status).toBe(502);
      expect(
        f.lines.find((line) => line.message === 'Model gateway upstream failed')
      ).toMatchObject({
        fields: { code: 'timeout', status: 500, errorExcerpt: '' },
      });
      expect(f.lines.filter((line) => line.level === 'warn')).toHaveLength(1);
      expect(await response.json()).toMatchObject({ error: { code: 'timeout' } });
    }
  );

  it('scrubs known keys, credential text and raw bodies, and logs transport failures', async () => {
    const f = await fixture();
    f.handlers.primary = (_req, res) => {
      res.writeHead(500);
      res.end(
        JSON.stringify({
          error: {
            message: 'Bearer primary-SUPER-SECRET',
            type: 'token=UNKNOWN-CANARY',
            code: 'primary-SUPER-SECRET',
          },
          secret: 'BODY-CANARY',
        })
      );
    };
    f.handlers.reserve = (req) => {
      req.socket.destroy();
    };
    await f.post();
    const warnings = f.lines.filter((line) => line.message === 'Model gateway upstream failed');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]!.fields.errorExcerpt).toBe('[redacted]');
    expect(warnings[1]!.fields).toMatchObject({
      code: 'unreachable',
      status: 502,
      modelRoute: 'reserve',
    });
    for (const canary of ['SECRET', 'CANARY', 'Bearer', 'token='])
      expect(JSON.stringify(f.lines)).not.toContain(canary);
  });
});

describe('model gateway buffered HTTP contract', () => {
  it('leaves a blank slot effort absent and preserves every caller field', async () => {
    const f = await fixture();
    const payload = {
      model: 'owner-model',
      messages: [],
      temperature: 0.25,
      extra: { keep: true },
    };
    expect((await f.post(payload)).status).toBe(200);
    expect(f.attempts[0]?.body).toEqual(payload);
  });
  it.each(['none', 'minimal', 'low', 'medium', 'high'] as const)(
    'adds the configured %s effort on the upstream wire',
    async (effort) => {
      const f = await fixture();
      f.slots.primary!.reasoningEffort = effort;
      expect((await f.post()).status).toBe(200);
      expect(f.attempts[0]?.body.reasoning_effort).toBe(effort);
    }
  );
  it('uses each attempted slot effort independently, and never overwrites the client', async () => {
    const f = await fixture();
    f.slots.primary!.reasoningEffort = 'none';
    f.slots.reserve!.reasoningEffort = 'low';
    f.handlers.primary = (_req, res) => {
      res.writeHead(503);
      res.end();
    };
    expect((await f.post()).status).toBe(200);
    expect(f.attempts.map((attempt) => attempt.body.reasoning_effort)).toEqual(['none', 'low']);
    f.attempts.length = 0;
    expect(
      (await f.post({ model: 'default', messages: [], reasoning_effort: 'high' })).status
    ).toBe(200);
    expect(f.attempts.map((attempt) => attempt.body.reasoning_effort)).toEqual(['high', 'high']);
  });
  it('applies the same slot effort to task requests and preserves their explicit effort', async () => {
    const f = await fixture();
    f.slots.primary!.reasoningEffort = 'none';
    const url = await listen(
      createServer((req, res) => {
        void f.app.serveTask(req, res, 'trusted-task', async () => undefined);
      })
    );
    for (const extra of [{}, { reasoning_effort: 'medium' }]) {
      const response = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({ model: 'task-model', messages: [], ...extra }),
      });
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(
      f.attempts.map((attempt) => [attempt.body.model, attempt.body.reasoning_effort])
    ).toEqual([
      ['primary-model', 'none'],
      ['primary-model', 'medium'],
    ]);
  });
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
  it.each([
    ['default', 'primary-model'],
    ['owner-fast', 'owner-fast'],
  ])('routes core model %s to %s on primary', async (model, expected) => {
    const f = await fixture();
    const response = await f.post({ model, messages: [] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(answer());
    expect(f.attempts.map((attempt) => [attempt.slot, attempt.body.model])).toEqual([
      ['primary', expected],
    ]);
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
/** How many times one name reached the upstream wire, in any casing. */
function wireCount(attempt: { rawHeaders: string[] }, name: string): number {
  let count = 0;
  for (let index = 0; index < attempt.rawHeaders.length; index += 2)
    if (attempt.rawHeaders[index]?.toLowerCase() === name) count++;
  return count;
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
/**
 * The gateway's timer queue under the test's hand: a deadline then fires once
 * the test has seen the event it is measured against, never after a wall-clock
 * race with a loaded event loop (lifemodel-pf3v).
 */
function controlledTimers() {
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
  return {
    timers,
    advance,
    scheduled,
    get now() {
      return now;
    },
  };
}
/**
 * Await one event with a bound of its own: an event that never comes then fails
 * in a second saying what did not happen, instead of ending the test at
 * Vitest's 5 s timeout (lifemodel-pf3v).
 */
const EVENT_BOUND = 1_000;
async function awaitEvent<T>(event: Promise<T>, missing: string): Promise<T> {
  let bound: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    bound = setTimeout(() => reject(new Error(`${missing} within ${EVENT_BOUND} ms`)), EVENT_BOUND);
  });
  try {
    return await Promise.race([event, deadline]);
  } finally {
    clearTimeout(bound);
  }
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
    // The production budget is fired by the test once the upstream holds the
    // request: a sub-second deadline races the request's own round trip, so the
    // abort it waits for could happen before the upstream ever saw the request.
    const clock = controlledTimers();
    const f = await fixture(undefined, clock.timers);
    const entered = latch();
    const closed = latch();
    f.handlers.primary = (_req, res) => {
      res.on('close', closed.resolve);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
      entered.resolve();
    };
    const response = f.post();
    await awaitEvent(entered.promise, 'the primary upstream did not receive the request');
    clock.advance(GATEWAY_LIMITS.firstByte);
    const answered = await awaitEvent(response, 'the gateway did not answer');
    expect(answered.status).toBe(200);
    expect(answered.headers.get('x-lifemodel-slot')).toBe('reserve');
    await awaitEvent(closed.promise, 'the primary request was not aborted');
    expect(f.attempts.map((attempt) => attempt.slot)).toEqual(['primary', 'reserve']);
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
    // Both deadlines are the test's to fire, each only once its request has
    // arrived: the same wall-clock race would otherwise abort a request the
    // upstream never saw, and the close this test waits for would never come.
    const timeouts = { firstByte: 80, overall: 120 };
    const clock = controlledTimers();
    const f = await fixture(timeouts, clock.timers);
    const primaryEntered = latch();
    const primaryClosed = latch();
    const reserveEntered = latch();
    const reserveClosed = latch();
    f.handlers.primary = (_req, res) => {
      res.on('close', primaryClosed.resolve);
      primaryEntered.resolve();
    };
    f.handlers.reserve = (_req, res) => {
      res.on('close', reserveClosed.resolve);
      reserveEntered.resolve();
    };
    const response = f.post();
    await awaitEvent(primaryEntered.promise, 'the primary upstream did not receive the request');
    clock.advance(timeouts.firstByte);
    await awaitEvent(primaryClosed.promise, 'the primary request was not aborted');
    await awaitEvent(reserveEntered.promise, 'the reserve upstream did not receive the request');
    clock.advance(timeouts.overall - timeouts.firstByte);
    const answered = await awaitEvent(response, 'the gateway did not answer');
    expect(answered.status).toBe(502);
    expect(await answered.text()).toContain('timeout');
    await awaitEvent(reserveClosed.promise, 'the reserve request was not aborted');
    expect(f.attempts.map((attempt) => attempt.slot)).toEqual(['primary', 'reserve']);
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
    expect(f.lines.filter((line) => line.level === 'warn')).toEqual([
      expect.objectContaining({
        message: 'Model gateway upstream failed',
        fields: expect.objectContaining({ status: 500, modelRoute: 'primary' }),
      }),
    ]);
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
    const clock = controlledTimers();
    const { timers, advance, scheduled } = clock;
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
    expect(clock.now).toBe(109999);
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

  it.each(['buffered', 'stream', 'header'] as const)(
    'pins an active rendered header value across a cache reset for %s responses (F2)',
    async (mode) => {
      const f = await fixture(undefined, undefined, { cache: 0 });
      // A rendered value that also fits the only forwarded header's syntax.
      const ticket = '9876543210987654';
      f.slots.primary = {
        ...f.slots.primary!,
        headers: [{ name: 'x-ticket', value: ticket }],
      };
      f.slots.reserve = null;
      f.handlers.primary = failing;
      await (await f.post()).text();
      const entered = latch();
      let release!: () => void;
      f.handlers.primary = (_req, res) => {
        release = () => {
          if (mode === 'stream') {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(event(ticket) + endStream());
          } else {
            res.writeHead(200, { 'retry-after': ticket });
            res.end(JSON.stringify(answer('real', mode === 'header' ? 'safe' : ticket)));
          }
        };
        entered.resolve();
      };
      const pending = f.post(mode === 'stream' ? streamPayload : undefined);
      await entered.promise;
      // The cache is invalidated while the attempt's answer is still pending.
      f.slots.primary = {
        ...f.slots.primary!,
        headers: [{ name: 'x-ticket', value: 'NEW-HEADER-SECRET-VALUE' }],
      };
      f.versions.primary = 2;
      const reset = await statusOf(f);
      const keys = f.cache.keys();
      release();
      const response = await pending;
      expect(reset).toMatchObject({ primary: { lastErrorCode: null } });
      expect(keys).not.toContain(ticket);
      expect(await response.text()).not.toContain(ticket);
      expect(response.headers.get('retry-after')).toBeNull();
      expect(response.status).toBe(mode === 'header' ? 200 : 502);
      expect(JSON.stringify(f.lines)).not.toContain(ticket);
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
    const response = await f.post(undefined, {
      'x-lifemodel-session': 'conv-1',
      // The core's own call id names one model call for its trace span; the
      // gateway answers it and forwards no caller header upstream
      // (lifemodel-d4t8).
      'x-lifemodel-call': 'call-1',
    });
    expect(response.status).toBe(200);
    expect(f.attempts).toHaveLength(1);
    expect(f.attempts[0]?.headers['x-opencode-session']).toBe('conv-1');
    expect(f.attempts[0]?.headers['x-static']).toBe('static-value');
    expect(f.attempts[0]?.headers['x-lifemodel-session']).toBeUndefined();
    expect(f.attempts[0]?.headers['x-lifemodel-call']).toBeUndefined();
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

  it.each([{ keyed: true }, { keyed: false }])(
    'keeps the gateway own headers when the boundary hands it reserved names in mixed case (keyed=$keyed)',
    async ({ keyed }) => {
      // Validation is bypassed at the seam on purpose: a slot object arrives
      // with names the save rule refuses, and the header layering must still
      // hold. A keyless slot carries no authorization at all.
      const f = await fixture();
      f.handlers.primary = (req, res) =>
        res.end(
          JSON.stringify(
            req.url?.endsWith('/models') ? { data: [{ id: 'upstream-model' }] } : answer()
          )
        );
      const slot: ModelSlot = {
        kind: 'openai',
        baseUrl: f.slots.primary!.baseUrl,
        model: 'primary-model',
        ...(keyed ? { key: 'primary-SUPER-SECRET' } : {}),
        headers: [
          { name: 'Host', value: 'attacker.example' },
          { name: 'CONTENT-Type', value: 'text/plain' },
          { name: 'Accept', value: 'text/html' },
          { name: 'AuThOrIzAtIoN', value: 'Bearer OVERRIDE-SECRET' },
          { name: 'Content-Length', value: '1' },
          { name: 'x-kept', value: 'yes' },
        ],
      };
      const url = await listen(
        createModelGateway({
          slots: {
            read: async () => ({ state: 'present', slot, version: 1 }),
            identity: async () => ({ version: 1 }),
            invalidate: () => {},
            keys: () => [],
          },
          logger: createRecordingLogger([]),
        }).api
      );
      const response = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'default', messages: [] }),
      });
      expect(response.status).toBe(200);
      const sent = f.attempts[0]!;
      const upstreamHost = new URL(slot.baseUrl).host;
      expect(wireCount(sent, 'host')).toBe(1);
      expect(sent.headers['host']).toBe(upstreamHost);
      expect(wireCount(sent, 'content-type')).toBe(1);
      expect(sent.headers['content-type']).toBe('application/json');
      expect(wireCount(sent, 'accept')).toBe(1);
      expect(sent.headers['accept']).toBe('application/json');
      expect(wireCount(sent, 'authorization')).toBe(keyed ? 1 : 0);
      expect(sent.headers['authorization']).toBe(keyed ? 'Bearer primary-SUPER-SECRET' : undefined);
      expect(wireCount(sent, 'content-length')).toBe(1);
      expect(sent.headers['content-length']).toBe(String(Buffer.byteLength(sent.text)));
      expect(sent.headers['x-kept']).toBe('yes');
      // A bodyless GET carries no content-length and never an authorization.
      const models = await fetch(`${url}/v1/models`);
      expect(models.status).toBe(200);
      const list = f.attempts[1]!;
      expect(wireCount(list, 'content-length')).toBe(0);
      expect(wireCount(list, 'authorization')).toBe(keyed ? 1 : 0);
      expect(list.headers['host']).toBe(upstreamHost);
      expect(list.headers['content-type']).toBe('application/json');
    }
  );

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
    const fallbackLines = () =>
      f.lines.filter((line) => line.message.includes('session placeholder'));
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
    // Both requests that had to fall back, and no request after them, log the
    // line: one warning per slot configuration, named by its header names.
    expect(fallbackLines()).toHaveLength(1);
    expect(fallbackLines()[0]?.fields['headers']).toEqual(['x-opencode-session']);
    // A changed configuration is a new fact and is named once again.
    f.slots.primary = {
      ...f.slots.primary!,
      headers: [
        { name: 'x-opencode-session', value: 'id-{session}' },
        { name: 'x-tenant', value: 'tenant-{session}' },
      ],
    };
    f.cache.invalidate('primary');
    expect((await f.post()).status).toBe(200);
    expect((await f.post()).status).toBe(200);
    expect(fallbackLines()).toHaveLength(2);
    expect(fallbackLines()[1]?.fields['headers']).toEqual(['x-opencode-session', 'x-tenant']);
    expect(JSON.stringify(f.lines)).not.toContain('id-conv-1');
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

  it.each(['buffered', 'stream', 'split'] as const)(
    'refuses an upstream answer that echoes the rendered value a %s attempt sent',
    async (mode) => {
      const f = await fixture();
      f.slots.primary = {
        ...f.slots.primary!,
        headers: [{ name: 'x-token', value: 'RENDERED-HEADER-SECRET-{session}' }],
      };
      f.slots.reserve = null;
      let sentValue = '';
      f.handlers.primary = (req, res) => {
        sentValue = String(req.headers['x-token']);
        if (mode === 'stream') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(event(sentValue) + endStream());
        } else if (mode === 'split') {
          // The rendered value split across two SSE deltas of one field.
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(event(sentValue.slice(0, 8)) + event(sentValue.slice(8)) + endStream());
        } else {
          res.end(JSON.stringify(answer('real', sentValue)));
        }
      };
      const response = await f.post(mode === 'buffered' ? undefined : streamPayload, {
        'x-lifemodel-session': 'conv-1',
      });
      expect(sentValue).toBe('RENDERED-HEADER-SECRET-conv-1');
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain('RENDERED-HEADER-SECRET');
      expect(JSON.stringify(f.lines)).not.toContain('RENDERED-HEADER-SECRET');
    }
  );

  it('accepts a valid answer when a slot carries a short ordinary value', async () => {
    const f = await fixture();
    f.slots.primary = {
      ...f.slots.primary!,
      headers: [
        { name: 'x-version', value: '1' },
        { name: 'x-flag', value: 'true' },
        { name: 'x-opencode-session', value: '{session}' },
      ],
    };
    const response = await f.post(undefined, { 'x-lifemodel-session': 'conv-1' });
    expect(response.status).toBe(200);
    // The fixture's ordinary answer carries 'chat-1' and 'OK': a one-character
    // value would collide with it, and it is not treated as a credential.
    expect(await response.json()).toEqual(answer());
    expect(f.attempts[0]?.headers['x-version']).toBe('1');
    expect(f.attempts[0]?.headers['x-flag']).toBe('true');
    expect(f.attempts[0]?.headers['x-opencode-session']).toBe('conv-1');
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

describe('model gateway null tool_calls, slot attribution and safe reasons', () => {
  /** A converting endpoint's text answer: null encodes "no tool calls". */
  const textAnswer = (message: Record<string, unknown>) => ({
    id: 'chat-1',
    object: 'chat.completion',
    model: 'upstream-model',
    choices: [{ index: 0, message, finish_reason: 'stop' }],
  });
  const failed = 'Model gateway upstream failed';

  it('passes a buffered text answer whose tool_calls is null to the caller', async () => {
    const f = await fixture();
    const reply = textAnswer({
      role: 'assistant',
      content: 'plain text',
      reasoning_content: null,
      tool_calls: null,
    });
    f.handlers.primary = (_req, res) => res.end(JSON.stringify(reply));
    const response = await f.post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(reply);
    expect(response.headers.get('x-lifemodel-slot')).toBe('primary');
    expect(f.attempts).toHaveLength(1);
  });

  it('passes a stream whose tool_calls delta is null to the caller', async () => {
    const f = await fixture();
    f.handlers.primary = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({
          model: 'stream-real',
          choices: [
            { index: 0, delta: { role: 'assistant', reasoning_content: null, tool_calls: null } },
          ],
        })}\n\n` +
          event('hello') +
          endStream()
      );
    };
    const response = await f.post(streamPayload);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('hello');
    expect(text).toContain('[DONE]');
    expect(f.attempts).toHaveLength(1);
  });

  it('still refuses a buffered non-array, non-null tool_calls with bad_response', async () => {
    const f = await fixture();
    f.slots.reserve = null;
    f.handlers.primary = (_req, res) =>
      res.end(
        JSON.stringify(
          textAnswer({
            role: 'assistant',
            content: 'UPSTREAM-CANARY-TOOLS',
            tool_calls: 'UPSTREAM-CANARY-TOOLS',
          })
        )
      );
    const response = await f.post();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { type: 'gateway_error', code: 'bad_response' },
    });
    expect(f.attempts).toHaveLength(1);
  });

  it('still refuses a stream delta whose tool_calls is not an array or null', async () => {
    const f = await fixture();
    f.slots.reserve = null;
    f.handlers.primary = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({
          model: 'm',
          choices: [
            { index: 0, delta: { role: 'assistant', tool_calls: 'UPSTREAM-CANARY-TOOLS' } },
          ],
        })}\n\n` + endStream()
      );
    };
    const response = await f.post(streamPayload);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { type: 'gateway_error', code: 'bad_response' },
    });
  });

  it('still refuses a null content whose tool_calls is null too', async () => {
    const f = await fixture();
    f.slots.reserve = null;
    f.handlers.primary = (_req, res) =>
      res.end(JSON.stringify(textAnswer({ role: 'assistant', content: null, tool_calls: null })));
    const response = await f.post();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { type: 'gateway_error', code: 'bad_response' },
    });
  });

  it('names the primary in the warn line, the error and /status when it fails with no reserve', async () => {
    const f = await fixture();
    f.slots.reserve = null;
    f.handlers.primary = (_req, res) =>
      res.end(JSON.stringify(textAnswer({ role: 'assistant', content: null })));
    const response = await f.post();
    expect(response.status).toBe(502);
    expect(response.headers.get('x-lifemodel-slot')).toBe('primary');
    const warns = f.lines.filter((line) => line.message === failed).slice(-1);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.fields).toMatchObject({ code: 'bad_response', slot: 'primary' });
    expect(await (await fetch(`${f.statusUrl}/status`)).json()).toMatchObject({
      state: 'down',
      lastErrorCode: 'bad_response',
      primary: { lastErrorCode: 'bad_response' },
      reserve: { lastErrorCode: null },
    });
  });

  it('names the reserve when a configured reserve fails too', async () => {
    const f = await fixture();
    const fail = (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(500);
      res.end();
    };
    f.handlers.primary = fail;
    f.handlers.reserve = fail;
    const response = await f.post();
    expect(response.status).toBe(502);
    expect(response.headers.get('x-lifemodel-slot')).toBe('reserve');
    const warns = f.lines.filter((line) => line.message === failed).slice(-1);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.fields).toMatchObject({ code: 'upstream_500', slot: 'reserve' });
    expect(await (await fetch(`${f.statusUrl}/status`)).json()).toMatchObject({
      state: 'down',
      primary: { lastErrorCode: 'upstream_500' },
      reserve: { lastErrorCode: 'upstream_500' },
    });
  });

  it('logs a safe rejection reason and never a string from the body', async () => {
    const f = await fixture();
    f.slots.reserve = null;
    f.handlers.primary = (_req, res) =>
      res.end(
        JSON.stringify(
          textAnswer({
            role: 'assistant',
            content: 'UPSTREAM-CANARY-CONTENT',
            tool_calls: 'UPSTREAM-CANARY-TOOLS',
          })
        )
      );
    const response = await f.post();
    expect(response.status).toBe(502);
    const warns = f.lines.filter((line) => line.message === failed).slice(-1);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.fields).toMatchObject({
      code: 'bad_response',
      slot: 'primary',
      reason: { check: 'tool_calls_type', path: 'choices[0].message.tool_calls', got: 'string' },
    });
    const logged = JSON.stringify(f.lines);
    expect(logged).toContain('tool_calls_type');
    expect(logged).not.toContain('CANARY');
  });
});

describe('model gateway review round 2: safe reasons, stream positions, slot attribution', () => {
  const failed = 'Model gateway upstream failed';
  /** The fields of the one warn line a failed request leaves. */
  function failureOf(f: Awaited<ReturnType<typeof fixture>>): Record<string, unknown> {
    const warns = f.lines.filter((line) => line.message === failed).slice(-1);
    expect(warns).toHaveLength(1);
    return warns[0]!.fields as Record<string, unknown>;
  }
  const stream = (frames: string) => (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(frames);
  };
  /** A text answer with one choice, for refusals. */
  const textAnswer = (message: Record<string, unknown>) => ({
    id: 'chat-1',
    object: 'chat.completion',
    model: 'upstream-model',
    choices: [{ index: 0, message, finish_reason: 'stop' }],
  });

  it('names frame_size when an SSE event passes the body bound before its blank line', async () => {
    const f = await fixture();
    f.slots.reserve = null;
    f.handlers.primary = stream(`data: ${'A'.repeat(1024 * 1024 + 16)}\n\n`);
    const response = await f.post(streamPayload);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { type: 'gateway_error', code: 'bad_response' },
    });
    expect(failureOf(f)).toMatchObject({
      code: 'bad_response',
      slot: 'primary',
      reason: { check: 'frame_size', path: '' },
    });
  });

  it('points a stream delta reason at the real array position, not the logical choice index', async () => {
    const f = await fixture();
    f.slots.reserve = null;
    f.handlers.primary = stream(
      `data: ${JSON.stringify({
        model: 'm',
        choices: [{ index: 7, delta: { role: 'assistant', tool_calls: 'UPSTREAM-CANARY-TOOLS' } }],
      })}\n\n`
    );
    const response = await f.post(streamPayload);
    expect(response.status).toBe(502);
    expect(failureOf(f)).toMatchObject({
      code: 'bad_response',
      slot: 'primary',
      reason: { check: 'tool_calls_type', path: 'choices[0].delta.tool_calls', got: 'string' },
    });
    expect(JSON.stringify(f.lines)).not.toContain('CANARY');
  });

  it('points a stream tool-shape reason at the enumerated tool position', async () => {
    const f = await fixture();
    f.slots.reserve = null;
    f.handlers.primary = stream(
      `data: ${JSON.stringify({
        model: 'm',
        choices: [
          {
            index: 3,
            delta: {
              tool_calls: [
                { index: 5, id: 'call-1', type: 'function', function: { name: 't', arguments: 9 } },
              ],
            },
          },
        ],
      })}\n\n`
    );
    const response = await f.post(streamPayload);
    expect(response.status).toBe(502);
    expect(failureOf(f)).toMatchObject({
      code: 'bad_response',
      slot: 'primary',
      reason: { check: 'tool_call_shape', path: 'choices[0].delta.tool_calls[0]', got: 'object' },
    });
  });

  it('keeps the origin position for accumulated stream tool state', async () => {
    const f = await fixture();
    f.slots.reserve = null;
    // The choice first appears at position 0 (logical index 7) with logical
    // tool index 5, then finishes two frames later from another position.
    f.handlers.primary = stream(
      `data: ${JSON.stringify({
        model: 'm',
        choices: [
          {
            index: 7,
            delta: {
              tool_calls: [
                { index: 5, type: 'function', function: { name: 'UPSTREAM-CANARY-NAME' } },
              ],
            },
          },
        ],
      })}\n\n` +
        `data: ${JSON.stringify({
          model: 'm',
          choices: [
            { index: 3, delta: {} },
            { index: 7, delta: {}, finish_reason: 'stop' },
          ],
        })}\n\n` +
        'data: [DONE]\n\n'
    );
    const response = await f.post(streamPayload);
    // The first frame was valid and already sent downstream: no switch or
    // replay after the first byte, so the refusal arrives as a stream error.
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('bad_response');
    expect(failureOf(f)).toMatchObject({
      code: 'bad_response',
      slot: 'primary',
      reason: { check: 'incomplete_tool_call', path: 'choices[0].delta.tool_calls[0]' },
    });
    expect(JSON.stringify(f.lines)).not.toContain('CANARY');
  });

  it('ends a models-listing id reason in .id', async () => {
    const f = await fixture();
    f.slots.reserve = null;
    f.handlers.primary = (_req, res) =>
      res.end(JSON.stringify({ object: 'list', data: [{ id: 9 }] }));
    const response = await fetch(`${f.url}/v1/models`);
    expect(response.status).toBe(502);
    expect(failureOf(f)).toMatchObject({
      code: 'bad_response',
      slot: 'primary',
      reason: { check: 'model_id_type', path: 'data[0].id', got: 'number' },
    });
  });

  it('names the reserve when its slot read fails after a primary attempt failure', async () => {
    const f = await fixture();
    f.baoStatuses.reserve = 503;
    f.handlers.primary = (_req, res) => {
      res.writeHead(500);
      res.end();
    };
    const response = await f.post();
    expect(response.status).toBe(502);
    expect(response.headers.get('x-lifemodel-slot')).toBe('reserve');
    expect(failureOf(f)).toMatchObject({ code: 'storage_unavailable', slot: 'reserve' });
    expect(await (await fetch(`${f.statusUrl}/status`)).json()).toMatchObject({
      state: 'down',
      primary: { lastErrorCode: 'upstream_500' },
      reserve: { lastErrorCode: 'storage_unavailable' },
    });
  });

  it('never names an unknown delta field in a reason or any other surface', async () => {
    const f = await fixture();
    f.slots.reserve = null;
    const canary = 'UPSTREAM-CANARY-FIELD';
    f.handlers.primary = stream(
      `data: ${JSON.stringify({
        model: 'm',
        choices: [{ index: 0, delta: { role: 'assistant', [canary]: 'x' } }],
      })}\n\n`
    );
    const response = await f.post(streamPayload);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(canary);
    for (const [name, value] of [...response.headers.entries()])
      expect(`${name}: ${value}`).not.toContain(canary);
    expect(failureOf(f)).toMatchObject({
      code: 'bad_response',
      slot: 'primary',
      // The fixed enclosing path: the unknown field's own name is body data.
      reason: { check: 'delta_field', path: 'choices[0].delta', got: 'string' },
    });
    expect(JSON.stringify(f.lines)).not.toContain(canary);
    expect(await (await fetch(`${f.statusUrl}/status`)).text()).not.toContain(canary);
  });

  /** The exact safe caller surfaces after a reason-bearing refusal. */
  async function expectExactShapes(
    f: Awaited<ReturnType<typeof fixture>>,
    code: string
  ): Promise<void> {
    const response = await f.post();
    expect(response.status).toBe(502);
    expect([...response.headers.keys()].sort()).toEqual([
      'connection',
      'content-type',
      'date',
      'keep-alive',
      'transfer-encoding',
      'x-lifemodel-slot',
    ]);
    expect(response.headers.get('x-lifemodel-slot')).toBe('primary');
    expect(await response.json()).toEqual({ error: { type: 'gateway_error', code } });
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
    for (const name of ['primary', 'reserve'] as const)
      expect(Object.keys(status[name]).sort()).toEqual(['lastErrorAt', 'lastErrorCode']);
    expect(status.state).toBe('down');
    expect(status.lastErrorCode).toBe(code);
    expect(status.primary.lastErrorCode).toBe(code);
    expect(status.reserve.lastErrorCode).toBeNull();
    const text = JSON.stringify(status);
    expect(text).not.toContain('reason');
    expect(text).not.toContain('choices');
    expect(text).not.toContain('delta');
  }

  it('keeps the exact caller and status shapes after a bad_response', async () => {
    const f = await fixture();
    f.slots.reserve = null;
    f.handlers.primary = (_req, res) =>
      res.end(JSON.stringify(textAnswer({ role: 'assistant', content: 5 })));
    await expectExactShapes(f, 'bad_response');
  });

  it('keeps the exact caller and status shapes after an unsafe_response', async () => {
    const f = await fixture();
    f.slots.reserve = null;
    f.handlers.primary = (_req, res) =>
      res.end(JSON.stringify(textAnswer({ role: 'assistant', content: f.slots.primary!.key })));
    await expectExactShapes(f, 'unsafe_response');
  });
});

describe('model gateway opt-in exchange capture', () => {
  async function captured(write?: (row: CaptureRow) => Promise<void>) {
    const rows: CaptureRow[] = [];
    let setting: { until: string | null; session?: string } = {
      until: new Date(Date.now() + 600_000).toISOString(),
    };
    const capture = createExchangeCapture({
      context: () => ({
        setting,
        secrets: ['primary-SUPER-SECRET', 'reserve-SUPER-SECRET', 'DATABASE-PASSWORD'],
        secretHeaders: ['x-private'],
      }),
      write:
        write ??
        (async (row) => {
          rows.push(row);
        }),
    });
    const f = await fixture(undefined, undefined, undefined, capture);
    return {
      ...f,
      rows,
      capture,
      setSetting(value: typeof setting) {
        setting = value;
      },
    };
  }
  it('captures the actual upstream attempt, raw caller body and full response headers with whole-row redaction', async () => {
    const f = await captured();
    f.slots.primary!.reasoningEffort = 'none';
    f.slots.primary!.headers = [{ name: 'x-private', value: 'CUSTOM-TOKEN' }];
    f.handlers.primary = (_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-upstream-cache': 'MISS',
        'set-cookie': 'RESPONSE-COOKIE',
        'x-echo': 'reserve-SUPER-SECRET',
      });
      res.end(JSON.stringify(answer()));
    };
    const response = await f.post(
      {
        model: 'default',
        messages: [
          {
            role: 'user',
            content: 'Hi DATABASE-PASSWORD primary-SUPER-SECRET reserve-SUPER-SECRET CUSTOM-TOKEN',
          },
        ],
      },
      { 'x-lifemodel-call': 'call-capture-1', 'x-lifemodel-session': 'chat-capture' }
    );
    expect(response.status).toBe(200);
    await response.text();
    await expect.poll(() => f.rows.length).toBe(1);
    expect(f.rows[0]).toMatchObject({
      callId: 'call-capture-1',
      attempt: 1,
      slot: 'primary',
      sessionId: 'chat-capture',
      exchange: {
        upstream: { headers: { 'x-private': '[redacted len=12]' } },
        response: { status: 200, headers: { 'x-upstream-cache': 'MISS' } },
      },
    });
    const exchange = f.rows[0]!.exchange as {
      upstream: { body: string };
      inbound: { body: string };
    };
    expect(JSON.parse(exchange.upstream.body)).toMatchObject({
      reasoning_effort: 'none',
      model: 'primary-model',
    });
    expect(JSON.parse(exchange.inbound.body).model).toBe('default');
    expect(f.attempts[0]?.headers['x-lifemodel-call']).toBeUndefined();
    for (const secret of [
      'INBOUND-PRIVATE',
      'PRIVATE-COOKIE',
      'primary-SUPER-SECRET',
      'reserve-SUPER-SECRET',
      'DATABASE-PASSWORD',
      'CUSTOM-TOKEN',
      'RESPONSE-COOKIE',
    ])
      expect(JSON.stringify(f.rows)).not.toContain(secret);
    f.capture.close();
  });
  it('stores an independent row for failed primary and successful reserve', async () => {
    const f = await captured();
    f.handlers.primary = (_req, res) => {
      res.writeHead(503, { 'x-upstream': 'retry' });
      res.end('unavailable');
    };
    expect((await f.post({}, { 'x-lifemodel-call': 'retry-call' })).status).toBe(400);
    const response = await f.post(undefined, { 'x-lifemodel-call': 'retry-call' });
    await response.text();
    await expect.poll(() => f.rows.length).toBe(2);
    expect(f.rows.map((row) => [row.callId, row.attempt, row.slot])).toEqual([
      ['retry-call', 1, 'primary'],
      ['retry-call', 2, 'reserve'],
    ]);
    expect(f.rows[0]?.exchange.response).toMatchObject({ status: 503, body: 'unavailable' });
    f.capture.close();
  });
  it('does not capture off, expired or another session and captures only the selected session', async () => {
    const f = await captured();
    f.setSetting({ until: null });
    await (await f.post()).text();
    f.setSetting({ until: new Date(Date.now() - 1).toISOString() });
    await (await f.post()).text();
    f.setSetting({ until: new Date(Date.now() + 600_000).toISOString(), session: 'wanted' });
    await (await f.post(undefined, { 'x-lifemodel-session': 'other' })).text();
    await (await f.post(undefined, { 'x-lifemodel-session': 'wanted' })).text();
    await expect.poll(() => f.rows.length).toBe(1);
    expect(f.rows[0]?.sessionId).toBe('wanted');
    f.capture.close();
  });
  it('tees SSE without changing the client answer and captures upstream framing', async () => {
    const f = await captured();
    const sse = `data: ${JSON.stringify({ id: 'stream-1', object: 'chat.completion.chunk', model: 'real', choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
    f.handlers.primary = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-stream': 'yes' });
      res.end(sse);
    };
    const response = await f.post({ model: 'default', messages: [], stream: true });
    expect(await response.text()).toBe(sse);
    await expect.poll(() => f.rows.length).toBe(1);
    expect(f.rows[0]?.exchange.response).toMatchObject({
      body: sse,
      headers: { 'x-stream': 'yes' },
    });
    f.capture.close();
  });
  it('never waits for a hung/full or failing writer and keeps results byte-identical', async () => {
    const f = await captured(async () => new Promise<void>(() => undefined));
    for (let i = 0; i < 12; i++) {
      const response = await f.post();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(answer());
    }
    f.capture.close();
    const failed = await captured(async () => {
      throw new Error('capture_failed');
    });
    expect(await (await failed.post()).json()).toEqual(answer());
    failed.capture.close();
  });
});
