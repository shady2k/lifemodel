/**
 * Signal types for the 4-layer architecture.
 *
 * Signals are the universal language of the agent's nervous system.
 * Everything that enters the brain is a signal - whether from:
 * - Sensory organs (channels like Telegram, Discord)
 * - Internal neurons (monitoring state like energy, social debt)
 * - Pattern detectors (aggregation layer observations)
 *
 * Like the biological nervous system:
 * - Ear hears sound → emits neural signal
 * - Telegram receives message → emits signal
 * - Internal neuron monitors energy → emits signal when it changes
 *
 * All processing works on signals. Unified model, no separate "events".
 */

import type { Priority } from './priority.js';

/**
 * Signal types - what the signal represents.
 *
 * Categories:
 * - Sensory: from external world via channels (user_message, channel_*)
 * - Internal: from state-monitoring neurons (social_debt, energy, etc.)
 * - Meta: from aggregation layer (pattern_break, threshold_crossed)
 */
export type SignalType =
  // === SENSORY (from channels - our "senses") ===
  | 'user_message' // User sent a message (the "sound" we heard)
  | 'channel_connected' // Channel came online (sense is working)
  | 'channel_disconnected' // Channel went offline (sense stopped)
  | 'channel_error' // Channel had an error (sense malfunction)

  // === INTERNAL (from state-monitoring neurons) ===
  | 'social_debt' // Social pressure from lack of interaction
  | 'energy' // Agent's energy level changed
  | 'task_pressure' // Pending tasks pressure
  | 'curiosity' // Agent's desire to engage
  | 'acquaintance' // Pressure to learn user's name
  | 'alertness' // Agent's alertness mode changed
  | 'contact_pressure' // Combined pressure to contact user

  // === TIME (from time-monitoring neuron) ===
  | 'tick' // Regular heartbeat
  | 'hour_changed' // New hour started
  | 'time_of_day' // Morning/afternoon/evening/night transition

  // === META (from aggregation layer) ===
  | 'pattern_break' // Detected break in expected pattern
  | 'threshold_crossed' // Some threshold was exceeded
  | 'novelty'; // Something unusual detected

/**
 * Signal sources - which "organ" emitted the signal.
 *
 * Format: category.specific_source
 *
 * Categories:
 * - sense.*: Sensory organs (channels)
 * - neuron.*: Internal monitoring neurons
 * - meta.*: Aggregation layer detectors
 */
export type SignalSource =
  // === SENSORY ORGANS (channels) ===
  | 'sense.telegram'
  | 'sense.discord'
  | 'sense.system' // System-level events (startup, shutdown)

  // === INTERNAL NEURONS ===
  | 'neuron.social_debt'
  | 'neuron.energy'
  | 'neuron.task_pressure'
  | 'neuron.curiosity'
  | 'neuron.acquaintance'
  | 'neuron.alertness'
  | 'neuron.contact_pressure'
  | 'neuron.time'

  // === META (aggregation) ===
  | 'meta.pattern_detector'
  | 'meta.threshold_monitor';

/**
 * Signal - structured data emitted by sensory organs and neurons.
 *
 * Like a neural signal in the body:
 * - Carries both measurements (metrics) and content (data)
 * - Has source, type, priority, and expiry
 * - AGGREGATION layer collects signals and decides when to wake COGNITION
 */
export interface Signal {
  /** Unique signal identifier */
  id: string;

  /** What this signal represents */
  type: SignalType;

  /** Which organ/neuron emitted this signal */
  source: SignalSource;

  /** When the signal was emitted */
  timestamp: Date;

  /** Signal priority for routing */
  priority: Priority;

  /** Numeric measurements (0-1 normalized values, rates, etc.) */
  metrics: SignalMetrics;

  /** Signal content/payload (for sensory signals carrying data) */
  data?: SignalData;

  /** When this signal becomes stale (optional per-type TTL) */
  expiresAt?: Date;

  /** Bundle related signals (e.g., all signals from same tick) */
  correlationId?: string;
}

// ============================================================
// Signal Data Types - content carried by different signal types
// ============================================================

/**
 * Union of all signal data types.
 */
export type SignalData =
  | UserMessageData
  | ChannelStatusData
  | TimeData
  | ThresholdData
  | PatternData;

/**
 * Data for user_message signals.
 * Carries the actual message content from the sensory organ.
 */
export interface UserMessageData {
  kind: 'user_message';

  /** The message text */
  text: string;

  /** Chat/conversation ID */
  chatId: string;

  /** User ID (if different from chatId) */
  userId?: string;

  /** Channel the message came from */
  channel: string;

  /** Original message ID (for replies) */
  messageId?: string;

  /** Reply-to message ID (if this is a reply) */
  replyToId?: string;

  /** Detected language (if available) */
  language?: string;
}

/**
 * Data for channel status signals (connected/disconnected/error).
 */
export interface ChannelStatusData {
  kind: 'channel_status';

  /** Channel name */
  channel: string;

  /** Status: connected, disconnected, error */
  status: 'connected' | 'disconnected' | 'error';

  /** Error message (if status is error) */
  error?: string;
}

/**
 * Data for time-related signals.
 */
export interface TimeData {
  kind: 'time';

  /** Current hour (0-23) */
  hour: number;

  /** Time of day category */
  timeOfDay: 'night' | 'morning' | 'afternoon' | 'evening';

  /** Previous hour (for hour_changed) */
  previousHour?: number;

  /** Previous time of day (for time_of_day transition) */
  previousTimeOfDay?: 'night' | 'morning' | 'afternoon' | 'evening';
}

/**
 * Data for threshold_crossed signals.
 */
