/**
 * Intent types - what the agent wants to do.
 *
 * Rules don't mutate state directly. They return intents
 * that the core collects, validates, and applies.
 */

/**
 * All possible intent types.
 */
export type IntentType =
  | 'UPDATE_STATE'
  | 'UPDATE_USER_MODEL'
  | 'SAVE_TO_MEMORY'
  | 'SCHEDULE_EVENT'
  | 'SEND_MESSAGE'
  | 'CANCEL_EVENT'
  | 'ACK_SIGNAL'
  | 'DEFER_SIGNAL'
  | 'LOG'
  | 'EMIT_METRIC';

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
}

/**
 * Update user model (beliefs about user).
 */
export interface UpdateUserModelIntent {
  type: 'UPDATE_USER_MODEL';
  payload: {
    /** Chat ID for the user */
    chatId?: string | undefined;
    /** Field to update */
    field: string;
    /** New value */
    value: unknown;
    /** Confidence in this update (0-1) */
    confidence: number;
    /** Source of evidence */
    source: string;
    /** Supporting evidence */
    evidence?: string | undefined;
  };
}

/**
 * Save to memory (fact, thought, observation).
 */
export interface SaveToMemoryIntent {
  type: 'SAVE_TO_MEMORY';
  payload: {
    /** Type of memory entry */
    type: 'fact' | 'thought' | 'observation';
    /** Chat ID context */
    chatId?: string | undefined;
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
}

/**
 * Send a message through a channel.
 */
export interface SendMessageIntent {
  type: 'SEND_MESSAGE';
  payload: {
    /** Channel to send through (e.g., "telegram") */
    channel: string;
    /** Message content */
    text: string;
    /** Optional: target (user ID, chat ID) */
    target?: string;
    /** Optional: reply to message ID */
    replyTo?: string;
  };
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
}

/**
 * Acknowledge a signal (marks it as handled).
 * Used to indicate COGNITION has processed a signal.
 */
export interface AckSignalIntent {
  type: 'ACK_SIGNAL';
  payload: {
    /** The signal type being acknowledged */
    signalType: string;
    /** Optional: specific source (e.g., neuron.contact_pressure) */
    source?: string;
    /** Why it's being acknowledged */
    reason: string;
  };
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
}

/**
 * Union of all intent types.
 */
export type Intent =
  | UpdateStateIntent
  | UpdateUserModelIntent
  | SaveToMemoryIntent
  | ScheduleEventIntent
  | SendMessageIntent
  | CancelEventIntent
  | AckSignalIntent
  | DeferSignalIntent
  | LogIntent
  | EmitMetricIntent;
