/**
 * The loader's log query form (ADR-016 §4).
 *
 * This file builds LogsQL from the page's fields; the store's endpoint, record
 * fields and metric names stay in `logs-store-adapter.ts`. A caller's string
 * becomes a quoted, escaped field value, never query syntax, and there is no
 * path from a request to a raw query.
 */
import type {
  LogsModulesResult,
  LogsRecord,
  LogsStore,
  LogsUnavailable,
} from './logs-store-adapter.js';

/** The page's record bound, and the largest page a request may ask for. */
export const LOGS_PAGE_SIZE = 200;
export const LOGS_PAGE_SIZE_MAX = 1000;

/** The closed set of levels the collector writes (ADR-016 §2). */
export const LOGS_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'unknown'] as const;
export type LogsLevel = (typeof LOGS_LEVELS)[number];

/** The bound on each field's value, so one request cannot become a giant query. */
export const LOGS_MODULE_MAX_LENGTH = 128;
export const LOGS_CONVERSATION_MAX_LENGTH = 128;
export const LOGS_TEXT_MAX_LENGTH = 256;

export interface LogsFilter {
  /** Milliseconds since the epoch, inclusive. */
  readonly from: number;
  /** Milliseconds since the epoch, inclusive. */
  readonly to: number;
  /** An exact module value, or null/absent for every module. */
  readonly module?: string | null;
  /** An exact level, or null/absent for every level. */
  readonly level?: LogsLevel | null;
  /** An exact conversation id, or null/absent for every conversation. */
  readonly conversationId?: string | null;
  /** A phrase searched in the message text, or null/absent for no search. */
  readonly text?: string | null;
}

/** The request parameter a refused filter is named by. */
export type LogsFilterField = 'from' | 'to' | 'module' | 'level' | 'conversation_id' | 'text';

/** The request parameters that place the cursor, refused the same way. */
export type LogsPageField = 'offset' | 'limit' | 'expected';

export type LogsFilterAnswer =
  | { readonly state: 'ok'; readonly filter: LogsFilter }
  | { readonly state: 'invalid'; readonly field: LogsFilterField };

/** Where a page starts in the ordered window, and how much of it it reads. */
export interface LogsPageBound {
  readonly offset: number;
  readonly limit: number;
}

/**
 * One page's request. `expected` carries the window's record count as the
 * first page read it, so a later page can tell whether records arrived since;
 * the first page has no such count and reports none.
 */
export interface LogsPageRequest extends LogsPageBound {
  readonly filter: LogsFilter;
  readonly expected: number | null;
}

/**
 * One page of the window as of the first page. `incomplete` says the window's
 * count changed since then - or while this page read its records - so the
 * offset may repeat or skip a record; the answer never claims every record
 * exactly once.
 */
export interface LogsPage {
  readonly state: 'ok';
  readonly records: readonly LogsRecord[];
  readonly offset: number;
  readonly limit: number;
  /** The window's record count as the page's last read saw it. */
  readonly count: number;
  readonly incomplete: boolean;
}

export type LogsPageAnswer = LogsPage | LogsUnavailable;

export type LogsPageQueryAnswer =
  | { readonly state: 'ok'; readonly request: LogsPageRequest }
  | { readonly state: 'invalid'; readonly field: LogsFilterField | LogsPageField };

export interface LogsQuery {
  page(request: LogsPageRequest): Promise<LogsPageAnswer>;
  modules(): Promise<LogsModulesResult>;
}

/** The largest time value JavaScript's Date can represent, in milliseconds. */
const MAX_DATE_MS = 8_640_000_000_000_000;

