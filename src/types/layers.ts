/**
 * Layer interfaces for the 4-layer processing architecture.
 *
 * The brain has 4 layers:
 *
 * 1. AUTONOMIC (neurons) - monitors state, emits signals
 *    - Zero LLM cost
 *    - Runs every tick
 *    - Emits signals only when meaningful change detected
 *
 * 2. AGGREGATION (algorithmic) - collects signals, detects patterns
 *    - Zero LLM cost
 *    - Decides when to wake COGNITION
 *    - Manages signal buckets and thresholds
 *
 * 3. COGNITION (fast LLM) - processes aggregated state
 *    - Low LLM cost (fast model)
 *    - Synthesizes thoughts, decides actions
 *    - Escalates to SMART when uncertain
 *
 * 4. SMART (expensive LLM) - complex reasoning
 *    - High LLM cost (smart model)
 *    - Only called when COGNITION is uncertain
 *    - Handles complex questions, composition
 */

import type { Signal, SignalAggregate, SignalType, SignalSource } from './signal.js';
import type { Intent } from './intent.js';
import type { AgentState } from './agent/state.js';

// ============================================================
// Layer Results
// ============================================================

/**
 * Result from AUTONOMIC layer processing.
 */
export interface AutonomicResult {
  /** Signals emitted this tick */
  signals: Signal[];

  /** State intents to apply (energy drain, etc.) */
  intents: Intent[];
}

/**
 * Result from AGGREGATION layer processing.
 */
export interface AggregationResult {
  /** Whether to wake COGNITION layer */
  wakeCognition: boolean;

  /** Reason for waking (if wakeCognition is true) */
  wakeReason?: string;

  /** Aggregated state to pass to COGNITION */
  aggregates: SignalAggregate[];

  /** High-priority signals that triggered wake (if any) */
  triggerSignals: Signal[];

  /** State intents to apply */
  intents: Intent[];
}

/**
 * Result from COGNITION layer processing.
 */
export interface CognitionResult {
  /** Whether to escalate to SMART layer */
  escalateToSmart: boolean;

  /** Why escalating (if escalateToSmart is true) */
  escalationReason?: string;

  /** Confidence in handling this without SMART (0-1) */
  confidence: number;

  /** Generated response (if confident enough) */
  response?: string;

  /** Action intents to execute */
  intents: Intent[];

  /** Context to pass to SMART if escalating */
  smartContext?: SmartContext;
}

/**
 * Result from SMART layer processing.
 */
export interface SmartResult {
  /** Generated response */
  response?: string | undefined;

  /** Action intents to execute */
  intents: Intent[];

  /** Confidence in the response (0-1) */
  confidence: number;
}

// ============================================================
// Layer Contexts
// ============================================================

/**
 * Context passed to COGNITION layer from AGGREGATION.
 */
export interface CognitionContext {
  /** Aggregated signal data */
  aggregates: SignalAggregate[];

  /** High-priority signals that triggered processing */
  triggerSignals: Signal[];

  /** Why COGNITION was woken */
  wakeReason: string;

  /** Current agent state snapshot */
  agentState: AgentState;

  /** Tick correlation ID */
  correlationId: string;
}

/**
 * Context passed to SMART layer from COGNITION.
 */
export interface SmartContext {
  /** Original context from AGGREGATION */
  cognitionContext: CognitionContext;

  /** Why COGNITION is escalating */
  escalationReason: string;

  /** What COGNITION tried and failed */
  attemptedApproach?: string;

  /** COGNITION's partial analysis (if any) */
  partialAnalysis?: string;

  /** Specific question for SMART to answer */
  question?: string;

  /** Failed tool executions (if any) - SMART should not promise these actions succeeded */
  failedTools?: { name: string; error: string }[];
}

// ============================================================
// Layer Interfaces
// ============================================================

