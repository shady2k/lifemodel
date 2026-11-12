/**
 * A page recounts the window after its records read (ADR-016 §4).
 *
 * The count is read before the page's records, so a line that arrives between
 * the two reads moves every later position: on the last page of a window it
 * repeats a record and omits the window's oldest, while the count read at the
 * start still matched the first page's, so the page said `count: N,
 * incomplete: false` and offered no more. The recount after the records read is
 * what sees the arrival, and the answer is marked incomplete instead.
 */
import { describe, expect, it } from 'vitest';
import type { LogsRecord, LogsStore } from '../../loader/src/logs-store-adapter.js';
import {
  buildCountQuery,
  buildRecordsQuery,
  createLogsQuery,
  type LogsFilter,
} from '../../loader/src/logs-query.js';
import { createModelLogsStore } from '../helpers/logs-model-store.js';

const BASE = Date.parse('2026-11-09T18:00:00.000Z');
const FILTER: LogsFilter = { from: BASE - 3_600_000, to: BASE + 3_600_000 };

/** 400 records one second apart, newest first: a window of two full pages. */
function window400(): LogsRecord[] {
  return Array.from({ length: 400 }, (_, index) => ({
    time: new Date(BASE - index * 1000).toISOString(),
    message: `line ${String(index).padStart(3, '0')}`,
    fields: { module: 'core', pod: 'pod-0' },
  }));
}

/** The record that arrives inside the window while the page is being read. */
const ARRIVAL: LogsRecord = {
  time: new Date(BASE + 1000).toISOString(),
  message: 'the line that arrived',
  fields: { module: 'core', pod: 'pod-0' },
};

/**
 * The model store over a live window, with the arrival written into it when the
 * page's first record query runs: after the count the page decided on, before
 * the records it reads.
 */
function storeWithLateArrival(live: LogsRecord[]) {
  const model = createModelLogsStore(live);
  let arrived = false;
  const store: LogsStore = {
    ...model.store,
    async query(logsql) {
      if (!arrived) {
        arrived = true;
        live.push(ARRIVAL);
      }
      return model.store.query(logsql);
    },
  };
  return { store, model };
}

describe('a page that reads its records while a line arrives', () => {
  it('marks the last page incomplete, though its count matched the first page', async () => {
    const live = window400();
    const { store } = storeWithLateArrival(live);
    const logs = createLogsQuery({ store });
    const answer = await logs.page({ filter: FILTER, offset: 200, limit: 200, expected: 400 });
    if (answer.state !== 'ok') throw new Error(answer.reason);
    expect(answer.incomplete).toBe(true);
    // The count the page reports is the window as its last read saw it.
    expect(answer.count).toBe(401);
    // What the flag reports: every position moved by one, so the page repeats
    // the last record of page one and drops the window's oldest.
    expect(answer.records[0]).toEqual(window400()[199]);
    expect(answer.records.at(-1)?.message).toBe('line 398');
    expect(answer.records.some((record) => record.message === 'line 399')).toBe(false);
  });

  it('marks a page that read the whole window in one query incomplete too', async () => {
    const live = window400();
    const { store, model } = storeWithLateArrival(live);
    const logs = createLogsQuery({ store });
    // 400 records and a page reaching 500: read as it is, with no boundary.
    const answer = await logs.page({ filter: FILTER, offset: 300, limit: 200, expected: 400 });
    if (answer.state !== 'ok') throw new Error(answer.reason);
    expect(answer.incomplete).toBe(true);
    expect(answer.count).toBe(401);
    expect(model.queries.map(({ kind }) => kind)).toEqual(['count', 'query', 'count']);
  });
});

describe('a page of a window that did not change', () => {
  it('answers complete, after one recount of the same window', async () => {
    const model = createModelLogsStore(window400());
    const logs = createLogsQuery({ store: model.store });
    const answer = await logs.page({ filter: FILTER, offset: 200, limit: 200, expected: 400 });
    if (answer.state !== 'ok') throw new Error(answer.reason);
    expect(answer.incomplete).toBe(false);
    expect(answer.count).toBe(400);
    expect(answer.records).toEqual(
      model.recordsOf(buildRecordsQuery(FILTER, { offset: 200, limit: 200 }))
    );
    // The shape the latency walk depends on, with the recount last: the count,
    // the boundary, the records, then the count again.
    expect(model.queries.map(({ kind }) => kind)).toEqual(['count', 'query', 'query', 'count']);
    expect(
      model.queries.filter(({ kind }) => kind === 'count').map(({ logsql }) => logsql)
    ).toEqual([buildCountQuery(FILTER), buildCountQuery(FILTER)]);
  });

  it('answers a page that read the whole window complete as well', async () => {
    const model = createModelLogsStore(window400());
    const logs = createLogsQuery({ store: model.store });
    const answer = await logs.page({ filter: FILTER, offset: 300, limit: 200, expected: 400 });
    if (answer.state !== 'ok') throw new Error(answer.reason);
    expect(answer.incomplete).toBe(false);
    expect(model.queries.map(({ kind }) => kind)).toEqual(['count', 'query', 'count']);
  });
});
