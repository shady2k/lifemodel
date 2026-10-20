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
    // No answer yet: the module is not ready, and it did not invent one.
    expect(answer.status).toBe(503);
    expect(answer.body.state).toBe('unknown');
    expect(answer.body.lastErrorCode).toBeNull();
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
