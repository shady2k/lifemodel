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
 * The late-insert case is two recordings of one store: the quiet window, read
 * before one record arrived, and the same window after it arrived.
 */
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
const RANGE = '_time:[2026-11-07T09:00:00.000Z, 2026-11-07T11:00:00.000Z]';
const ORDER = '| sort by (_time desc, _msg desc, pod desc)';
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

/** The paged query each page's records were read with. */
function pageQueries(fixture: LogsStoreFixture): { offset: number; limit: number }[] {
  const pages: { offset: number; limit: number }[] = [];
  for (const { query } of fixture.requests) {
    const match = /\| offset (\d+) \| limit (\d+)$/.exec(query);
    if (match === null) continue;
    pages.push({ offset: Number(match[1]), limit: Number(match[2]) });
  }
  return pages;
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

    // One window for every page: its end was fixed at the first page.
    const pagesRead = pageQueries(fixture);
    expect(pagesRead).toEqual(
      Array.from({ length: pages.length }, (_, index) => ({
        offset: index * PAGE_SIZE,
        limit: PAGE_SIZE,
      }))
    );
    for (const { query } of fixture.requests) {
      expect(query.startsWith(RANGE), query).toBe(true);
      if (!query.includes(ORDER)) expect(query).toBe(COUNT_QUERY);
    }
    // Every page re-read the window's count with one query.
    expect(fixture.requests.filter(({ query }) => query === COUNT_QUERY)).toHaveLength(
      pages.length
    );
  });

  it('returns the same bytes for the same page read twice', async () => {
    const { fixture, logs } = await recorded('logs-paging-quiet.json');
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
