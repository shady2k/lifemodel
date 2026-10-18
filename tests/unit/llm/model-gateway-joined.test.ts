import { createServer, type Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { VercelAIProvider } from '../../../src/plugins/providers/vercel-ai-provider.js';
import { createModelGateway } from '../../../loader/src/model-gateway-app.js';
import { createRecordingLogger } from '../../../loader/src/logger.js';
import type { ModelSlotName, ModelSlot } from '../../../loader/src/model.js';
import { createTestLogger } from '../../helpers/test-logger.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  const ip = Object.values(networkInterfaces())
    .flatMap((v) => v ?? [])
    .find(
      (v) =>
        v.family === 'IPv4' &&
        !v.internal &&
        /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(v.address)
    )?.address;
  if (!ip) throw new Error('no private fixture address');
  return `http://${ip}:${String(address.port)}`;
}
const REQUEST = { role: 'fast' as const, messages: [{ role: 'user' as const, content: 'hello' }] };
type Behavior = 'success' | 'fail' | 'hang';
async function fixture(primary: Behavior, reserve: Behavior) {
  for (const name of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY'])
    delete process.env[name];
  const attempts: ModelSlotName[] = [];
  const started = { primary: latch(), reserve: latch() };
  const closed = { primary: latch(), reserve: latch() };
  const slots = {} as Record<ModelSlotName, ModelSlot>;
  for (const [name, behavior] of [
    ['primary', primary],
    ['reserve', reserve],
  ] as const) {
    const url = await listen(
      createServer(async (req, res) => {
        for await (const _chunk of req) {
          /* drain the provider's request */
        }
        attempts.push(name);
        res.once('close', closed[name].resolve);
        started[name].resolve();
        if (behavior === 'hang') return;
        res.writeHead(behavior === 'fail' ? 500 : 200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            behavior === 'fail'
              ? { error: 'unavailable' }
              : {
                  id: 'joined',
                  object: 'chat.completion',
                  created: 1,
                  model: `${name}-real`,
                  choices: [
                    {
                      index: 0,
                      message: { role: 'assistant', content: `${name} answer` },
                      finish_reason: 'stop',
                    },
                  ],
                  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                }
          )
        );
      })
    );
    slots[name] = { kind: 'openai', baseUrl: `${url}/v1`, model: `${name}-model` };
  }
  // Keep cancelled callbacks so a test can drive even a stale callback after
  // upstream close. That event barrier, not elapsed wall time, proves no slot
  // or request can restart after the provider reports its timeout.
  const callbacks: Array<() => void> = [];
  const active = new Set<ReturnType<typeof setTimeout>>();
  const app = createModelGateway({
    slots: { read: async (name) => slots[name], invalidate: () => {}, keys: () => [] },
    logger: createRecordingLogger([]),
    timers: {
      set: ((fn: () => void) => {
        const handle = { id: callbacks.length } as unknown as ReturnType<typeof setTimeout>;
        callbacks.push(fn);
        active.add(handle);
        return handle;
      }) as typeof setTimeout,
      clear: ((handle: ReturnType<typeof setTimeout>) => {
        active.delete(handle);
      }) as typeof clearTimeout,
    },
  });
  const url = await listen(app.api);
  const provider = new VercelAIProvider(
    { baseUrl: `${url}/v1`, fastModel: 'owner-fast' },
    createTestLogger('silent')
  );
  return {
    provider,
    attempts,
    started,
    closed,
    active,
    driveStaleDeadlines: () => {
      for (const callback of [...callbacks]) callback();
    },
  };
}

describe('real core provider -> real gateway -> primary and reserve', () => {
  it.each(['primary', 'reserve'] as const)(
    'aborts the upstream during the %s leg and never starts later activity',
    async (leg) => {
      const f = await fixture(leg === 'primary' ? 'hang' : 'fail', 'hang');
      const completion = f.provider.complete({ ...REQUEST, timeoutMs: 300 });
      const rejected = expect(completion).rejects.toThrow(/did not answer within 300 ms/);
      await f.started[leg].promise;
      await rejected;
      await f.closed[leg].promise;
      expect(f.attempts).toEqual(leg === 'primary' ? ['primary'] : ['primary', 'reserve']);
      // Disconnect has ended the real gateway handler and cancelled its timers.
      expect(f.active.size).toBe(0);
      f.driveStaleDeadlines();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.attempts).toEqual(leg === 'primary' ? ['primary'] : ['primary', 'reserve']);
    }
  );
  it.each(['primary', 'reserve'] as const)('completes through the %s', async (slot) => {
    const f = await fixture(slot === 'primary' ? 'success' : 'fail', 'success');
    expect((await f.provider.complete(REQUEST)).content).toBe(`${slot} answer`);
    expect(f.attempts).toEqual(slot === 'primary' ? ['primary'] : ['primary', 'reserve']);
  });
  it('reports an error when both slots are exhausted, without a core retry', async () => {
    const f = await fixture('fail', 'fail');
    await expect(f.provider.complete(REQUEST)).rejects.toThrow();
    await f.closed.reserve.promise;
    expect(f.attempts).toEqual(['primary', 'reserve']);
  });
});
