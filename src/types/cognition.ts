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
 * All possible step types.
 *
 * Two-element architecture:
 * - think: Chain-of-thought reasoning (observable, no side effects)
 * - tool: ALL mutations via tools (tracked, with feedback)
 */
export type Step = ThinkStep | ToolStep;

// ============================================================
// Terminal States
// ============================================================

/**
 * Conversation status for follow-up timing.
 */
export type ConversationStatus = 'active' | 'awaiting_answer' | 'closed' | 'idle';

/**
 * Respond to user - loop complete.
 *
 * confidence and conversationStatus are REQUIRED fields.
 * Low confidence (< 0.6) triggers smart model retry if safe.
 */
export interface RespondTerminal {
  type: 'respond';
  text: string;
  /** Conversation status for follow-up timing - REQUIRED */
  conversationStatus: ConversationStatus;
  /** Confidence in response (0-1) - REQUIRED. Below 0.6 triggers smart retry. */
  confidence: number;
  /** Parent ID - auto-assigned by system (last step or trigger signal) */
  parentId?: string;
}

/**
 * No action needed - loop complete.
 */
export interface NoActionTerminal {
  type: 'noAction';
  reason: string;
  /** Parent ID - auto-assigned by system */
  parentId?: string;
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
  /** Parent ID - auto-assigned by system */
  parentId?: string;
}

/**
 * All possible terminal states.
 * Note: EscalateTerminal removed - use low confidence in RespondTerminal instead.
 * Note: NeedsToolResultTerminal removed - native tool calling handles this automatically.
 */
export type Terminal = RespondTerminal | NoActionTerminal | DeferTerminal;

// ============================================================
// Main Output
// ============================================================

/**
 * Complete COGNITION output for one iteration.
 */
export interface CognitionOutput {
  /** Schema version for forward compatibility */
  schemaVersion: typeof COGNITION_SCHEMA_VERSION;

  /** Tick ID for batch grouping (NOT causal - use triggerSignalId for that) */
  tickId: string;

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
 * Built-in tools for COGNITION (consolidated).
 * - memory: search/save long-term memories
 * - core.time: get current time or time since event
 * - core.state: get agent state or user model
 * - core.tools: get full schema for any tool (meta-tool for discovery)
 */
/**
 * Available tools for COGNITION.
 * - Core tools: core.memory, core.time, core.state, core.tools, core.thought
 * - Plugin tools: plugin.reminder, plugin.weather, etc.
 * Requires exact tool names (no short form fallbacks).
 */
export type ToolName = string;

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
  /** Tool call ID from the API response (links tool call to result) */
  toolCallId: string;

  /** Tool name that was executed */
  toolName: ToolName;

  /** Result ID for parentId linking */
  resultId: string;

  /** Whether tool succeeded */
  success: boolean;

  /** Tool output (if success) */
  data?: unknown;

  /** Error message (if failed) */
  error?: string;

  /**
   * Whether this result's intent was already applied immediately.
   * Used to skip REMEMBER/SET_INTEREST in final intent compilation
   * since they were applied during loop execution for immediate visibility.
   */
  immediatelyApplied?: boolean;
}

/**
 * Executed tool tracking for safe retry detection.
 */
export interface ExecutedTool {
  /** Tool call ID from the API response (links tool call to result) */
  toolCallId: string;
  /** Tool name that was executed */
  name: ToolName;
  /** Tool arguments */
  args: Record<string, unknown>;
  /** Whether tool has side effects (from Tool interface) */
  hasSideEffects: boolean;
}

/**
 * Validate a RespondTerminal at parse time.
 * Throws if required fields are missing.
 */
export function validateRespondTerminal(terminal: unknown): RespondTerminal {
  if (typeof terminal !== 'object' || terminal === null) {
    throw new Error('RespondTerminal must be an object');
  }

  const t = terminal as Record<string, unknown>;

  if (t['type'] !== 'respond') {
    throw new Error('Invalid terminal type');
  }

  if (typeof t['text'] !== 'string') {
    throw new Error('RespondTerminal missing required field: text');
  }

  // parentId is auto-assigned by system, not required from LLM

  const validStatuses = ['active', 'awaiting_answer', 'closed', 'idle'];
  if (!validStatuses.includes(t['conversationStatus'] as string)) {
    throw new Error(
      `RespondTerminal missing/invalid conversationStatus. Got: ${String(t['conversationStatus'])}`
    );
  }

  if (typeof t['confidence'] !== 'number' || t['confidence'] < 0 || t['confidence'] > 1) {
    throw new Error(`RespondTerminal missing/invalid confidence. Got: ${String(t['confidence'])}`);
  }

  return terminal as RespondTerminal;
}

/**
 * Validate a DeferTerminal at parse time.
 * Throws if required fields are missing.
 */
export function validateDeferTerminal(terminal: unknown): DeferTerminal {
  if (typeof terminal !== 'object' || terminal === null) {
    throw new Error('DeferTerminal must be an object');
  }

  const t = terminal as Record<string, unknown>;

  if (t['type'] !== 'defer') {
    throw new Error('Invalid terminal type');
  }

  if (typeof t['signalType'] !== 'string') {
    throw new Error('DeferTerminal missing required field: signalType');
  }

  if (typeof t['reason'] !== 'string') {
    throw new Error('DeferTerminal missing required field: reason');
  }

  if (typeof t['deferHours'] !== 'number' || t['deferHours'] <= 0) {
    throw new Error(`DeferTerminal missing/invalid deferHours. Got: ${String(t['deferHours'])}`);
  }

  // parentId is auto-assigned by system, not required from LLM

  return terminal as DeferTerminal;
}