/**
 * AUTONOMIC layer interface.
 *
 * Monitors state and emits signals. Like the autonomic nervous system:
 * - Runs continuously (every tick)
 * - Emits signals only when meaningful change detected
 * - Zero LLM cost
 */
export interface AutonomicLayer {
  /** Layer name for logging */
  readonly name: 'autonomic';

  /**
   * Process a tick, checking all neurons for meaningful changes.
   *
   * @param state Current agent state
   * @param incomingSignals Signals from sensory organs (channels)
   * @param correlationId Tick correlation ID for bundling signals
   * @returns Signals emitted by neurons
   */
  process(
    state: AgentState,
    incomingSignals: Signal[],
    correlationId: string
  ): Promise<AutonomicResult> | AutonomicResult;
}

/**
 * AGGREGATION layer interface.
 *
 * Collects signals, detects patterns, decides when to wake COGNITION.
 * Pure algorithmic processing, no LLM.
 */
export interface AggregationLayer {
  /** Layer name for logging */
  readonly name: 'aggregation';

  /**
   * Process signals and decide whether to wake COGNITION.
   *
   * @param signals All signals from this tick (sensory + autonomic)
   * @param state Current agent state (for threshold adjustment)
   * @returns Aggregation result with wake decision
   */
  process(signals: Signal[], state: AgentState): Promise<AggregationResult> | AggregationResult;

  /**
   * Get current aggregates for a signal type.
   */
  getAggregate(type: SignalType, source: SignalSource): SignalAggregate | undefined;

  /**
   * Prune expired signals from buffers.
   */
  prune(): number;
}

/**
 * COGNITION layer interface.
 *
 * Processes aggregated signals using fast LLM.
 * Decides actions or escalates to SMART.
 */
export interface CognitionLayer {
  /** Layer name for logging */
  readonly name: 'cognition';

  /**
   * Process aggregated context and decide on action.
   *
   * @param context Context from AGGREGATION layer
   * @returns Cognition result with response or escalation
   */
  process(context: CognitionContext): Promise<CognitionResult>;
}

/**
 * SMART layer interface.
 *
 * Complex reasoning using expensive LLM.
 * Only called when COGNITION is uncertain.
 */
export interface SmartLayer {
  /** Layer name for logging */
  readonly name: 'smart';

  /**
   * Process escalated context with full reasoning.
   *
   * @param context Context from COGNITION layer
   * @returns Smart result with response
   */
  process(context: SmartContext): Promise<SmartResult>;
}

// ============================================================
// Wake Triggers
// ============================================================

/**
 * Reasons that can wake COGNITION from AGGREGATION.
 */
export type WakeTrigger =
  | 'user_message' // User sent a message (always wake)
  | 'threshold_crossed' // Some pressure threshold crossed
  | 'pattern_break' // Unusual pattern detected
  | 'channel_error' // Channel reported an error
  | 'scheduled' // Scheduled wake (reminder, follow-up)
  | 'forced' // Forced wake (testing, debug)
  | 'thought'; // Internal thought requires processing

/**
 * Configuration for wake thresholds.
 */
export interface WakeThresholdConfig {
  /** Base threshold for contact pressure (default: 0.6) */
  contactPressure: number;

  /** Threshold for social debt alone (default: 0.8) */
  socialDebt: number;

  /** Threshold for energy to affect other thresholds (default: 0.3) */
  lowEnergy: number;

  /** Multiplier when energy is low (default: 1.3) */
  lowEnergyMultiplier: number;

  /** Pattern break sensitivity (0-1, default: 0.5) */
  patternSensitivity: number;
}

/**
 * Default wake threshold configuration.
 */
export const DEFAULT_WAKE_THRESHOLDS: WakeThresholdConfig = {
  contactPressure: 0.35, // Lowered from 0.6 - trigger proactive contact sooner
  socialDebt: 0.5, // Lowered from 0.8 - trigger when debt is moderate
  lowEnergy: 0.3,
  lowEnergyMultiplier: 1.3,
  patternSensitivity: 0.5,
};
