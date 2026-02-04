/**
 * Trace Context Module
 *
 * Provides AsyncLocalStorage-based trace context for automatic causal chain tracking.
 *
 * Key Design:
 * - Tick-initiated operations (housekeeping) → tickId is the trace root
 * - Signal-initiated operations (causal chains) → signalId is the trace root
 *
 * This prevents false correlations where unrelated signals processed in the same
 * tick would incorrectly share the same traceId.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Trace context for causal chain tracking.
 * Established per-signal or per-intent, NOT per-tick (except for tick-level housekeeping).
 */
export interface TraceContext {
  /** Root trace ID - typically equals signal.id or intent.id */
  traceId: string;
  /** Batch grouping ID (e.g., all signals from same tick share this) */
  correlationId?: string;
  /** Parent span ID for causal chain tracking */
  parentId?: string;
  /** Current span ID for this operation */
  spanId?: string;
}

const asyncLocalStorage = new AsyncLocalStorage<TraceContext>();

/**
 * Run a function with trace context.
 * All descendant async operations inherit this context automatically.
 *
 * @example
 * ```ts
 * await withTraceContext({ traceId: 'sig_123' }, async () => {
 *   // All logs here automatically get traceId='sig_123'
 *   logger.info('Processing signal');
 * });
 * ```
 */
export function withTraceContext<T>(context: TraceContext, fn: () => T): T {
  return asyncLocalStorage.run(context, fn);
}

/**
 * Get the current trace context (if any).
 * Returns undefined if called outside of any withTraceContext.
 */
export function getTraceContext(): TraceContext | undefined {
  return asyncLocalStorage.getStore();
}

/**
 * Generate a child span ID.
 * Creates hierarchical span IDs for tracing causal chains.
 *
 * @param parent - Optional parent span ID
 * @returns A new span ID (e.g., "root_abc123" or "parent_abc_child_def")
 */
export function generateChildSpan(parent?: string): string {
  const shortId = randomUUID().slice(0, 8);
  return parent ? `${parent}_${shortId}` : `root_${shortId}`;
}

/**
 * Create a new trace context for a signal/intent.
 * The signal/intent ID becomes the root trace ID.
 *
 * @param id - The signal or intent ID (becomes traceId)
 * @param options - Optional correlationId, parentId, and spanId
 * @returns A new TraceContext object
 */
export function createTraceContext(
  id: string,
  options: { correlationId?: string; parentId?: string; spanId?: string } = {}
): TraceContext {
  const result: TraceContext = {
    traceId: id,
    spanId: options.spanId ?? generateChildSpan(),
  };
  if (options.correlationId !== undefined) {
    result.correlationId = options.correlationId;
  }
  if (options.parentId !== undefined) {
    result.parentId = options.parentId;
  }
  return result;
}

/**
 * Extract trace-relevant IDs from an intent for tracing.
 * Used when applying intents to establish proper trace context.
 *
 * @param intent - The intent to extract trace info from
 * @returns Trace context derived from the intent
 */
export function extractTraceFromIntent(
  intent: { trace?: { tickId?: string; parentSignalId?: string } } | undefined
): Pick<TraceContext, 'correlationId' | 'parentId'> | undefined {
  if (!intent?.trace) return undefined;
  const { tickId, parentSignalId } = intent.trace;
  if (!tickId && !parentSignalId) return undefined;

  const result: Pick<TraceContext, 'correlationId' | 'parentId'> = {};
  if (tickId !== undefined) result.correlationId = tickId;
  if (parentSignalId !== undefined) result.parentId = parentSignalId;
  return result;
}
