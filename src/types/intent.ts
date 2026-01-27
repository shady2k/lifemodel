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
  | 'SCHEDULE_EVENT'
  | 'SEND_MESSAGE'
  | 'CANCEL_EVENT'
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
  | ScheduleEventIntent
  | SendMessageIntent
  | CancelEventIntent
  | LogIntent
  | EmitMetricIntent;
