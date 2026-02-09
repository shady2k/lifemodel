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
 * Tools available to the Motor Cortex sub-agent.
 */
export type MotorTool = 'code' | 'filesystem' | 'ask_user' | 'shell' | 'grep' | 'patch';

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
 * A Motor Cortex run - complete execution state.
 *
 * This is persisted to storage and resumed after restart.
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

  /** Current step cursor (for resumption after restart) */
  stepCursor: number;

  /** Maximum iterations before auto-fail */
  maxIterations: number;

  /** Sub-agent conversation history */
  messages: Message[];

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

  /** Final result (set when status=completed) */
  result?: TaskResult;

  /** When the run was created */
  startedAt: string;

  /** When the run completed/failed (optional) */
  completedAt?: string;

  /** Energy consumed so far */
  energyConsumed: number;

  /** Execution trace */
  trace: RunTrace;
}