export interface ThresholdData {
  kind: 'threshold';

  /** Which threshold was crossed */
  thresholdName: string;

  /** The value that crossed the threshold */
  value: number;

  /** The threshold that was crossed */
  threshold: number;

  /** Direction: above or below */
  direction: 'above' | 'below';

  /** Target chat ID for proactive contact */
  chatId?: string | undefined;

  /** Channel to use for proactive contact */
  channel?: string | undefined;
}

/**
 * Data for pattern_break signals.
 */
export interface PatternData {
  kind: 'pattern';

  /** Pattern that broke */
  patternName: string;

  /** Description of the break */
  description: string;

  /** Expected value/behavior */
  expected?: string;

  /** Actual value/behavior */
  actual?: string;
}

/**
 * Signal metrics - the actual measurements.
 *
 * All values are typically 0-1 normalized, but some can be raw counts or times.
 * Each signal type has its own expected metrics.
 */
export interface SignalMetrics {
  /** Primary value (0-1 normalized for most signals) */
  value: number;

  /** Previous value (for change detection) */
  previousValue?: number;

  /** Rate of change (value - previousValue) / time */
  rateOfChange?: number;

  /** Confidence in this measurement (0-1) */
  confidence?: number;

  /** Additional type-specific metrics */
  [key: string]: number | undefined;
}

/**
 * Signal TTL by type (milliseconds).
 *
 * How long each signal type remains valid before becoming stale.
 * null = no expiry (accumulates indefinitely).
 */
export const SIGNAL_TTL: Record<SignalType, number | null> = {
  // Sensory signals - need quick processing
  user_message: 60_000, // 1 minute - user messages are important
  channel_connected: 10_000, // 10 seconds - transient status
  channel_disconnected: 30_000, // 30 seconds - might need attention
  channel_error: 60_000, // 1 minute - errors need handling

  // Internal state signals - varies by type
  social_debt: null, // no expiry, accumulates over time
  energy: 30_000, // 30 seconds - energy changes frequently
  task_pressure: null, // no expiry, accumulates
  curiosity: 60_000, // 1 minute
  acquaintance: null, // no expiry, accumulates
  alertness: 10_000, // 10 seconds - mode changes are transient
  contact_pressure: 30_000, // 30 seconds

  // Time signals - very transient
  tick: 1_000, // 1 second - each tick replaces the last
  hour_changed: 5_000, // 5 seconds - one-time notification
  time_of_day: 60_000, // 1 minute - transition notification

  // Meta signals
  pattern_break: 60_000, // 1 minute - patterns need attention
  threshold_crossed: 30_000, // 30 seconds
  novelty: 30_000, // 30 seconds
};

/**
 * Signal buffer - holds signals for aggregation.
 *
 * Each type+source combo has its own bucket.
 * Aggregation layer processes signals from this buffer.
 */
export interface SignalBuffer {
  /** All signals in the buffer */
  signals: Signal[];

  /** Last flush timestamp */
  lastFlushed: Date;

  /** Total signals ever processed (for metrics) */
  totalProcessed: number;
}

/**
 * Aggregated signal data for a type+source bucket.
 *
 * AGGREGATION layer computes these from raw signals.
 */
export interface SignalAggregate {
  /** Signal type */
  type: SignalType;

  /** Signal source */
  source: SignalSource;

  /** Current aggregated value */
  currentValue: number;

  /** Average rate of change over window */
  rateOfChange: number;

  /** Number of signals in window */
  count: number;

  /** Maximum value seen in window */
  maxValue: number;

  /** Minimum value seen in window */
  minValue: number;

  /** When aggregate was last updated */
  lastUpdated: Date;

  /** Pattern status: stable, increasing, decreasing, volatile */
  trend: 'stable' | 'increasing' | 'decreasing' | 'volatile';
}

/**
 * Create a signal with defaults.
 */
export function createSignal(
  type: SignalType,
  source: SignalSource,
  metrics: SignalMetrics,
  options?: {
    priority?: Priority;
    correlationId?: string;
    data?: SignalData;
  }
): Signal {
  const now = new Date();
  const ttl = SIGNAL_TTL[type];

  return {
    id: crypto.randomUUID(),
    type,
    source,
    timestamp: now,
    priority: options?.priority ?? 2, // Priority.NORMAL = 2
    metrics,
    ...(options?.data && { data: options.data }),
    ...(ttl !== null && { expiresAt: new Date(now.getTime() + ttl) }),
    ...(options?.correlationId && { correlationId: options.correlationId }),
  };
}

/**
 * Create a user message signal (convenience function).
 */
export function createUserMessageSignal(
  data: Omit<UserMessageData, 'kind'>,
  options?: {
    priority?: Priority;
    correlationId?: string;
  }
): Signal {
  const signalOptions: {
    priority: Priority;
    data: UserMessageData;
    correlationId?: string;
  } = {
    priority: options?.priority ?? 1, // Priority.HIGH for user messages
    data: { kind: 'user_message', ...data },
  };

  if (options?.correlationId) {
    signalOptions.correlationId = options.correlationId;
  }

  return createSignal(
    'user_message',
    'sense.telegram', // Default to telegram, can be overridden
    { value: 1, confidence: 1 }, // Message exists = value 1
    signalOptions
  );
}

/**
 * Check if a signal has expired.
 */
export function isSignalExpired(signal: Signal): boolean {
  if (!signal.expiresAt) return false;
  return new Date() > signal.expiresAt;
}

/**
 * Create an empty signal buffer.
 */
export function createSignalBuffer(): SignalBuffer {
  return {
    signals: [],
    lastFlushed: new Date(),
    totalProcessed: 0,
  };
}
