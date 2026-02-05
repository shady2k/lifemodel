/**
 * Intent types - what the agent wants to do.
 *
 * Rules don't mutate state directly. They return intents
 * that the core collects, validates, and applies.
 */

import type { EvidenceSource } from './cognition.js';

/**
 * All possible intent types.
 */
export type IntentType =
  | 'UPDATE_STATE'
  | 'SAVE_TO_MEMORY'
  | 'SCHEDULE_EVENT'
  | 'SEND_MESSAGE'
  | 'CANCEL_EVENT'
  | 'ACK_SIGNAL'
  | 'DEFER_SIGNAL'
  | 'LOG'
  | 'EMIT_METRIC'
  | 'EMIT_THOUGHT'
  | 'REMEMBER'
  | 'SET_INTEREST';

/**
 * Trace metadata for intent tracking in logs.
 * Allows reconstructing causal chains from log analysis.
 */
export interface IntentTrace {
  /** Tick ID for batch grouping in logs (NOT causal - use parentSignalId for that) */
  tickId?: string | undefined;
  /** Parent signal ID that triggered this intent (causal chain) */
  parentSignalId?: string | undefined;
  /** Tool call ID that produced this intent (if from tool execution) */
  toolCallId?: string | undefined;
}

/**
 * Update agent state.
 */
export interface UpdateStateIntent {
  type: 'UPDATE_STATE';
  payload: {
    /** State key to update */
    key: string;
    /** New value or delta function */
    value: unknown;
    /** If true, value is added to current (for numbers) */
    delta?: boolean;
  };
  /** Trace metadata for log analysis */
  trace?: IntentTrace | undefined;
}

/**
 * Save to memory (fact, thought, observation).
 */
export interface SaveToMemoryIntent {
  type: 'SAVE_TO_MEMORY';
  payload: {
    /** Type of memory entry */
    type: 'fact' | 'thought' | 'observation';
    /** Recipient context */
    recipientId?: string | undefined;
    /** The content to save */
    content?: string | undefined;
    /** Structured fact (if type is 'fact') */
    fact?: {
      subject: string;
      predicate: string;
      object: string;
      source: string;
      evidence?: string | undefined;
      confidence: number;
      ttl?: number | null | undefined;
      tags: string[];
    };
    /** Tags for search */
    tags?: string[] | undefined;
  };
  /** Trace metadata for log analysis */
  trace?: IntentTrace | undefined;
}

/**
 * Schedule a future event.
 */
export interface ScheduleEventIntent {
  type: 'SCHEDULE_EVENT';
  payload: {
    /** Event to schedule */
    event: {
      source: string;
      channel?: string;
      type: string;
      priority: number;
      payload: unknown;
    };
    /** Delay in milliseconds */
    delay: number;
    /** Optional: unique ID to prevent duplicates */
    scheduleId?: string;
  };
  /** Trace metadata for log analysis */
  trace?: IntentTrace | undefined;
}

/**
 * Conversation status for follow-up timing.
 */
export type ConversationStatus = 'active' | 'awaiting_answer' | 'closed' | 'idle';

/**
 * Tool call data for conversation history.
 * Mirrors OpenAI's tool_call format.
 */
export interface IntentToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Tool result data for conversation history.
 */
export interface IntentToolResult {
  tool_call_id: string;
  content: string;
}

/**
 * Send a message through a channel.
 */
export interface SendMessageIntent {
  type: 'SEND_MESSAGE';
  payload: {
    /** Opaque recipient identifier. Core resolves to channel+destination. */
    recipientId: string;
    /** Message content */
    text: string;
    /** Optional: reply to message ID */
    replyTo?: string;
    /** Conversation status for follow-up timing (avoids separate LLM call) */
    conversationStatus?: ConversationStatus;
    /** Tool calls made during this turn (for conversation history) */
    toolCalls?: IntentToolCall[];
    /** Tool results from this turn (for conversation history) */
    toolResults?: IntentToolResult[];
  };
  /** Source that emitted this intent (for attribution/auditing) */
  source?: string;
  /** Trace metadata for log analysis */
  trace?: IntentTrace | undefined;
}

/**
 * Cancel a scheduled event.
 */
export interface CancelEventIntent {
  type: 'CANCEL_EVENT';
  payload: {
    /** Schedule ID to cancel */
    scheduleId: string;
  };
  /** Trace metadata for log analysis */
  trace?: IntentTrace | undefined;
}

/**
 * Acknowledge a signal (marks it as handled).
 * Used to indicate COGNITION has processed a signal.
 */
