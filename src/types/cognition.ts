/**
 * COGNITION Layer Types
 *
 * Defines the agentic loop output format for the COGNITION layer.
 * COGNITION can think, call tools, update models, and respond.
 *
 * Key features:
 * - Unified "steps" format with traceable parentId chain
 * - Confidence-based gating with per-field risk policies
 * - Structured facts (not raw thoughts) for memory persistence
 * - Tool result linking via step IDs
 */

// ============================================================
// Schema Version
// ============================================================

export const COGNITION_SCHEMA_VERSION = 1;

// ============================================================
// Step Types
// ============================================================

/**
 * Base interface for all steps.
 * Every step has an ID and links to its parent (signal or previous step).
 */
interface BaseStep {
  /** Unique step ID within this loop */
  id: string;

  /** Parent ID - links to signal.id, previous step.id, or tool result ID */
  parentId: string;
}

/**
 * Internal reasoning step.
 * Logged for debugging but NOT persisted to memory.
 */
export interface ThinkStep extends BaseStep {
  type: 'think';
  content: string;
}

/**
 * Tool call step.
 * Execution pauses until tool returns result.
 */
export interface ToolStep extends BaseStep {
  type: 'tool';
  name: ToolName;
  args: Record<string, unknown>;
}

/**
 * Update user model (beliefs about user).
 * Subject to per-field risk policies.
 */
export interface UpdateUserStep extends BaseStep {
  type: 'updateUser';
  field: string;
  value: unknown;
  confidence: number;
  source: EvidenceSource;
  evidence?: string;
}

/**
 * Update agent state.
 * Subject to per-field risk policies.
 */
export interface UpdateAgentStep extends BaseStep {
  type: 'updateAgent';
  field: string;
  operation: 'set' | 'delta';
  value: number;
  confidence: number;
  reason: string;
}

/**
 * Save structured fact to memory.
 * Facts are searchable via memory tools.
 */
export interface SaveFactStep extends BaseStep {
  type: 'saveFact';
  fact: StructuredFact;
}

/**
 * Schedule future event.
 */
export interface ScheduleStep extends BaseStep {
  type: 'schedule';
  delayMs: number;
  event: {
    type: string;
    context: Record<string, unknown>;
  };
}

/**
 * All possible step types.
 */
export type Step =
  | ThinkStep
  | ToolStep
  | UpdateUserStep
  | UpdateAgentStep
  | SaveFactStep
  | ScheduleStep;

// ============================================================
// Terminal States
// ============================================================

/**
 * Respond to user - loop complete.
 */
export interface RespondTerminal {
  type: 'respond';
  text: string;
  parentId: string;
}

/**
 * Escalate to SMART layer - needs deeper reasoning.
 */
export interface EscalateTerminal {
  type: 'escalate';
  reason: string;
  parentId: string;
  context?: Record<string, unknown>;
}

/**
 * No action needed - loop complete.
 */
export interface NoActionTerminal {
  type: 'noAction';
  reason: string;
  parentId: string;
}

/**
 * Defer a signal - loop complete, but will reconsider later.
 *
 * Used when agent decides "not now, but later" - this prevents
 * reconsidering the same decision every tick. The deferral can be
 * overridden by significant value increase.
 *
 * Works for any signal type (proactive contact, pattern breaks, etc.)
 */
export interface DeferTerminal {
  type: 'defer';
  /** Signal type being deferred (e.g., 'contact_urge', 'pattern_break') */
  signalType: string;
  /** Why the agent is deferring */
  reason: string;
  /** Hours to defer (2-8 typical) */
  deferHours: number;
  /** Parent step ID */
  parentId: string;
}

/**
 * Waiting for tool result - loop paused.
 */
export interface NeedsToolResultTerminal {
  type: 'needsToolResult';
  stepId: string;
}

/**
 * All possible terminal states.
 */
export type Terminal =
  | RespondTerminal
  | EscalateTerminal
  | NoActionTerminal
  | DeferTerminal
  | NeedsToolResultTerminal;

// ============================================================
// Main Output
// ============================================================

/**
 * Complete COGNITION output for one iteration.
 */
export interface CognitionOutput {
  /** Schema version for forward compatibility */
  schemaVersion: typeof COGNITION_SCHEMA_VERSION;

  /** Correlation ID from the tick */
  correlationId: string;

  /** ID of the signal that triggered this loop */
  triggerSignalId: string;

  /** Steps taken in this iteration */
  steps: Step[];

  /** Terminal state - what happens next */
  terminal: Terminal;
}

// ============================================================
// Tools
// ============================================================

/**
 * Available tools for COGNITION.
 */
export type ToolName =
  | 'searchMemory'
  | 'saveToMemory'
  | 'getCurrentTime'
  | 'getTimeSince'
  | 'getAgentState'
  | 'getUserModel';

/**
 * Tool definitions for prompt building.
 */
export interface ToolDefinition {
  name: ToolName;
  description: string;
  parameters: Record<string, ParameterDefinition>;
}

export interface ParameterDefinition {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required?: boolean;
}