/**
 * Validate a NoActionTerminal at parse time.
 * Throws if required fields are missing.
 */
export function validateNoActionTerminal(terminal: unknown): NoActionTerminal {
  if (typeof terminal !== 'object' || terminal === null) {
    throw new Error('NoActionTerminal must be an object');
  }

  const t = terminal as Record<string, unknown>;

  if (t['type'] !== 'noAction') {
    throw new Error('Invalid terminal type');
  }

  if (typeof t['reason'] !== 'string') {
    throw new Error('NoActionTerminal missing required field: reason');
  }

  // parentId is auto-assigned by system, not required from LLM

  return terminal as NoActionTerminal;
}

/**
 * Validate any terminal at parse time.
 * Throws if required fields are missing.
 *
 * Note: NeedsToolResultTerminal removed - native tool calling handles tool results automatically.
 */
export function validateTerminal(terminal: unknown): Terminal {
  if (typeof terminal !== 'object' || terminal === null) {
    throw new Error('Terminal must be an object');
  }

  const t = terminal as Record<string, unknown>;
  const terminalType = t['type'];

  switch (terminalType) {
    case 'respond':
      return validateRespondTerminal(terminal);
    case 'defer':
      return validateDeferTerminal(terminal);
    case 'noAction':
      return validateNoActionTerminal(terminal);
    default:
      throw new Error(`Unknown terminal type: ${String(terminalType)}`);
  }
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
  'user.birthday': {
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

  // Low-risk: ephemeral states (allow inference)
  'user.mood': {
    minConfidence: 0.6,
  },
  'user.availability': {
    minConfidence: 0.5,
  },
  'user.last_interaction_state': {
    minConfidence: 0.5,
  },

  // Agent state (socialDebt and energy are automatic — not LLM-writable)
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
 * User fields without explicit policies require higher confidence
 * to prevent junk accumulation in the user model.
 */
export function getFieldPolicy(field: string): FieldPolicy {
  // Check for explicit policy first
  if (FIELD_POLICIES[field]) {
    return FIELD_POLICIES[field];
  }

  // User fields without explicit policy: require higher confidence
  // and disallow pure inference without provenance markers
  if (field.startsWith('user.')) {
    return {
      minConfidence: 0.7,
      requireSource: ['user_quote', 'user_explicit', 'user_implicit'],
      escalateIfUncertain: false,
    };
  }

  // Non-user fields: more permissive default
  return {
    minConfidence: 0.5,
    escalateIfUncertain: false,
  };
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
  maxIterations: 15,
  maxToolCalls: 20,
  timeoutMs: 120000,
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

  /** Chain-of-thought content captured from assistant responses */
  thoughts: string[];

  /** Tool results collected */
  toolResults: ToolResult[];

  /** Executed tools with side-effect tracking (for safe retry detection) */
  executedTools: ExecutedTool[];

  /** Whether loop was aborted */
  aborted: boolean;

  /** Abort reason (if aborted) */
  abortReason?: string;

  /** Force LLM to respond (tool already executed but LLM keeps asking) */
  forceRespond?: boolean;

  /** Track failed tool call signatures to detect retry loops */
  failedCallCounts: Map<string, number>;

  /** Track all identical tool call signatures to detect loops (successful or failed) */
  identicalCallCounts: Map<string, number>;

  /** Conversation status from LLM response JSON (optional "status" field) */
  conversationStatus: ConversationStatus | undefined;

  /** Track forceRespond retry attempts to prevent dead-end */
  forceRespondAttempts: number;

  /** Track if we ever forced respond (for confidence calculation) */
  everForcedRespond: boolean;

  /** Tool budget for proactive contact (undefined = no limit) */
  proactiveToolBudget?: number | undefined;

  /** Per-tool call counts for maxCallsPerTurn enforcement */
  toolCallCounts: Map<string, number>;

  /** Cumulative count of per-tool limit violations (safety valve for tool-limit loops) */
  limitViolationCount: number;

  /** Collected thought contents (batched into single thought at end) */
  collectedThoughts: string[];

  /** Whether a malformed response retry has already been attempted */
  malformedRetried: boolean;

  /** Whether a provider-error retry has already been attempted (prevents stripping tools on provider failures) */
  providerErrorRetried: boolean;
}

/**
 * Create initial loop state.
 */
export function createLoopState(): LoopState {
  return {
    iteration: 0,
    toolCallCount: 0,
    startTime: Date.now(),
    thoughts: [],
    toolResults: [],
    executedTools: [],
    aborted: false,
    failedCallCounts: new Map<string, number>(),
    identicalCallCounts: new Map<string, number>(),
    conversationStatus: undefined,
    forceRespondAttempts: 0,
    everForcedRespond: false,
    toolCallCounts: new Map<string, number>(),
    limitViolationCount: 0,
    collectedThoughts: [],
    malformedRetried: false,
    providerErrorRetried: false,
  };
}

/**
 * Maximum times the same failing tool call can be retried before forcing response.
 */
export const MAX_REPEATED_FAILED_CALLS = 2;

/**
 * Maximum times the exact same tool call (same name + args) can be made before forcing response.
 * Prevents infinite loops where LLM repeatedly calls the same tool expecting different results.
 */
export const MAX_REPEATED_IDENTICAL_CALLS = 2;
