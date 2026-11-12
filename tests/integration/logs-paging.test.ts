/**
 * The logs page's paging protocol (ADR-016 §4, L15).
 *
 * Every answer here is a recorded answer of the pinned VictoriaLogs image,
 * captured by `scripts/check-logs-paging.mjs` after 5,000 records were written
 * at one timestamp and 300 byte-identical lines at another. The isolated test
 * boundary has no Docker and no pinned store, so the boundary replays these
 * recorded answers; the same script runs this walk against the live pinned
 * store on a host that has Docker, which is where the store really answers.
 *
 * The page is read in two steps when the window is longer than the page
 * reaches: a `_time`-only query finds the record at the page's last position,
 * and the ordered query reads down to that record's own `_time`. The recorded
 * answers hold both queries of every page, so a reader can see the form the
 * store answered and the page it returned.
 *
 * The late-insert case is two recordings of one store: the quiet window, read
 * before one record arrived, and the same window after it arrived.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogsStore, type LogsRecord } from '../../loader/src/logs-store-adapter.js';
import {
  createLogsQuery,
  type LogsFilter,
  type LogsPage,
  type LogsQuery,
} from '../../loader/src/logs-query.js';
import { startLogsStoreFixture, type LogsStoreFixture } from '../helpers/logs-store-fixture.js';

const FROM = Date.parse('2026-11-07T09:00:00.000Z');
const TO = Date.parse('2026-11-07T11:00:00.000Z');
const RANGE =
  '_time:[2026-11-07T09:00:00.000Z, 2026-11-07T11:00:00.000Z] NOT (module:="throttle-window" AND NOT untrusted:*)';
const ORDER = '| sort by (_time desc, _msg desc, pod desc)';
const BOUNDARY_ORDER = '| sort by (_time desc) |';
const COUNT_QUERY = `${RANGE} | stats count()`;
const FILTER: LogsFilter = { from: FROM, to: TO };

/** The records the pinned store held: 5,000 distinct lines at one time. */
const BULK_RECORDS = 5000;
/** And 300 byte-identical lines at another: same time, message, pod and stream. */
const IDENTICAL_RECORDS = 300;
/** One late record, newest in the window, written after the first page was read. */
const LATE_MESSAGE = 'zzzz late arrival';
const WINDOW_RECORDS = BULK_RECORDS + IDENTICAL_RECORDS;
const PAGE_SIZE = 250;

const fixtures: LogsStoreFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

async function recorded(name: string): Promise<{ fixture: LogsStoreFixture; logs: LogsQuery }> {
  const fixture = await startLogsStoreFixture(name);
  fixtures.push(fixture);
  return { fixture, logs: createLogsQuery({ store: createLogsStore({ url: fixture.url }) }) };
}

/** The store's own answer to each query of one fixture file, by its text. */
function answersOf(name: string): Map<string, string> {
  const file = JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8')
  ) as { exchanges: { request: { query: string }; body: string }[] };
  return new Map(file.exchanges.map(({ request, body }) => [request.query, body]));
}

/** A record's identity: what a reader can tell one stored line from another by. */
function identity(record: LogsRecord): string {
  return [
    record.time,
    record.message,
    record.fields['pod'] ?? '',
    record.fields['stream'] ?? '',
  ].join('\u0000');
}

