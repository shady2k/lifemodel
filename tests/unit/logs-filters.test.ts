/**
 * The loader's log filters (ADR-016 §2, §4): level, conversation and a text
 * search beside the time range and module. Every answer comes from a recorded
 * store fixture, captured from the pinned store after records were written
 * through the collector's insert protocol; no field here is invented.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createLogsStore, type LogsRecord } from '../../loader/src/logs-store-adapter.js';
import {
  buildRecordsQuery,
  createLogsQuery,
  LOGS_PAGE_SIZE,
  type LogsFilter,
} from '../../loader/src/logs-query.js';
import { startLogsStoreFixture, type LogsStoreFixture } from '../helpers/logs-store-fixture.js';

const FROM = Date.parse('2026-11-07T10:00:00.000Z');
const TO = Date.parse('2026-11-07T11:00:00.000Z');
const RANGE = '_time:[2026-11-07T10:00:00.000Z, 2026-11-07T11:00:00.000Z]';
const ORDER = '| sort by (_time desc, _msg desc, pod desc) | offset 0 | limit 200';
const FILTER: LogsFilter = { from: FROM, to: TO };

const fixtures: LogsStoreFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

async function recorded(): Promise<LogsStoreFixture> {
  const fixture = await startLogsStoreFixture('logs-store-filters.json');
  fixtures.push(fixture);
  return fixture;
}

/** One line per record, so a wrong filter shows which records it returned. */
function lines(records: readonly LogsRecord[]): string[] {
  return records.map(
    (record) =>
      `${record.time} ${record.fields['module'] ?? '?'} ${record.fields['level'] ?? '?'} ${record.fields['conversation_id'] ?? '-'} ${record.message}`
  );
}

/** The page's record query: the last request that orders and bounds records. */
function recordQuery(fixture: LogsStoreFixture): string {
  return fixture.requests.filter(({ query }) => query.includes('| sort by ')).at(-1)?.query ?? '';
}

async function matching(fixture: LogsStoreFixture, filter: LogsFilter): Promise<string[]> {
  const logs = createLogsQuery({ store: createLogsStore({ url: fixture.url }) });
  const result = await logs.page({ filter, offset: 0, limit: LOGS_PAGE_SIZE, expected: null });
  if (result.state !== 'ok') throw new Error(result.reason);
  return lines(result.records);
}

describe('the log filter query form', () => {
  it('builds one quoted, exact-match field filter per filter', () => {
    expect(buildRecordsQuery({ ...FILTER, module: 'core' })).toBe(
      `${RANGE} module:="core" ${ORDER}`
    );
    expect(buildRecordsQuery({ ...FILTER, level: 'warn' })).toBe(`${RANGE} level:="warn" ${ORDER}`);
    expect(buildRecordsQuery({ ...FILTER, conversationId: 'conv_1' })).toBe(
      `${RANGE} conversation_id:="conv_1" ${ORDER}`
    );
    expect(buildRecordsQuery({ ...FILTER, text: 'needle' })).toBe(
      `${RANGE} _msg:"needle" ${ORDER}`
    );
  });

  it('adds every filter, in one order, when all are set', () => {
    expect(
      buildRecordsQuery({
        ...FILTER,
        module: 'core',
        level: 'info',
        conversationId: 'conv_2',
        text: 'needle',
      })
    ).toBe(
      `${RANGE} module:="core" level:="info" conversation_id:="conv_2" _msg:"needle" ${ORDER}`
    );
  });

  it('keeps a phrase and a value with a space inside one quoted value', () => {
    expect(buildRecordsQuery({ ...FILTER, text: 'first bucket' })).toBe(
      `${RANGE} _msg:"first bucket" ${ORDER}`
    );
  });

  it('quotes and escapes a value holding quotes, a backslash and a pipe', async () => {
    const crafted = 'x" OR _msg:"needle | delete \\';
    const built = buildRecordsQuery({ ...FILTER, text: crafted });
    expect(built).toBe(`${RANGE} _msg:"x\\" OR _msg:\\"needle | delete \\\\" ${ORDER}`);

    const fixture = await recorded();
    expect(await matching(fixture, { ...FILTER, text: crafted })).toEqual([]);
    expect(recordQuery(fixture)).toBe(built);
  });

  it('cannot change the query where the unescaped value would match two records', async () => {
    const fixture = await recorded();
    const value = 'x" OR _msg:"needle';
    const escaped = buildRecordsQuery({ ...FILTER, text: value });
    expect(escaped).toBe(`${RANGE} _msg:"x\\" OR _msg:\\"needle" ${ORDER}`);
    expect(await matching(fixture, { ...FILTER, text: value })).toEqual([]);

    // The unescaped concatenation of the same value is a different query, and
    // it does match: this test fails if quoting or escaping is ever dropped.
    const unescaped = `${RANGE} _msg:"${value}" ${ORDER}`;
    expect(unescaped).toBe(`${RANGE} _msg:"x" OR _msg:"needle" ${ORDER}`);
    const store = createLogsStore({ url: fixture.url });
    const injected = await store.query(unescaped);
    if (injected.state !== 'ok') throw new Error(injected.reason);
    expect(lines(injected.records)).toEqual([
      '2026-11-07T10:40:00Z core info conv_2 needle in the second bucket',
      '2026-11-07T10:05:00Z core info conv_1 needle in the first bucket',
    ]);
  });
});