/** A LogsQL double-quoted string: quote and backslash escaped. */
export function quoteLogsValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function isLogsLevel(value: string): value is LogsLevel {
  return (LOGS_LEVELS as readonly string[]).includes(value);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function timeOf(raw: string | null): number {
  return raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
}

function validTime(value: number): boolean {
  return Number.isInteger(value) && Math.abs(value) <= MAX_DATE_MS;
}

function textOf(params: URLSearchParams, name: string): string {
  return params.get(name) ?? '';
}

/**
 * The page's fields as a filter, or the request parameter that cannot be
 * queried. No caller's string goes further than a quoted field value.
 */
export function parseLogsFilter(params: URLSearchParams): LogsFilterAnswer {
  const from = timeOf(params.get('from'));
  const to = timeOf(params.get('to'));
  if (!validTime(from) || (validTime(to) && from > to)) return { state: 'invalid', field: 'from' };
  if (!validTime(to)) return { state: 'invalid', field: 'to' };
  const module = textOf(params, 'module');
  if (module.length > LOGS_MODULE_MAX_LENGTH || hasControlCharacter(module))
    return { state: 'invalid', field: 'module' };
  const level = textOf(params, 'level');
  if (level !== '' && !isLogsLevel(level)) return { state: 'invalid', field: 'level' };
  const conversationId = textOf(params, 'conversation_id');
  if (conversationId.length > LOGS_CONVERSATION_MAX_LENGTH || hasControlCharacter(conversationId))
    return { state: 'invalid', field: 'conversation_id' };
  const text = textOf(params, 'text');
  if (text.length > LOGS_TEXT_MAX_LENGTH || hasControlCharacter(text))
    return { state: 'invalid', field: 'text' };
  return {
    state: 'ok',
    filter: {
      from,
      to,
      module: module === '' ? null : module,
      level: level === '' ? null : level,
      conversationId: conversationId === '' ? null : conversationId,
      text: text === '' ? null : text,
    },
  };
}

/**
 * The window and the field filters, without any ordering or page bound. A
 * caller that has read a boundary record's own `_time` passes it, so the store
 * filters on the time string it printed instead of one the loader reformatted.
 */
function filterClause(filter: LogsFilter, earliestTime: string | null = null): string {
  const from = earliestTime ?? new Date(filter.from).toISOString();
  const range = `_time:[${from}, ${new Date(filter.to).toISOString()}]`;
  const filters: string[] = [];
  const module = filter.module ?? '';
  if (module !== '') filters.push(`module:=${quoteLogsValue(module)}`);
  const level = filter.level ?? '';
  if (level !== '') filters.push(`level:=${quoteLogsValue(level)}`);
  const conversationId = filter.conversationId ?? '';
  if (conversationId !== '') filters.push(`conversation_id:=${quoteLogsValue(conversationId)}`);
  const text = filter.text ?? '';
  if (text !== '') filters.push(`_msg:${quoteLogsValue(text)}`);
  return [range, ...filters].join(' ');
}

/**
 * The record at the page's last position, by time alone: the page's boundary.
 *
 * The three-key sort reads and compares every message in the window to order
 * it (measured: 4.94 s over 1.68 million records, against 0.16 s for a
 * `_time`-only sort). This query orders by time, which the store keeps in
 * blocks, so it stays cheap however large the window is, and reads one record.
 */
export function buildBoundaryQuery(
  filter: LogsFilter,
  page: LogsPageBound = { offset: 0, limit: LOGS_PAGE_SIZE }
): string {
  const last = page.offset + page.limit - 1;
  return `${filterClause(filter)} | sort by (_time desc) | offset ${String(last)} | limit 1`;
}

/**
 * One page of the window, ordered by time, message and pod: the pod key keeps
 * two different records that share a time and a message in one order.
 *
 * `earliestTime` is the `_time` the boundary query answered with. Every record
 * the full order puts in the page's positions has that time or a later one, so
 * reading down to it returns the same page from a much smaller read; a record
 * that ties at the boundary time is inside the range, so no tie is split.
 */
export function buildRecordsQuery(
  filter: LogsFilter,
  page: LogsPageBound = { offset: 0, limit: LOGS_PAGE_SIZE },
  earliestTime: string | null = null
): string {
  return `${filterClause(filter, earliestTime)} | sort by (_time desc, _msg desc, pod desc) | offset ${String(page.offset)} | limit ${String(page.limit)}`;
}

/** The window's record count: what tells a later page that records arrived. */
export function buildCountQuery(filter: LogsFilter): string {
  return `${filterClause(filter)} | stats count()`;
}

function wholeNumber(raw: string, fallback: number): number | null {
  if (raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** The page's filter, cursor, bound and the count it expects to still hold. */
export function parseLogsPageQuery(params: URLSearchParams): LogsPageQueryAnswer {
  const parsed = parseLogsFilter(params);
  if (parsed.state !== 'ok') return parsed;
  const limit = wholeNumber(textOf(params, 'limit'), LOGS_PAGE_SIZE);
  if (limit === null || limit < 1 || limit > LOGS_PAGE_SIZE_MAX)
    return { state: 'invalid', field: 'limit' };
  const offset = wholeNumber(textOf(params, 'offset'), 0);
  if (offset === null) return { state: 'invalid', field: 'offset' };
  const rawExpected = textOf(params, 'expected');
  const expected = rawExpected.trim() === '' ? null : wholeNumber(rawExpected, 0);
  if (rawExpected.trim() !== '' && expected === null)
    return { state: 'invalid', field: 'expected' };
  return { state: 'ok', request: { filter: parsed.filter, offset, limit, expected } };
}

export function createLogsQuery({ store }: { readonly store: LogsStore }): LogsQuery {
  return {
    async page(request) {
      const page: LogsPageBound = { offset: request.offset, limit: request.limit };
      // The window's count first: one aggregation over the window, cheap at any
      // size (measured: 0.025 s over 1.68 million records), and it decides how
      // the page's records are read. The page reports the recount below.
      const count = await store.count(buildCountQuery(request.filter));
      if (count.state !== 'ok') return count;
      // A later page without the first page's count cannot tell whether
      // records arrived since, so it does not claim completeness either.
      const changed =
        request.expected === null ? request.offset > 0 : count.count !== request.expected;
      const answer = (records: readonly LogsRecord[], latest: number): LogsPage => ({
        state: 'ok',
        records,
        offset: request.offset,
        limit: request.limit,
        count: latest,
        incomplete: changed || latest !== count.count,
      });
      const read = async (logsql: string): Promise<LogsPageAnswer> => {
        const records = await store.query(logsql);
        if (records.state !== 'ok') return records;
        // The count above was read before these records, and a line that
        // arrived in between moved every position after its own: this page can
        // repeat a record and omit the window's oldest while that count still
        // matches the first page's, so the answer would claim to be complete
        // and offer no more. The recount after the read is what sees it - one
        // more cheap aggregation, about what the first one cost.
        const after = await store.count(buildCountQuery(request.filter));
        if (after.state !== 'ok') return after;
        return answer(records.records, after.count);
      };
      // Fewer records than the page reaches: the window as it is, in one read.
      // Its last position is the window's oldest record, which bounds nothing,
      // so this is the one page the boundary cannot shorten.
      if (count.count < request.offset + request.limit)
        return read(buildRecordsQuery(request.filter, page));
      // Otherwise the order is by time first, so the record at the page's last
      // position bounds every record the page can hold. Its `_time`, read by
      // the cheap time-only sort, starts the ordered read (ADR-016 §4, L15).
      // A boundary that races away is read as the whole window, as above.
      const boundary = await store.query(buildBoundaryQuery(request.filter, page));
      if (boundary.state !== 'ok') return boundary;
      const earliest = boundary.records[0]?.time ?? null;
      return read(buildRecordsQuery(request.filter, page, earliest));
    },
    modules: () => store.modules(),
  };
}