/**
 * Tool execution result.
 */
export interface ToolResult {
  /** ID matching the ToolStep.id */
  stepId: string;

  /** Result ID for parentId linking */
  resultId: string;

  /** Whether tool succeeded */
  success: boolean;

  /** Tool output (if success) */
  data?: unknown;

  /** Error message (if failed) */
  error?: string;
}

// ============================================================
// Structured Facts
// ============================================================

/**
 * Source of evidence for a fact.
 */
export type EvidenceSource =
  | 'user_quote' // User explicitly said it
  | 'user_explicit' // User clearly indicated
  | 'user_implicit' // User implied
  | 'inferred' // Agent inferred from context
  | 'system'; // System-generated

/**
 * Structured fact for memory storage.
 * Follows subject-predicate-object pattern.
 */
export interface StructuredFact {
  /** Subject of the fact (user, agent, conversation) */
  subject: string;

  /** Predicate/relationship */
  predicate: string;

  /** Object/value */
  object: string;

  /** How we learned this */
  source: EvidenceSource;

  /** Supporting quote or observation */
  evidence?: string;

  /** Confidence in this fact (0-1) */
  confidence: number;

  /** Time-to-live in ms, null = permanent */
  ttl?: number | null;

  /** Searchable tags */
  tags: string[];
}

// ============================================================
// Field Risk Policies
// ============================================================

/**
 * Policy for a specific field update.
 */
export interface FieldPolicy {
  /** Minimum confidence required to apply */
  minConfidence: number;

  /** Required evidence sources (if any) */
  requireSource?: EvidenceSource[];

  /** Escalate to SMART if confidence below threshold */
  escalateIfUncertain?: boolean;

  /** Maximum delta change allowed (for numeric fields) */
  maxDelta?: number;
}

/**
 * Default field policies.
 */
export const FIELD_POLICIES: Record<string, FieldPolicy> = {
  // High-risk: require strong evidence
  'user.name': {
    minConfidence: 0.9,
    requireSource: ['user_quote', 'user_explicit'],
    escalateIfUncertain: true,
  },
  'user.language': {
    minConfidence: 0.85,
    requireSource: ['user_quote', 'user_explicit', 'user_implicit'],
  },
  'user.timezone': {
    minConfidence: 0.8,
    requireSource: ['user_explicit', 'user_implicit', 'inferred'],
  },

  // Medium-risk: preferences
  'user.preferences': {
    minConfidence: 0.8,
    escalateIfUncertain: true,
  },

  // Low-risk: ephemeral states
  'user.mood': {
    minConfidence: 0.6,
  },
  'user.availability': {
    minConfidence: 0.5,
  },

  // Agent state
  'agent.socialDebt': {
    minConfidence: 0.7,
    maxDelta: 0.3,
  },
  'agent.energy': {
    minConfidence: 0.9,
    maxDelta: 0.1,
  },
  'agent.curiosity': {
    minConfidence: 0.7,
    maxDelta: 0.2,
  },
  'agent.taskPressure': {
    minConfidence: 0.7,
    maxDelta: 0.3,
  },
};

/**
 * Get policy for a field, with fallback default.
 */
export function getFieldPolicy(field: string): FieldPolicy {
  return (
    FIELD_POLICIES[field] ?? {
      minConfidence: 0.8,
      escalateIfUncertain: false,
    }
  );
}

// ============================================================
// Loop Configuration
// ============================================================

/**
 * Safety limits for the agentic loop.
 */
export interface LoopConfig {
  /** Maximum LLM calls per trigger */
  maxIterations: number;

  /** Maximum tool calls per loop */
  maxToolCalls: number;

  /** Wall clock timeout in ms */
  timeoutMs: number;

  /** Abort loop if new user message arrives */
  abortOnNewMessage: boolean;

  /** Maximum input tokens per call */
  maxInputTokens: number;

  /** Maximum output tokens per call */
  maxOutputTokens: number;
}

/**
 * Default loop configuration.
 */
export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  maxIterations: 10,
  maxToolCalls: 5,
  timeoutMs: 30000,
  abortOnNewMessage: true,
  maxInputTokens: 10000,
  maxOutputTokens: 5000,
};

// ============================================================
// Loop State
// ============================================================

/**
 * State tracked during agentic loop execution.
 */
export interface LoopState {
  /** Current iteration (0-indexed) */
  iteration: number;

  /** Tool calls made so far */
  toolCallCount: number;

  /** Start time for timeout tracking */
  startTime: number;

  /** All steps from all iterations */
  allSteps: Step[];

  /** Tool results collected */
  toolResults: ToolResult[];

  /** Whether loop was aborted */
  aborted: boolean;

  /** Abort reason (if aborted) */
  abortReason?: string;

  /** Force LLM to respond (tool already executed but LLM keeps asking) */
  forceRespond?: boolean;
}

/**
 * Create initial loop state.
 */
export function createLoopState(): LoopState {
  return {
    iteration: 0,
    toolCallCount: 0,
    startTime: Date.now(),
    allSteps: [],
    toolResults: [],
    aborted: false,
  };
}
