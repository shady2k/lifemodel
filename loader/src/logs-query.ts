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

export interface LogsFilter {
  /** Milliseconds since the epoch, inclusive. */
  readonly from: number;
  /** Milliseconds since the epoch, inclusive. */
  readonly to: number;
  /** An exact module value, or null/absent for every module. */
  readonly module?: string | null;
}

export type LogsRecordsResult =
  | { readonly state: 'ok'; readonly records: readonly LogsRecord[] }
  | LogsUnavailable;

export interface LogsQuery {
  records(filter: LogsFilter): Promise<LogsRecordsResult>;
  modules(): Promise<LogsModulesResult>;
}

/** A LogsQL double-quoted string: quote and backslash escaped. */
export function quoteLogsValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildRecordsQuery(filter: LogsFilter): string {
  const range = `_time:[${new Date(filter.from).toISOString()}, ${new Date(filter.to).toISOString()}]`;
  const moduleFilter =
    filter.module === undefined || filter.module === null || filter.module === ''
      ? ''
      : ` module:=${quoteLogsValue(filter.module)}`;
  return `${range}${moduleFilter} | sort by (_time desc, _msg desc, pod desc) | offset 0 | limit ${String(LOGS_PAGE_SIZE)}`;
}

export function createLogsQuery({ store }: { readonly store: LogsStore }): LogsQuery {
  return {
    records: (filter) => store.query(buildRecordsQuery(filter)),
    modules: () => store.modules(),
  };
}