export interface AckSignalIntent {
  type: 'ACK_SIGNAL';
  payload: {
    /** Specific signal ID being acknowledged (for per-signal tracking) */
    signalId?: string;
    /** The signal type being acknowledged */
    signalType: string;
    /** Optional: specific source (e.g., neuron.contact_pressure) */
    source?: string;
    /** Why it's being acknowledged */
    reason: string;
  };
  /** Trace metadata for log analysis */
  trace?: IntentTrace | undefined;
}

/**
 * Defer a signal (agent decides "not now, but later").
 * Works for any signal type, not just proactive contact.
 */
export interface DeferSignalIntent {
  type: 'DEFER_SIGNAL';
  payload: {
    /** The signal type being deferred */
    signalType: string;
    /** Optional: specific source */
    source?: string;
    /** Delay in milliseconds before reconsidering */
    deferMs: number;
    /** Current value at deferral time (for override detection) */
    valueAtDeferral?: number;
    /** Value increase required to override deferral */
    overrideDelta?: number;
    /** Why the agent is deferring */
    reason: string;
  };
  /** Trace metadata for log analysis */
  trace?: IntentTrace | undefined;
}

/**
 * Log something (for debugging/tracing).
 */
export interface LogIntent {
  type: 'LOG';
  payload: {
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    context?: Record<string, unknown>;
  };
  /** Trace metadata for log analysis */
  trace?: IntentTrace | undefined;
}

/**
 * Emit a metric.
 */
export interface EmitMetricIntent {
  type: 'EMIT_METRIC';
  payload: {
    type: 'gauge' | 'counter' | 'histogram';
    name: string;
    value: number;
    labels?: Record<string, string>;
  };
  /** Trace metadata for log analysis */
  trace?: IntentTrace | undefined;
}

/**
 * Emit a thought signal for processing.
 * Used by COGNITION layer to queue internal thoughts.
 */
export interface EmitThoughtIntent {
  type: 'EMIT_THOUGHT';
  payload: {
    /** The thought content */
    content: string;
    /** What triggered this thought */
    triggerSource: 'conversation' | 'memory' | 'thought' | 'plugin';
    /** Current depth in thought chain */
    depth: number;
    /** ID of root thought in chain */
    rootThoughtId: string;
    /** ID of parent thought (if any) */
    parentThoughtId?: string;
    /** Signal source for the thought */
    signalSource: 'cognition.thought' | 'memory.thought' | 'plugin.thought';
    /** Recipient context for routing and scoped memory search */
    recipientId?: string;
  };
  /** Trace metadata for log analysis */
  trace?: IntentTrace | undefined;
}

/**
 * Remember a fact about the user or any subject.
 * Routes to UserModel for user facts and memory for all facts.
 */
export interface RememberIntent {
  type: 'REMEMBER';
  payload: {
    /** Subject: "user", person name, or topic */
    subject: string;
    /** Attribute/field name (e.g., birthday, preference) */
    attribute: string;
    /** The value to remember */
    value: string;
    /** Confidence level 0-1 */
    confidence: number;
    /** Evidence source */
    source: EvidenceSource;
    /** Supporting evidence/quote */
    evidence?: string | undefined;
    /** Whether this is a user fact (routes to UserModel) */
    isUserFact: boolean;
    /** Recipient context */
    recipientId?: string | undefined;
  };
  /** Trace metadata for log analysis */
  trace?: IntentTrace | undefined;
}

/**
 * Intensity level for interest changes.
 * Maps to numeric deltas in CoreLoop.
 */
export type InterestIntensity =
  | 'strong_positive'
  | 'weak_positive'
  | 'weak_negative'
  | 'strong_negative';

/**
 * Set user interest in a topic.
 * Uses semantic enum for intensity instead of free-form delta strings.
 */
export interface SetInterestIntent {
  type: 'SET_INTEREST';
  payload: {
    /** Topic name in natural language */
    topic: string;
    /** Interest intensity level */
    intensity: InterestIntensity;
    /** Whether user wants urgent alerts on this topic */
    urgent: boolean;
    /** Evidence source */
    source: EvidenceSource;
    /** Recipient context for action tracking */
    recipientId?: string | undefined;
  };
  /** Trace metadata for log analysis */
  trace?: IntentTrace | undefined;
}

/**
 * Union of all intent types.
 */
export type Intent =
  | UpdateStateIntent
  | SaveToMemoryIntent
  | ScheduleEventIntent
  | SendMessageIntent
  | CancelEventIntent
  | AckSignalIntent
  | DeferSignalIntent
  | LogIntent
  | EmitMetricIntent
  | EmitThoughtIntent
  | RememberIntent
  | SetInterestIntent;
