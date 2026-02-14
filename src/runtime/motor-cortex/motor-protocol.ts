/**
 * Motor Cortex Protocol Types
 *
 * All types shared between Motor Cortex components.
 * Pure type definitions - no runtime code, no imports from the project
 * (except Message from src/llm/provider.ts for conversation compatibility).
 */

import type { Message } from '../../llm/provider.js';

/**
 * Status of a Motor Cortex run.
 *
 * Flow: created → running → awaiting_input → completed
 *                     ↘ failed
 */
export type RunStatus =
  | 'created'
  | 'running'
  | 'awaiting_input'
  | 'awaiting_approval'
  | 'completed'
  | 'failed';

/**
 * Synthetic tools that can be injected into a Motor Cortex run.
 *
 * These are host-side tools that don't run in the container:
 * - ask_user: Pause execution and ask user a question
 * - save_credential: Persist a credential for future runs
 * - request_approval: Request user approval for an action (requires bash tool)
 */
export type SyntheticTool = 'ask_user' | 'save_credential' | 'request_approval';

/**
 * Tools available to the Motor Cortex sub-agent.
 */
export type MotorTool = 'read' | 'write' | 'list' | 'glob' | 'bash' | 'grep' | 'patch' | 'fetch';

/**
 * Result from executing a Motor Cortex tool.
 *
 * All results return strings - structured data is JSON-encoded.
 */
export interface MotorToolResult {
  /** Whether the tool executed successfully */
  ok: boolean;

  /** Output text (JSON.stringify for structured data) */
  output: string;

  /** Error code if ok=false (for retry logic) */
  errorCode?:
    | 'timeout'
    | 'not_found'
    | 'auth_failed'
    | 'permission_denied'
    | 'invalid_args'
    | 'execution_error'
    | 'tool_not_available'
    | 'unknown';

  /** Whether the error is retryable (same tool + args might work) */
  retryable: boolean;

  /** Where the result came from (affects trustworthiness) */
  provenance: 'user' | 'web' | 'internal';

  /** Execution time in milliseconds */
  durationMs: number;

  /** Estimated LLM cost (optional, for budgeting) */
  cost?: number;
}

/**
 * Final result of a Motor Cortex task.
 */
export interface TaskResult {
  /** Whether the task succeeded */
  ok: boolean;

  /** Human-readable summary of what was done */
  summary: string;

  /** Run ID that produced this result */
  runId: string;

  /** Files produced by the run (copied to artifacts dir) */
  artifacts?: string[];

  /** Skills extracted from workspace and installed to data/skills/ */
  installedSkills?: { created: string[]; updated: string[] };

  /** Execution statistics */
  stats: {
    /** Number of loop iterations */
    iterations: number;

    /** Total execution time in milliseconds */
    durationMs: number;

    /** Total energy consumed (0-1 scale) */
    energyCost: number;

    /** Number of tool errors encountered */
    errors: number;
  };
}

/**
 * Trace of a single loop iteration.
 */
export interface StepTrace {
  /** Iteration number (0-indexed) */
  iteration: number;

  /** When this iteration started */
  timestamp: string;

  /** LLM model used for this iteration */
  llmModel: string;

  /** Tool calls made in this iteration */
  toolCalls: {
    /** Tool name */
    tool: string;

    /** Arguments passed to the tool */
    args: Record<string, unknown>;

    /** Result returned by the tool */
    result: MotorToolResult;

    /** Time taken for this tool call */
    durationMs: number;
  }[];

  /** Optional reasoning from the model (if using thinking models) */
  reasoning?: string;

  /** Optional evidence/observations (if the model reports them) */
  evidence?: string;
}

/**
 * Complete execution trace for a Motor Cortex run.
 */
export interface RunTrace {
  /** Run identifier */
  runId: string;

  /** Task description */
  task: string;

  /** Skill file being executed (if any) */
  skill?: string;

  /** Current run status */
  status: RunStatus;

  /** All completed iterations */
  steps: StepTrace[];

  /** Total iterations executed */
  totalIterations: number;

  /** Total execution time in milliseconds */
  totalDurationMs: number;

  /** Total energy consumed */
  totalEnergyCost: number;

  /** Total LLM API calls made */
  llmCalls: number;

  /** Total tool calls made */
  toolCalls: number;

  /** Number of errors encountered */
  errors: number;
}

/**
 * Failure category for classifying why an attempt failed.
 */
export type FailureCategory =
  | 'tool_failure'
  | 'model_failure'
  | 'infra_failure'
  | 'budget_exhausted'
  | 'invalid_task'
  | 'unknown';

/**
 * Summary of why an attempt failed.
 *
 * Contains both deterministic fields (category, retryable) and
 * optional free-text hint from the motor LLM for novel failures.
 */
export interface FailureSummary {
  /** Failure classification */
  category: FailureCategory;

  /** Error code from last failed tool (if applicable) */
  lastErrorCode?: string;