/** Every record of these pages, counted by identity: a repeat or a skip shows. */
function counted(records: readonly LogsRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) {
    const key = identity(record);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** The window the store held before anything else arrived in it. */
function expectedWindow(): Map<string, number> {
  const counts = new Map<string, number>();
  for (let index = 0; index < BULK_RECORDS; index += 1) {
    counts.set(
      `2026-11-07T10:00:00Z\u0000bulk ${String(index).padStart(5, '0')}\u0000bulk-0\u0000stdout`,
      1
    );
  }
  counts.set(
    `2026-11-07T10:30:00Z\u0000identical line\u0000ident-0\u0000stdout`,
    IDENTICAL_RECORDS
  );
  return counts;
}

function recordsOf(pages: readonly LogsPage[]): LogsRecord[] {
  return pages.flatMap((page) => [...page.records]);
}

/** The offset a query's page bound names, or null when it names none. */
function offsetOf(query: string): number | null {
  const match = /\| offset (\d+) \| limit (\d+)$/u.exec(query);
  return match === null ? null : Number(match[1]);
}

/** The `_time` a boundary answer holds: the one record the query read. */
function boundaryTime(answer: string | undefined): string | null {
  const line = (answer ?? '').split('\n').find((candidate) => candidate.trim() !== '');
  if (line === undefined) return null;
  const time = (JSON.parse(line) as { _time?: unknown })._time;
  return typeof time === 'string' ? time : null;
}

/** The lower time bound a query filters on. */
function rangeStart(query: string): string | null {
  return /^_time:\[([^,]+), /u.exec(query)?.[1] ?? null;
}

describe('paging a quiet log window', () => {
  it('reads every record exactly once, at the same window and in the same order', async () => {
    const { fixture, logs } = await recorded('logs-paging-quiet.json');
    const pages: LogsPage[] = [];
    let expected: number | null = null;
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await logs.page({ filter: FILTER, offset, limit: PAGE_SIZE, expected });
      if (page.state !== 'ok') throw new Error(page.reason);
      pages.push(page);
      expect(page.offset).toBe(offset);
      expect(page.limit).toBe(PAGE_SIZE);
      expect(page.count).toBe(WINDOW_RECORDS);
      expect(page.incomplete).toBe(false);
      expected = page.count;
      if (page.records.length < PAGE_SIZE) break;
    }

    // 5,305 records in pages of 250: 21 full pages and one of 55.
    expect(pages).toHaveLength(Math.ceil(WINDOW_RECORDS / PAGE_SIZE));
    expect(pages.at(-1)?.records).toHaveLength(WINDOW_RECORDS % PAGE_SIZE);

    // Every record exactly once: the multiset of pages is the multiset of the
    // window, so no record is repeated and none is skipped.
    expect(counted(recordsOf(pages))).toEqual(expectedWindow());

    // One window for every page: its end was fixed at the first page, and its
    // start is the first page's or the `_time` a boundary query answered with.
    const queries = fixture.requests.map(({ query }) => query);
    for (const query of queries) {
      expect(query.startsWith('_time:[')).toBe(true);
      expect(query).toContain(', 2026-11-07T11:00:00.000Z]');
    }
    const reads = queries.filter((query) => query.includes(`${ORDER} | offset`));
    const boundary = queries.filter((query) => query.includes(BOUNDARY_ORDER));
    expect(reads.map(offsetOf)).toEqual(pages.map((_page, index) => index * PAGE_SIZE));
    // Every page: the window's count, then its boundary, then its records, then
    // the count again. The last page holds fewer records than the page reaches,
    // so it has none.
    expect(queries).toEqual(
      pages.flatMap((_page, index) => [
        COUNT_QUERY,
        ...(index < pages.length - 1 ? [boundary[index] ?? ''] : []),
        reads[index] ?? '',
        COUNT_QUERY,
      ])
    );
  });

  it('finds each page by the record at its last position, then reads down to it', async () => {
    const { fixture, logs } = await recorded('logs-paging-quiet.json');
    const answers = answersOf('logs-paging-quiet.json');
    const pages: LogsPage[] = [];
    let expected: number | null = null;
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await logs.page({ filter: FILTER, offset, limit: PAGE_SIZE, expected });
      if (page.state !== 'ok') throw new Error(page.reason);
      pages.push(page);
      expected = page.count;
      if (page.records.length < PAGE_SIZE) break;
    }

    const queries = fixture.requests.map(({ query }) => query);
    const reads = queries.filter((query) => query.includes(`${ORDER} | offset`));
    const boundary = queries.filter((query) => query.includes(BOUNDARY_ORDER));
    // Every page but the last reaches past the window, so every page but the
    // last is found by its boundary; the last reads the window as it is.
    expect(boundary).toHaveLength(pages.length - 1);
    expect(boundary.map(offsetOf)).toEqual(
      pages.slice(0, -1).map((_page, index) => (index + 1) * PAGE_SIZE - 1)
    );
    expect(boundary.every((query) => query.endsWith('| limit 1'))).toBe(true);

    for (const [index, read] of reads.entries()) {
      const page = pages[index];
      if (page === undefined) throw new Error('the fixture has no such page');
      if (index === reads.length - 1) {
        // The last page holds fewer records than the page reaches.
        expect(rangeStart(read)).toBe('2026-11-07T09:00:00.000Z');
        continue;
      }
      const found = boundary[index];
      if (found === undefined) throw new Error('the fixture has no boundary for this page');
      expect(answers.get(found)).toBeDefined();
      expect(rangeStart(read)).toBe(boundaryTime(answers.get(found)));
      // Every record of the page is at or after the boundary's time.
      for (const record of page.records) {
        expect(Date.parse(record.time)).toBeGreaterThanOrEqual(
          Date.parse(boundaryTime(answers.get(found)) ?? '')
        );
      }
    }
  });

  it('returns the same bytes for the same page read twice', async () => {
    const { logs } = await recorded('logs-paging-quiet.json');
    const first = await logs.page({
      filter: FILTER,
      offset: 500,
      limit: PAGE_SIZE,
      expected: WINDOW_RECORDS,
    });
    const second = await logs.page({
      filter: FILTER,
      offset: 500,
      limit: PAGE_SIZE,
      expected: WINDOW_RECORDS,
    });
    if (first.state !== 'ok' || second.state !== 'ok') throw new Error('the page did not answer');
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.records).toHaveLength(PAGE_SIZE);
  });
});

