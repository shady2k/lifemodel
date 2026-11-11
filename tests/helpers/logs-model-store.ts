/**
 * The store's ordering, as the loader's own queries ask for it (ADR-016 §4, L15).
 *
 * The isolated boundary has no Docker and no pinned store, so a page's two-step
 * query cannot be compared with the store's single full sort there. This file
 * answers the loader's LogsQL with an in-memory evaluation of exactly the forms
 * `logs-query.ts` builds: the time range and the four field filters, the
 * three-key or `_time`-only sort, `offset`/`limit` and `stats count()`. A test
 * asks the loader for a page and asks this store for the same page as one full
 * sort, and the two answers must be the same records.
 *
 * It is a model of the query form, not of the store: the recorded fixtures
 * (`tests/fixtures/logs-paging-*.json`) hold the pinned store's own bytes and
 * prove the form against the real store where Docker is available
 * (`scripts/check-logs-paging.mjs`).
 */
import type {
  LogsRecord,
  LogsStore,
  LogsStoreResult,
  LogsCountResult,
} from '../../loader/src/logs-store-adapter.js';

/** One query the loader sent, and what this model answered it with. */
export interface ModelQuery {
  readonly logsql: string;
  readonly kind: 'query' | 'count';
}

export interface ModelLogsStore {
  readonly store: LogsStore;
  /** Every query the loader sent, in order. */
  readonly queries: ModelQuery[];
  /** The store's answer to one query form, as a page would read it. */
  readonly recordsOf: (logsql: string) => readonly LogsRecord[];
}

/** A quoted LogsQL value as `quoteLogsValue` writes it. */
function unquote(text: string): string {
  let value = '';
  for (let index = 1; index < text.length - 1; index += 1) {
    const character = text[index] ?? '';
    if (character !== '\\') {
      value += character;
      continue;
    }
    index += 1;
    value += text[index] ?? '';
  }
  return value;
}

const RANGE = /^_time:\[([^,\]]+), ([^\]]+)\](.*)$/u;
const FIELD = / (module|level|conversation_id|_msg):=?("(?:\\.|[^"\\])*")/gu;

interface ParsedFilter {
  readonly from: number;
  readonly to: number;
  readonly tests: readonly ((record: LogsRecord) => boolean)[];
}

function parseFilter(clause: string): ParsedFilter {
  const range = RANGE.exec(clause);
  if (range === null) throw new Error(`the model store cannot read this filter: ${clause}`);
  const from = Date.parse(range[1] ?? '');
  const to = Date.parse(range[2] ?? '');
  if (!Number.isFinite(from) || !Number.isFinite(to))
    throw new Error(`the model store cannot read this range: ${clause}`);
  const tests: ((record: LogsRecord) => boolean)[] = [];
  if (clause.includes('NOT (module:="throttle-window" AND NOT untrusted:*)')) {
    tests.push(
      (record) =>
        record.fields['module'] !== 'throttle-window' || record.fields['untrusted'] !== undefined
    );
  }
  for (const match of (range[3] ?? '')
    .replace(' NOT (module:="throttle-window" AND NOT untrusted:*)', '')
    .matchAll(FIELD)) {
    const field = match[1] ?? '';
    const value = unquote(match[2] ?? '""');
    if (field === '_msg') tests.push((record) => record.message.includes(value));
    else tests.push((record) => record.fields[field] === value);
  }
  return { from, to, tests };
}

/** The sort keys, in the order the query names them; `_msg` and `pod` read the record. */
function keyOf(record: LogsRecord, key: string): string {
  if (key === '_time') return String(Date.parse(record.time)).padStart(16, '0');
  if (key === '_msg') return record.message;
  return record.fields[key] ?? '';
}

function compareKeys(left: LogsRecord, right: LogsRecord, keys: readonly string[]): number {
  for (const key of keys) {
    const a = keyOf(left, key);
    const b = keyOf(right, key);
    if (a === b) continue;
    return a < b ? 1 : -1;
  }
  return 0;
}

const SORT = /^sort by \(([^)]*)\)$/u;
const OFFSET = /^offset (\d+)$/u;
const LIMIT = /^limit (\d+)$/u;

/** The records one ordered query returns, in the query's own order. */
function ordered(pipeline: readonly string[], records: readonly LogsRecord[]): LogsRecord[] {
  const sort = SORT.exec(pipeline[0] ?? '');
  if (sort === null)
    throw new Error(`the model store cannot read this pipeline: ${pipeline.join(' | ')}`);
  const keys = (sort[1] ?? '').split(',').map((key) => key.trim().replace(/ desc$/u, ''));
  const offsetPart = pipeline[1];
  const limitPart = pipeline[2];
  const offsetMatch = offsetPart === undefined ? null : OFFSET.exec(offsetPart);
  const limitMatch = limitPart === undefined ? null : LIMIT.exec(limitPart);
  if (
    (offsetPart !== undefined && offsetMatch === null) ||
    (limitPart !== undefined && limitMatch === null)
  )
    throw new Error(
      `the model store cannot read this page bound: ${String(offsetPart)} | ${String(limitPart)}`
    );
  const order = records.map((record, index) => ({ record, index }));
  order.sort((left, right) => {
    const byKeys = compareKeys(left.record, right.record, keys);
    return byKeys === 0 ? left.index - right.index : byKeys;
  });
  const offset = offsetMatch === null ? 0 : Number(offsetMatch[1]);
  const limit = limitMatch === null ? order.length : Number(limitMatch[1]);
  return order.slice(offset, offset + limit).map(({ record }) => record);
}

function evaluate(logsql: string, records: readonly LogsRecord[]): LogsRecord[] {
  const [clause = '', ...pipeline] = logsql.split(' | ');
  const filter = parseFilter(clause);
  const matching = records.filter(
    (record) =>
      Date.parse(record.time) >= filter.from &&
      Date.parse(record.time) <= filter.to &&
      filter.tests.every((test) => test(record))
  );
  if (pipeline.length === 0) throw new Error(`the model store cannot read this query: ${logsql}`);
  return ordered(pipeline, matching);
}

/** A store that answers the loader's queries with `records`, and remembers each one. */
export function createModelLogsStore(records: readonly LogsRecord[]): ModelLogsStore {
  const queries: ModelQuery[] = [];
  const unavailable = { state: 'unavailable', reason: 'unreachable' } as const;
  const store: LogsStore = {
    async query(logsql): Promise<LogsStoreResult> {
      queries.push({ logsql, kind: 'query' });
      return { state: 'ok', records: evaluate(logsql, records) };
    },
    async count(logsql): Promise<LogsCountResult> {
      queries.push({ logsql, kind: 'count' });
      const [clause = ''] = logsql.split(' | ');
      const filter = parseFilter(clause);
      const count = records.filter(
        (record) =>
          Date.parse(record.time) >= filter.from &&
          Date.parse(record.time) <= filter.to &&
          filter.tests.every((test) => test(record))
      ).length;
      return { state: 'ok', count };
    },
    async modules() {
      return { state: 'ok', modules: [] };
    },
    async retentionFlags() {
      return unavailable;
    },
    async heartbeats() {
      return unavailable;
    },
    async readOnly() {
      return unavailable;
    },
    async evictions() {
      return unavailable;
    },
  };
  return {
    store,
    queries,
    recordsOf: (logsql) => evaluate(logsql, records),
  };
}