  /** Whether this failure is retryable (false for budget_exhausted, invalid_task) */
  retryable: boolean;

  /** Suggested next action for Cognition */
  suggestedAction: 'retry_with_guidance' | 'ask_user' | 'stop';

  /** Last tool results from the failing attempt (for Cognition to diagnose) */
  lastToolResults: { tool: string; ok: boolean; errorCode?: string; output: string }[];

  /** Optional: motor LLM's free-text analysis of what went wrong (unreliable but useful) */
  hint?: string;
}

/**
 * Recovery context provided by Cognition for retry attempts.
 *
 * Injected into the motor system prompt as <recovery_context>.
 * Never injected as role:'user' — preserves provenance boundaries.
 */
export interface RecoveryContext {
  /** Always from Cognition policy layer */
  source: 'cognition';

  /** Which attempt failed */
  previousAttemptId: string;

  /** Cognition's corrective instructions */
  guidance: string;

  /** Optional constraints for the retry */
  constraints?: string[];
}

/**
 * A single attempt within a Motor Cortex run.
 *
 * Each retry creates a new attempt with clean message history.
 * No mutating past attempts — clean audit trail for skill harvesting.
 */
export interface MotorAttempt {
  /** Attempt identifier (e.g. "att_0", "att_1") */
  id: string;

  /** 0-based attempt index */
  index: number;

  /** Attempt status */
  status: 'running' | 'awaiting_input' | 'awaiting_approval' | 'completed' | 'failed';

  /** Motor LLM conversation for THIS attempt */
  messages: Message[];

  /** Current step cursor (for resumption after restart) */
  stepCursor: number;

  /** Maximum iterations before auto-fail */
  maxIterations: number;

  /** Execution trace for this attempt */
  trace: RunTrace;

  /** Recovery context from Cognition (present on attempts 1+) */
  recoveryContext?: RecoveryContext;

  /** Failure summary (present when status='failed') */
  failure?: FailureSummary;

  /** Question from ask_user tool (set when status=awaiting_input) */
  pendingQuestion?: string;

  /** Tool call ID for the pending ask_user (for tool_call/result atomicity) */
  pendingToolCallId?: string;

  /** Pending approval request (set when status=awaiting_approval) */
  pendingApproval?: {
    /** Description of the action needing approval */
    action: string;
    /** Step cursor when approval was requested */
    stepCursor: number;
    /** When approval expires (auto-cancel) */
    expiresAt: string;
  };

  /** When the attempt started */
  startedAt: string;

  /** When the attempt completed/failed */
  completedAt?: string;
}

/**
 * Default maximum attempts per run.
 */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Evidence collected during Motor Cortex execution.
 *
 * Captured from tool call traces - deterministic observations,
 * not heuristic scanning. Used for security review during approval.
 */
export interface RunEvidence {
  /** Domains actually contacted via fetch tool (from tool call args — reliable) */
  fetchedDomains: string[];

  /** Credentials saved via save_credential during the run */
  savedCredentials: string[];

  /** Motor tools used during the run */
  toolsUsed: string[];

  /** Whether bash was used — if true, network activity beyond fetch is unobservable */
  bashUsed: boolean;
}

/**
 * A Motor Cortex run - complete execution state.
 *
 * This is persisted to storage and resumed after restart.
 * A run contains one or more attempts — each retry is a new attempt
 * with clean message history but recovery context from previous failures.
 */
export interface MotorRun {
  /** Unique run identifier */
  id: string;

  /** Current status */
  status: RunStatus;

  /** Task description (natural language) */
  task: string;

  /** Skill file being executed (optional) */
  skill?: string;

  /** Tools available to the sub-agent */
  tools: MotorTool[];

  /** Ordered list of attempts */
  attempts: MotorAttempt[];

  /** Index into attempts[] for the current attempt */
  currentAttemptIndex: number;

  /** Maximum attempts before giving up */
  maxAttempts: number;

  /** Final result (set when status=completed) */
  result?: TaskResult;

  /** When the run was created */
  startedAt: string;

  /** When the run completed/failed (optional) */
  completedAt?: string;

  /** Energy consumed so far */
  energyConsumed: number;

  /** Docker container ID (if running in container isolation) */
  containerId?: string;

  /** Host-side workspace path (persisted for resume after restart) */
  workspacePath?: string;

  /** Allowed network domains for this run (merged from skill + explicit) */
  domains?: string[];

  /** Run configuration (persisted for retry/resume) */
  config: {
    /** Which synthetic tools to inject (allow-list) */
    syntheticTools: SyntheticTool[];
    /** Whether to install skill dependencies before running */
    installDependencies: boolean;
    /** Whether to merge skill policy domains into allowed domains */
    mergePolicyDomains: boolean;
  };

  /** Credentials saved by save_credential before skill directory exists.
   *  Merged into policy.json during extraction. */
  pendingCredentials?: Record<string, string>;
}