describe('each log filter against the recorded store', () => {
  it('returns the records inside the range alone', async () => {
    const fixture = await recorded();
    expect(await matching(fixture, FILTER)).toHaveLength(10);
    expect(recordQuery(fixture)).toBe(`${RANGE} ${ORDER}`);
  });

  it('returns exactly the records of one module', async () => {
    const fixture = await recorded();
    const records = await matching(fixture, { ...FILTER, module: 'core' });
    expect(records).toEqual([
      '2026-11-07T10:40:00Z core info conv_2 needle in the second bucket',
      '2026-11-07T10:15:00Z core error conv_1 upstream failed after retries',
      '2026-11-07T10:10:00Z core warn conv_1 retrying the upstream call',
      '2026-11-07T10:05:00Z core info conv_1 needle in the first bucket',
    ]);
  });

  it('returns exactly the records of one level', async () => {
    const fixture = await recorded();
    expect(await matching(fixture, { ...FILTER, level: 'warn' })).toEqual([
      '2026-11-07T10:50:00Z core-web warn - the browser said no',
      '2026-11-07T10:25:00Z model-gateway warn conv_2 the reserve answered slowly',
      '2026-11-07T10:10:00Z core warn conv_1 retrying the upstream call',
    ]);
    expect(recordQuery(fixture)).toBe(`${RANGE} level:="warn" ${ORDER}`);
  });

  it('returns exactly the records of one conversation, untrusted ones included', async () => {
    const fixture = await recorded();
    expect(await matching(fixture, { ...FILTER, conversationId: 'conv_1' })).toEqual([
      '2026-11-07T10:30:00Z task-harness debug conv_1 task step one',
      '2026-11-07T10:15:00Z core error conv_1 upstream failed after retries',
      '2026-11-07T10:10:00Z core warn conv_1 retrying the upstream call',
      '2026-11-07T10:05:00Z core info conv_1 needle in the first bucket',
    ]);
    expect(recordQuery(fixture)).toBe(`${RANGE} conversation_id:="conv_1" ${ORDER}`);
  });

  it('returns exactly the records holding the searched text', async () => {
    const fixture = await recorded();
    expect(await matching(fixture, { ...FILTER, text: 'needle' })).toEqual([
      '2026-11-07T10:40:00Z core info conv_2 needle in the second bucket',
      '2026-11-07T10:05:00Z core info conv_1 needle in the first bucket',
    ]);
    expect(await matching(fixture, { ...FILTER, text: 'first bucket' })).toEqual([
      '2026-11-07T10:05:00Z core info conv_1 needle in the first bucket',
    ]);
    expect(recordQuery(fixture)).toBe(`${RANGE} _msg:"first bucket" ${ORDER}`);
  });

  it('returns the intersection when every filter is set', async () => {
    const fixture = await recorded();
    expect(
      await matching(fixture, {
        ...FILTER,
        module: 'core',
        level: 'info',
        conversationId: 'conv_2',
        text: 'needle',
      })
    ).toEqual(['2026-11-07T10:40:00Z core info conv_2 needle in the second bucket']);
    expect(recordQuery(fixture)).toBe(
      `${RANGE} module:="core" level:="info" conversation_id:="conv_2" _msg:"needle" ${ORDER}`
    );
  });

  it('leaves the filter out when its value is empty', async () => {
    const fixture = await recorded();
    await matching(fixture, {
      ...FILTER,
      module: '',
      level: null,
      conversationId: '',
      text: null,
    });
    expect(recordQuery(fixture)).toBe(`${RANGE} ${ORDER}`);
  });
});
