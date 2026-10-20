/**
 * The storage module's health answers (ADR-015 S-D7).
 *
 * Ready means SeaweedFS answered with valid auth. A stopped store, a refused
 * credential or a missing record each keep their own reason and make the
 * module unready; the module is ready again only when the store answers again.
 * Liveness is the process, never the store.
 */
import { describe, expect, it } from 'vitest';
import { createStorageHealth, type StoreCheck } from '../../loader/src/storage-health.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';

function fixture(initial: StoreCheck = { ok: true }) {
  const lines: RecordedLine[] = [];
  const answers: StoreCheck[] = [initial];
  let clock = Date.parse('2026-10-20T10:00:00.000Z');
  const health = createStorageHealth({
    bucket: 'lifemodel-storage',
    check: async () =>
      answers.length > 1 ? (answers.shift() as StoreCheck) : (answers[0] as StoreCheck),
    logger: createRecordingLogger(lines),
    now: () => clock,
    cacheMs: 0,
    boundMs: 50,
  });
  return {
    health,
    lines,
    answer(next: StoreCheck) {
      answers.unshift(next);
    },
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe('the storage module health answer', () => {
  it('is ready and healthy while the store answers with valid auth', async () => {
    const f = fixture();
    const answer = await f.health.evaluate();
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      state: 'ok',
      store: 'seaweedfs',
      bucket: 'lifemodel-storage',
      lastErrorCode: null,
      lastCheckedAt: '2026-10-20T10:00:00.000Z',
      lastSuccessAt: '2026-10-20T10:00:00.000Z',
      outageSeconds: null,
    });
  });

  it('is unready with the store down, and names the store down rather than empty', async () => {
    const f = fixture({ ok: false, code: 'unreachable' });
    const answer = await f.health.evaluate();
    expect(answer.status).toBe(503);
    expect(answer.body.state).toBe('down');
    expect(answer.body.lastErrorCode).toBe('unreachable');
    expect(answer.body.lastSuccessAt).toBeNull();
    // A failed store is never a successful empty listing.
    expect(JSON.stringify(answer.body)).not.toContain('"state":"ok"');
    expect(f.lines.filter((line) => line.level === 'warn')).toHaveLength(1);
    expect(f.lines[0]?.fields).toEqual({ code: 'unreachable' });
  });

  it.each(['auth_denied', 'bucket_missing', 'unexpected', 'credentials_unavailable'] as const)(
    'keeps %s its own reason and logs it once while it lasts',
    async (code) => {
      const f = fixture({ ok: false, code });
      await f.health.evaluate();
      await f.health.evaluate();
      await f.health.evaluate();
      expect(f.health.body().lastErrorCode).toBe(code);
      expect(f.lines.filter((line) => line.level === 'warn')).toHaveLength(1);
      expect(f.lines[0]?.fields).toEqual({ code });
    }
  );

  it('becomes healthy again when the store returns, and reports the outage it saw', async () => {
    const f = fixture({ ok: false, code: 'auth_denied' });
    expect((await f.health.evaluate()).status).toBe(503);
    f.advance(30_000);
    f.answer({ ok: true });
    const answer = await f.health.evaluate();
    expect(answer.status).toBe(200);
    expect(answer.body.state).toBe('ok');
    expect(answer.body.lastErrorCode).toBeNull();
    expect(answer.body.outageSeconds).toBeNull();
    expect(f.lines.filter((line) => line.level === 'info')).toEqual([
      { level: 'info', fields: { outageSeconds: 30 }, message: expect.any(String) },
    ]);
    // And back down again: the module follows the store both ways.
    f.answer({ ok: false, code: 'unreachable' });
    expect((await f.health.evaluate()).status).toBe(503);
    expect(f.health.body().lastErrorCode).toBe('unreachable');
  });

  it('reports unknown, and no readiness, before the first answer', () => {
    const f = fixture();
    expect(f.health.body()).toMatchObject({
      state: 'unknown',
      lastErrorCode: null,
      lastCheckedAt: null,
      lastSuccessAt: null,
    });
  });

  it('treats a check that throws as an unreachable store', async () => {
    const lines: RecordedLine[] = [];
    const health = createStorageHealth({
      bucket: 'lifemodel-storage',
      check: async () => {
        throw new Error('socket hang up');
      },
      logger: createRecordingLogger(lines),
      cacheMs: 0,
    });
    const answer = await health.evaluate();
    expect(answer.status).toBe(503);
    expect(answer.body.lastErrorCode).toBe('unreachable');
  });

  it('answers within its bound while a slow check is still running', async () => {
    const lines: RecordedLine[] = [];
    let settle: (() => void) | undefined;
    const health = createStorageHealth({
      bucket: 'lifemodel-storage',
      check: () =>
        new Promise<StoreCheck>((resolve) => {
          settle = () => {
            resolve({ ok: false, code: 'unreachable' });
          };
        }),
      logger: createRecordingLogger(lines),
      cacheMs: 0,
      boundMs: 20,
    });
    const answer = await health.evaluate();
    // No answer in time: the module is not ready, and it says why.
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ state: 'down', lastErrorCode: 'timeout' });
    settle?.();
  });

  it('answers from the last check inside its cache window', async () => {
    const lines: RecordedLine[] = [];
    let checks = 0;
    const health = createStorageHealth({
      bucket: 'lifemodel-storage',
      check: async () => {
        checks++;
        return { ok: true };
      },
      logger: createRecordingLogger(lines),
      cacheMs: 2_000,
    });
    await health.evaluate();
    await health.evaluate();
    await health.evaluate();
    expect(checks).toBe(1);
  });
});

