/**
 * The logs page's status (ADR-016 §4, §5; check L14).
 *
 * Every state comes from `tests/fixtures/logs-status/states.json`: what the
 * collector's two heartbeats, the store's read-only gauge, the evictor's
 * CronJob and the evictor's own lines answer at one moment, and what the page
 * must then say. The heartbeats are the two records the collector writes every
 * 30 s (the adapter's `heartbeats()`); the store and the evictor are stubs.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COLLECTION_STOPPED_MS,
  EVICTOR_STALE_MS,
  createLogsStatus,
  logDayOf,
  type LogsEvictorStatus,
  type LogsStatusSources,
} from '../../loader/src/logs-status.js';
import type { LogsEviction } from '../../loader/src/logs-store-adapter.js';

interface StatusCase {
  readonly name: string;
  readonly heartbeat: { readonly process: string | null; readonly podLog: string | null };
  readonly heartbeatKnown?: boolean;
  readonly readOnly: boolean;
  readonly readOnlyKnown: boolean;
  readonly evictorLastSuccess: string | null;
  readonly evictorKnown: boolean;
  readonly evictions: readonly LogsEviction[];
  readonly expect: {
    readonly collection: 'live' | 'stopped' | 'unknown';
    readonly stoppedForMs: number | null;
    readonly storeReadOnly: boolean | null;
    readonly evictorStale: boolean | null;
    readonly evictions: readonly string[];
  };
}

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../fixtures/logs-status/states.json', import.meta.url)),
    'utf8'
  )
) as {
  readonly now: string;
  readonly window: { readonly from: string; readonly to: string };
  readonly cases: readonly StatusCase[];
  readonly description: string;
};

const WINDOW = { from: Date.parse(fixture.window.from), to: Date.parse(fixture.window.to) };
const NOW = Date.parse(fixture.now);

function sourcesOf(state: StatusCase): LogsStatusSources {
  const unavailable = { state: 'unavailable' as const, reason: 'http_error' as const, status: 500 };
  return {
    store: {
      heartbeats: async () =>
        state.heartbeatKnown === false
          ? unavailable
          : { state: 'ok', process: state.heartbeat.process, podLog: state.heartbeat.podLog },
      readOnly: async () =>
        state.readOnlyKnown ? { state: 'ok', readOnly: state.readOnly } : unavailable,
      evictions: async () => ({ state: 'ok', evictions: state.evictions }),
    },
    evictor: {
      lastSuccessAt: async () => {
        if (!state.evictorKnown) throw new Error('the CronJob could not be read');
        return state.evictorLastSuccess;
      },
    } satisfies LogsEvictorStatus,
    now: () => NOW,
  };
}

describe('the logs page status (ADR-016 §4, §5)', () => {
  it.each(fixture.cases.map((entry) => [entry.name, entry] as const))(
    '%s',
    async (_name, state) => {
      const status = await createLogsStatus(sourcesOf(state)).read(WINDOW);
      expect(status.collection).toEqual({
        state: state.expect.collection,
        stoppedForMs: state.expect.stoppedForMs,
      });
      expect(status.storeReadOnly).toBe(state.expect.storeReadOnly);
      expect(status.evictor.stale).toBe(state.expect.evictorStale);
      expect(status.evictor.lastSuccessAt).toBe(state.evictorLastSuccess);
      expect(status.evictions.map((line) => line.time)).toEqual(state.expect.evictions);
    }
  );

  it('says a running collector is live, so a healthy page shows no line', () => {
    const healthy = fixture.cases.find((entry) => entry.name === 'healthy-collector');
    expect(healthy?.expect.collection).toBe('live');
    expect(healthy?.expect.stoppedForMs).toBeNull();
    expect(healthy?.expect.storeReadOnly).toBe(false);
    expect(healthy?.expect.evictorStale).toBe(false);
    // The healthy window shows only the eviction inside it, as a notice.
    expect(healthy?.expect.evictions).toEqual(['2026-11-07T09:55:00Z']);
  });

  it('never blames the evictor for a refusal between two runs', () => {
    const caseName = 'refusal-between-runs-blames-nobody';
    const state = fixture.cases.find((entry) => entry.name === caseName);
    expect(state?.expect.storeReadOnly).toBe(true);
    expect(state?.expect.evictorStale).toBe(false);
  });

  it('keeps the thresholds the ADR fixes: 90 s and two minute-long runs', () => {
    expect(COLLECTION_STOPPED_MS).toBe(90_000);
    expect(EVICTOR_STALE_MS).toBe(120_000);
  });

  it('names a day the way the store names a partition', () => {
    expect(logDayOf(Date.parse('2026-11-07T23:59:59.999Z'))).toBe('20261107');
    expect(logDayOf(Date.parse('2026-11-08T00:00:00.000Z'))).toBe('20261108');
  });
});
