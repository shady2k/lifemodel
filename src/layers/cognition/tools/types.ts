/**
 * Tool Types
 *
 * Defines the interface for COGNITION tools.
 */

import type { ToolName, ToolResult } from '../../../types/cognition.js';
import type { ValidationResult } from './validation.js';

/**
 * Tool executor function.
 * @param args - Arguments from the LLM
 * @param context - Execution context (chatId, userId, etc.) - NOT visible to LLM
 */
export type ToolExecutor = (
  args: Record<string, unknown>,
  context?: ToolContext
) => Promise<unknown>;

/**
 * Tool definition with executor.
 */
export interface Tool {
  name: ToolName;
  description: string;
  parameters: ToolParameter[];
  execute: ToolExecutor;
  /**
   * Validate arguments before execution.
   * Returns ValidationResult with data on success, or error message on failure.
   * Used to catch invalid LLM outputs and enable graceful retry.
   */
  validate: (args: unknown) => ValidationResult;
  /** Capability tags for tool discovery (e.g., ['recurring', 'one-time']) */
  tags?: string[];
  /**
   * Whether this tool has side effects.
   * - true: Mutates state (send message, save data, create reminder)
   * - false: Read-only (get time, search memory, get state)
   * Defaults to true for safety (unknown tools assumed to have side effects).
   * Used to determine if smart retry is safe after low confidence response.
   */
  hasSideEffects?: boolean;
  /**
   * Raw JSON Schema for complex parameter validation.
   * When provided, this is used directly instead of converting `parameters`.
   * Useful for discriminated unions, oneOf, anyOf, etc.
   * Must include type: 'object', properties, and additionalProperties: false.
   */
  rawParameterSchema?: Record<string, unknown>;
  /**
   * Maximum number of times this tool can be called per agentic turn.
   * When exceeded, the tool returns an error and is not executed.
   * Undefined = no limit.
   */
  maxCallsPerTurn?: number;
}

/**
 * Tool parameter definition.
 */
export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required: boolean;
  default?: unknown;
  /** Enum values for string parameters (creates JSON Schema enum constraint) */
  enum?: readonly string[];
}

/**
 * Context provided to tools during execution.
 */
export interface ToolContext {
  /** Opaque recipient identifier */
  recipientId: string;

  /** Current user ID (if applicable) */
  userId?: string | undefined;

  /** Correlation ID for tracing */
  correlationId: string;
}

/**
 * Tool execution request.
 */
export interface ToolRequest {
  /** Tool call ID from the API response */
  toolCallId: string;

  /** Tool name */
  name: ToolName;

  /** Tool arguments */
  args: Record<string, unknown>;

  /** Execution context */
  context: ToolContext;
}

/**
 * Create a tool result from execution.
 */
export function createToolResult(
  toolCallId: string,
  toolName: ToolName,
  success: boolean,
  data?: unknown,
  error?: string
): ToolResult {
  const result: ToolResult = {
    toolCallId,
    toolName,
    resultId: `${toolCallId}-result`,
    success,
  };
  if (data !== undefined) {
    result.data = data;
  }
  if (error !== undefined) {
    result.error = error;
  }
  return result;
}