describe('the storage module health deadline', () => {
  interface Step {
    ok: boolean;
    code?: 'unreachable' | 'auth_denied' | 'bucket_missing' | 'unexpected';
  }
  /**
   * A check driven by the test: it answers the next scripted result, or holds
   * until released. Every call records the signal it was given.
   */
  function scripted() {
    const lines: RecordedLine[] = [];
    const signals: AbortSignal[] = [];
    const queue: Array<Step | 'stall'> = [];
    const held: Array<() => void> = [];
    let calls = 0;
    const health = createStorageHealth({
      bucket: 'lifemodel-storage',
      check: (signal) => {
        calls++;
        signals.push(signal);
        const next = queue.shift() ?? { ok: true };
        if (next === 'stall')
          return new Promise<StoreCheck>((resolve) => {
            held.push(() => {
              resolve({ ok: false, code: 'unreachable' });
            });
          });
        return Promise.resolve(
          next.ok ? { ok: true } : { ok: false, code: next.code ?? 'unreachable' }
        );
      },
      logger: createRecordingLogger(lines),
      cacheMs: 0,
      boundMs: 20,
    });
    return {
      health,
      lines,
      signals,
      get calls() {
        return calls;
      },
      script(...steps: Array<Step | 'stall'>) {
        queue.push(...steps);
      },
      release() {
        for (const settle of held.splice(0)) settle();
      },
    };
  }

  it('turns unhealthy when a healthy check passes its deadline, and healthy again when it answers', async () => {
    const f = scripted();
    f.script({ ok: true }, 'stall', { ok: true });
    expect((await f.health.evaluate()).status).toBe(200);
    const stalled = await f.health.evaluate();
    expect(stalled.status).toBe(503);
    expect(stalled.body).toMatchObject({ state: 'down', lastErrorCode: 'timeout' });
    // The check that missed the deadline is cancelled, not left running.
    expect(f.signals.at(-1)?.aborted).toBe(true);
    // A late answer from that check never overwrites the deadline outcome.
    f.release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(f.health.body()).toMatchObject({ state: 'down', lastErrorCode: 'timeout' });
    const recovered = await f.health.evaluate();
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({ state: 'ok', lastErrorCode: null });
  });

  it('answers every concurrent caller with the deadline outcome and starts one check', async () => {
    const f = scripted();
    f.script('stall');
    const [first, second] = await Promise.all([f.health.evaluate(), f.health.evaluate()]);
    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    expect(first.body.lastErrorCode).toBe('timeout');
    expect(f.calls).toBe(1);
    f.release();
  });

  it('never lets an obsolete late completion replace newer health', async () => {
    const f = scripted();
    f.script('stall', { ok: true });
    expect((await f.health.evaluate()).status).toBe(503);
    expect((await f.health.evaluate()).status).toBe(200);
    // The stalled first check now answers: it is obsolete and changes nothing.
    f.release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(f.health.body()).toMatchObject({ state: 'ok', lastErrorCode: null });
  });

  it('logs the deadline once, and recovery after it', async () => {
    const f = scripted();
    f.script('stall', 'stall', { ok: true });
    await f.health.evaluate();
    await f.health.evaluate();
    expect(f.lines.filter((line) => line.level === 'warn')).toEqual([
      { level: 'warn', fields: { code: 'timeout' }, message: expect.any(String) },
    ]);
    await f.health.evaluate();
    expect(f.lines.filter((line) => line.level === 'info')).toEqual([
      { level: 'info', fields: { outageSeconds: 0 }, message: expect.any(String) },
    ]);
    f.release();
  });
});

