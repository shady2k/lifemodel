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

/** The page's record bound. Paging is stage 2. */
export const LOGS_PAGE_SIZE = 200;

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

export type LogsFilterAnswer =
  | { readonly state: 'ok'; readonly filter: LogsFilter }
  | { readonly state: 'invalid'; readonly field: LogsFilterField };

export type LogsRecordsResult =
  | { readonly state: 'ok'; readonly records: readonly LogsRecord[] }
  | LogsUnavailable;

export interface LogsQuery {
  records(filter: LogsFilter): Promise<LogsRecordsResult>;
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

export function buildRecordsQuery(filter: LogsFilter): string {
  const range = `_time:[${new Date(filter.from).toISOString()}, ${new Date(filter.to).toISOString()}]`;
  const filters: string[] = [];
  const module = filter.module ?? '';
  if (module !== '') filters.push(`module:=${quoteLogsValue(module)}`);
  const level = filter.level ?? '';
  if (level !== '') filters.push(`level:=${quoteLogsValue(level)}`);
  const conversationId = filter.conversationId ?? '';
  if (conversationId !== '') filters.push(`conversation_id:=${quoteLogsValue(conversationId)}`);
  const text = filter.text ?? '';
  if (text !== '') filters.push(`_msg:${quoteLogsValue(text)}`);
  const query = [range, ...filters].join(' ');
  return `${query} | sort by (_time desc, _msg desc, pod desc) | offset 0 | limit ${String(LOGS_PAGE_SIZE)}`;
}

export function createLogsQuery({ store }: { readonly store: LogsStore }): LogsQuery {
  return {
    records: (filter) => store.query(buildRecordsQuery(filter)),
    modules: () => store.modules(),
  };
}
