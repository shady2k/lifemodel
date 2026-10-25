/** Disposable execution evidence. It never owns task or tick outcomes. */
export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  component: string;
  startedAt: string;
  endedAt: string | null;
  status: null | 'ok' | 'failed' | 'suppressed';
  attrs: Record<string, unknown>;
}

export interface TraceEvent {
  recordId: string;
  traceId: string;
  spanId: string;
  event: string;
  ts: string;
  fields: Record<string, unknown>;
}

export type TraceRecord = { kind: 'span'; span: TraceSpan } | { kind: 'event'; event: TraceEvent };

export interface TraceWriter {
  /** Synchronous, bounded and fail-open. False means the record was dropped. */
  enqueue(record: TraceRecord): boolean;
  readonly droppedCount: number;
  flush(): Promise<void>;
  /** Stop intake and drain. Optional deadline is absolute Unix milliseconds. */
  close(deadlineMs?: number): Promise<void>;
}
