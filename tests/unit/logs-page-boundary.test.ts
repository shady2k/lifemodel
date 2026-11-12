/**
 * A page read in two steps is the page the single full sort returns (ADR-016
 * §4, L15).
 *
 * A flood puts more than a million records in the page's hour, and the
 * three-key sort reads and compares every message in the window to order it:
 * measured at 4.94 s over 1.68 million records, against 0.16 s for a
 * `_time`-only sort of the same window. The page therefore finds the time of
 * the record at its last position with the cheap `_time`-only query, and reads
 * the ordered window only down to that time. This file holds the equality that
 * makes the shorter read the same page: the fixture's records share times, so
 * the boundary falls inside a group of ties, on a later page and on the last
 * page of the window.
 *
 * Every answer comes from `tests/helpers/logs-model-store.ts`, an in-memory
 * evaluation of the query forms `logs-query.ts` builds; the pinned store's own
 * bytes are in the recorded fixtures (`logs-paging-*.json`), which
 * `scripts/check-logs-paging.mjs` captures against the real store.
 */
import { describe, expect, it } from 'vitest';
import type { LogsRecord } from '../../loader/src/logs-store-adapter.js';
import {
  buildBoundaryQuery,
  buildCountQuery,
  buildRecordsQuery,
  createLogsQuery,
  type LogsFilter,
  type LogsPageBound,
} from '../../loader/src/logs-query.js';
import { createModelLogsStore } from '../helpers/logs-model-store.js';

const BASE = Date.parse('2026-11-09T18:00:00.000Z');
const FILTER: LogsFilter = { from: BASE - 60_000, to: BASE + 60_000 };

function record(time: string, message: string, pod: string): LogsRecord {
  return { time, message, fields: { module: 'core', level: 'info', pod } };
}

/** 5 records at distinct times, 20 at one time (the ties), 60 older and distinct. */
function fixture(): LogsRecord[] {
  const newest = Array.from({ length: 5 }, (_, index) =>
    record(
      new Date(BASE + 5_000 + index).toISOString(),
      `newest ${String(index).padStart(2, '0')}`,
      `pod-${String(index % 2)}`
    )
  );
  // Second precision, as the store prints a whole second: the page must carry
  // the boundary record's own `_time` and not a reformatted one.
  const ties = Array.from({ length: 20 }, (_, index) =>
    record(
      '2026-11-09T18:00:01Z',
      `tie ${String(index).padStart(2, '0')}`,
      `pod-${String(index % 2)}`
    )
  );
  const older = Array.from({ length: 60 }, (_, index) =>
    record(
      new Date(BASE + 500 - index).toISOString(),
      `older ${String(index).padStart(2, '0')}`,
      'pod-0'
    )
  );
  return [...newest, ...ties, ...older];
}

const RECORDS = fixture();
const WINDOW_RECORDS = RECORDS.length;

/** The page one full three-key sort over the whole window returns. */
function fullSortPage(model: ReturnType<typeof createModelLogsStore>, page: LogsPageBound) {
  return model.recordsOf(buildRecordsQuery(FILTER, page));
}

const PAGES: LogsPageBound[] = [
  { offset: 0, limit: 10 },
  { offset: 5, limit: 20 },
  { offset: 10, limit: 10 },
  { offset: 20, limit: 10 },
  { offset: 40, limit: 25 },
];

