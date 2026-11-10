/**
 * The conversation a turn runs for, and the trace context that carries it
 * (ADR-016 §9 point 4).
 *
 * One rule, used in both places that need it: `CognitionProcessor.process`
 * routes the turn's answer with it, and CoreLoop puts it on the turn's own
 * trace context so that every line the turn writes - its model calls, tool
 * results, warnings and outcome - is stored under the conversation the chat
 * shows. A reply carries its own recipient; a proactive trigger (`thought`,
 * `contact_urge`, a reminder) carries none and falls back to the primary
 * recipient.
 */

import { getPrimaryRecipientId } from '../../core/globals.js';
import { createTraceContext, type TraceContext } from '../../core/trace-context.js';
import type { Signal } from '../../types/signal.js';

/**
 * The conversation a turn runs for. Undefined when the trigger has no recipient
 * and no primary recipient is configured: such a turn has no conversation to
 * log under, and its lines carry none.
 */
export function resolveTurnConversationId(triggerSignal: Signal | undefined): string | undefined {
  if (!triggerSignal) return undefined;
  const data = triggerSignal.data as { recipientId?: unknown } | undefined;
  // A string recipient is the turn's own, exactly as the two call sites read it
  // before this function existed.
  if (typeof data?.recipientId === 'string') return data.recipientId;
  return triggerSignal.type === 'user_message' ? undefined : getPrimaryRecipientId();
}

/**
 * The turn's own trace context: the trigger's trace, its kind, and the
 * conversation it runs for. Established before the turn's work starts, so one
 * assignment reaches all of it; no trigger means the tick-level context, which
 * carries no conversation.
 */
export function createTurnTraceContext(
  triggerSignal: Signal | undefined,
  tickId: string,
  tickContext: TraceContext
): TraceContext {
  if (!triggerSignal) return tickContext;
  const conversationId = resolveTurnConversationId(triggerSignal);
  return createTraceContext(triggerSignal.id, {
    correlationId: tickId,
    triggerType: triggerSignal.type,
    ...(conversationId === undefined ? {} : { conversationId }),
  });
}
