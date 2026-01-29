/**
 * Tool Types
 *
 * Defines the interface for COGNITION tools.
 */

import type { ToolName, ToolResult } from '../../../types/cognition.js';

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
  /** Capability tags for tool discovery (e.g., ['recurring', 'one-time']) */
  tags?: string[];
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
}

/**
 * Context provided to tools during execution.
 */
export interface ToolContext {
  /** Current chat ID (if applicable) */
  chatId?: string | undefined;

  /** Current user ID (if applicable) */
  userId?: string | undefined;

  /** Correlation ID for tracing */
  correlationId: string;
}

/**
 * Tool execution request.
 */
export interface ToolRequest {
  /** Step ID from CognitionOutput */
  stepId: string;

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
  stepId: string,
  toolName: ToolName,
  success: boolean,
  data?: unknown,
  error?: string
): ToolResult {
  const result: ToolResult = {
    stepId,
    toolName,
    resultId: `${stepId}-result`,
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