describe('a page after the first', () => {
  it('does not claim completeness without the first page count', async () => {
    const { logs } = await recorded('logs-paging-quiet.json');
    const page = await logs.page({
      filter: FILTER,
      offset: PAGE_SIZE,
      limit: PAGE_SIZE,
      expected: null,
    });
    if (page.state !== 'ok') throw new Error(page.reason);
    expect(page.count).toBe(WINDOW_RECORDS);
    expect(page.incomplete).toBe(true);
  });
});

describe('a record arriving while the reader scrolls', () => {
  it('marks the next page incomplete and shows the arrival after a refresh', async () => {
    const before = await recorded('logs-paging-quiet.json');
    const first = await before.logs.page({
      filter: FILTER,
      offset: 0,
      limit: PAGE_SIZE,
      expected: null,
    });
    if (first.state !== 'ok') throw new Error(first.reason);
    expect(first.count).toBe(WINDOW_RECORDS);
    expect(first.incomplete).toBe(false);

    // The store now holds one more record, newest in the window. This is a
    // second recording of the same window, taken after the insert.
    const after = await recorded('logs-paging-late.json');
    const next = await after.logs.page({
      filter: FILTER,
      offset: PAGE_SIZE,
      limit: PAGE_SIZE,
      expected: first.count,
    });
    if (next.state !== 'ok') throw new Error(next.reason);
    expect(next.count).toBe(WINDOW_RECORDS + 1);
    expect(next.incomplete).toBe(true);

    // What the flag reports: the offset moved, so one record of the first
    // page is read again on the next one, and the record that arrived is on
    // neither of them.
    const read = [...first.records, ...next.records];
    expect(
      counted(read).get(`2026-11-07T10:30:00Z\u0000identical line\u0000ident-0\u0000stdout`)
    ).toBe(IDENTICAL_RECORDS + 1);
    expect(read.some((record) => record.message === LATE_MESSAGE)).toBe(false);

    // The refresh the page offers is the first page read again: it names the
    // arrival and the window's new count, and starts a page sequence that
    // agrees with itself.
    const refreshed = await after.logs.page({
      filter: FILTER,
      offset: 0,
      limit: PAGE_SIZE,
      expected: null,
    });
    if (refreshed.state !== 'ok') throw new Error(refreshed.reason);
    expect(refreshed.count).toBe(WINDOW_RECORDS + 1);
    expect(refreshed.incomplete).toBe(false);
    expect(refreshed.records[0]?.message).toBe(LATE_MESSAGE);
  });
});