/**
 * A deterministic scheduler: one clock, and timers that only run when the test
 * advances past their due time, in due order. No wall clock, no polling.
 */
function clockwork() {
  let clock = 0;
  let nextId = 0;
  const scheduled = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => clock,
    timers: {
      set: ((callback: () => void, ms?: number) => {
        const id = ++nextId;
        scheduled.set(id, { at: clock + Number(ms ?? 0), callback });
        return id;
      }) as unknown as typeof setTimeout,
      clear: ((id: number) => {
        scheduled.delete(id);
      }) as unknown as typeof clearTimeout,
    },
    async advance(ms: number): Promise<void> {
      const target = clock + ms;
      for (;;) {
        const due = [...scheduled.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (due === undefined) break;
        scheduled.delete(due[0]);
        clock = Math.max(clock, due[1].at);
        due[1].callback();
        // Let the health code's continuations run before the next timer.
        await Promise.resolve();
        await Promise.resolve();
      }
      clock = target;
    },
  };
}

describe('the storage module health deadline ownership', () => {
  it('never lets a late caller of an expired check cancel the check that replaced it', async () => {
    const time = clockwork();
    const signals: AbortSignal[] = [];
    // An abort-insensitive store check: held until the test answers it.
    const held: Array<(result: StoreCheck) => void> = [];
    const health = createStorageHealth({
      bucket: 'lifemodel-storage',
      check: (signal) => {
        signals.push(signal);
        return new Promise<StoreCheck>((resolve) => {
          held.push(resolve);
        });
      },
      logger: createRecordingLogger([]),
      now: time.now,
      timers: time.timers,
      // The production cache and bound: 2 s and 3 s.
    });

    const first = health.evaluate(); // check 1
    await time.advance(2_500);
    const joined = health.evaluate(); // a caller that joins check 1
    await time.advance(500); // 3 s: check 1 misses its deadline
    expect((await first).status).toBe(503);
    expect(signals[0]?.aborted).toBe(true);
    expect(health.body()).toMatchObject({ state: 'down', lastErrorCode: 'timeout' });

    await time.advance(2_100); // 5.1 s: past the 2 s cache, so a new check starts
    const replacement = health.evaluate(); // check 2
    expect(signals).toHaveLength(2);

    // The late caller of check 1 reaches its own old deadline here. It may
    // only report its own check's outcome: check 2 is still running and must
    // neither be aborted nor have its result discarded.
    await time.advance(450);
    expect(signals[1]?.aborted).toBe(false);

    held[1]?.({ ok: true }); // check 2 answers successfully
    const recovered = await replacement;
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({ state: 'ok', lastErrorCode: null });

    held[0]?.({ ok: false, code: 'unreachable' }); // check 1 answers late
    expect((await joined).status).toBe(503);
    expect(health.body()).toMatchObject({ state: 'ok', lastErrorCode: null });
  });

  it('cannot be expired by the deadline of a check that already answered', async () => {
    const time = clockwork();
    const signals: AbortSignal[] = [];
    const held: Array<(result: StoreCheck) => void> = [];
    let answerImmediately = true;
    const health = createStorageHealth({
      bucket: 'lifemodel-storage',
      check: (signal) => {
        signals.push(signal);
        if (answerImmediately) {
          answerImmediately = false;
          return Promise.resolve({ ok: true });
        }
        return new Promise<StoreCheck>((resolve) => {
          held.push(resolve);
        });
      },
      logger: createRecordingLogger([]),
      now: time.now,
      timers: time.timers,
    });

    expect((await health.evaluate()).status).toBe(200); // check 1 answers at t=0
    await time.advance(2_100); // past the 2 s cache
    const second = health.evaluate(); // check 2, its own deadline at 5.1 s
    expect(signals).toHaveLength(2);
    // 3 s: when check 1's deadline would have been. It already answered, so it
    // cannot expire the check that replaced it.
    await time.advance(900);
    expect(signals[1]?.aborted).toBe(false);
    expect(health.body()).toMatchObject({ state: 'ok', lastErrorCode: null });
    // 5.1 s: check 2's own deadline.
    await time.advance(2_100);
    expect((await second).status).toBe(503);
    expect(signals[1]?.aborted).toBe(true);
    held[0]?.({ ok: true });
  });
});