describe('a page whose boundary falls inside a group of ties', () => {
  it('returns the records the single full sort returns', async () => {
    for (const page of PAGES) {
      const model = createModelLogsStore(RECORDS);
      const logs = createLogsQuery({ store: model.store });
      const answer = await logs.page({
        filter: FILTER,
        offset: page.offset,
        limit: page.limit,
        expected: null,
      });
      if (answer.state !== 'ok') throw new Error(answer.reason);
      expect(answer.records).toEqual(fullSortPage(model, page));
      expect(answer.count).toBe(WINDOW_RECORDS);
    }
  });

  it('finds the boundary with the cheap query, then reads down to its time', async () => {
    for (const page of PAGES) {
      const model = createModelLogsStore(RECORDS);
      const logs = createLogsQuery({ store: model.store });
      const answer = await logs.page({
        filter: FILTER,
        offset: page.offset,
        limit: page.limit,
        expected: null,
      });
      if (answer.state !== 'ok') throw new Error(answer.reason);

      const boundary = fullSortPage(model, { offset: page.offset + page.limit - 1, limit: 1 })[0];
      if (boundary === undefined) throw new Error('the fixture has no boundary record');

      expect(model.queries.map(({ kind }) => kind)).toEqual([
        'count',
        'query',
        'query',
        'count',
      ]);
      expect(model.queries[0]?.logsql).toBe(buildCountQuery(FILTER));
      expect(model.queries[1]?.logsql).toBe(buildBoundaryQuery(FILTER, page));
      expect(model.queries[2]?.logsql).toBe(buildRecordsQuery(FILTER, page, boundary.time));
      // The boundary query orders by time alone and reads one record.
      expect(model.queries[1]?.logsql).toBe(
        `${buildCountQuery(FILTER).replace(' | stats count()', '')} | sort by (_time desc) | offset ${String(page.offset + page.limit - 1)} | limit 1`
      );
      // Every record of the page is at or after the boundary's time.
      for (const record of answer.records)
        expect(Date.parse(record.time)).toBeGreaterThanOrEqual(Date.parse(boundary.time));
    }
  });

  it('is the same page when read twice', async () => {
    const model = createModelLogsStore(RECORDS);
    const logs = createLogsQuery({ store: model.store });
    const page: LogsPageBound = { offset: 10, limit: 10 };
    const first = await logs.page({
      filter: FILTER,
      offset: page.offset,
      limit: page.limit,
      expected: WINDOW_RECORDS,
    });
    const second = await logs.page({
      filter: FILTER,
      offset: page.offset,
      limit: page.limit,
      expected: WINDOW_RECORDS,
    });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe("a window smaller than the page's reach", () => {
  it('reads the window as it is, with no boundary query', async () => {
    const model = createModelLogsStore(RECORDS);
    const logs = createLogsQuery({ store: model.store });
    // 85 records and a page reaching 250: nothing to narrow.
    const page: LogsPageBound = { offset: 0, limit: 250 };
    const answer = await logs.page({
      filter: FILTER,
      offset: page.offset,
      limit: page.limit,
      expected: null,
    });
    if (answer.state !== 'ok') throw new Error(answer.reason);
    expect(answer.records).toEqual(fullSortPage(model, page));
    expect(answer.records).toHaveLength(WINDOW_RECORDS);
    expect(model.queries.map(({ logsql }) => logsql)).toEqual([
      buildCountQuery(FILTER),
      buildRecordsQuery(FILTER, page),
      buildCountQuery(FILTER),
    ]);
  });

  it('reads the last page of the window as it is', async () => {
    const model = createModelLogsStore(RECORDS);
    const logs = createLogsQuery({ store: model.store });
    const page: LogsPageBound = { offset: 80, limit: 10 };
    const answer = await logs.page({
      filter: FILTER,
      offset: page.offset,
      limit: page.limit,
      expected: WINDOW_RECORDS,
    });
    if (answer.state !== 'ok') throw new Error(answer.reason);
    expect(answer.records).toEqual(fullSortPage(model, page));
    expect(answer.records).toHaveLength(WINDOW_RECORDS - 80);
    expect(model.queries.map(({ logsql }) => logsql)).toEqual([
      buildCountQuery(FILTER),
      buildRecordsQuery(FILTER, page),
      buildCountQuery(FILTER),
    ]);
  });

  it('answers an offset past the end with the window read as it is', async () => {
    const model = createModelLogsStore(RECORDS);
    const logs = createLogsQuery({ store: model.store });
    const page: LogsPageBound = { offset: 100, limit: 10 };
    const answer = await logs.page({
      filter: FILTER,
      offset: page.offset,
      limit: page.limit,
      expected: WINDOW_RECORDS,
    });
    if (answer.state !== 'ok') throw new Error(answer.reason);
    expect(answer.records).toEqual([]);
    expect(answer.count).toBe(WINDOW_RECORDS);
    expect(model.queries.map(({ logsql }) => logsql)).toEqual([
      buildCountQuery(FILTER),
      buildRecordsQuery(FILTER, page),
      buildCountQuery(FILTER),
    ]);
  });
});

describe('a page of a window that holds one record', () => {
  it('is that record, read as it is', async () => {
    const only = [record('2026-11-09T18:00:00.000Z', 'the only line', 'pod-0')];
    const model = createModelLogsStore(only);
    const logs = createLogsQuery({ store: model.store });
    const answer = await logs.page({ filter: FILTER, offset: 0, limit: 10, expected: null });
    if (answer.state !== 'ok') throw new Error(answer.reason);
    expect(answer.records).toEqual(only);
    expect(model.queries.map(({ logsql }) => logsql)).toEqual([
      buildCountQuery(FILTER),
      buildRecordsQuery(FILTER, { offset: 0, limit: 10 }),
      buildCountQuery(FILTER),
    ]);
  });
});
