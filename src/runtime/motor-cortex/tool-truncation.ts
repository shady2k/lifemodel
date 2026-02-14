/**
 * Tool Output Truncation
 *
 * Universal truncation for Motor Cortex tool outputs.
 *
 * Tool-specific behavior:
 * - fetch (success): ALWAYS saves to .motor-output/ and returns pointer (no inline content).
 *   Weak models need ONE workflow for downloaded content: always cp from .motor-output/.
 *   Without this, models lose track of which fetches were inline vs saved, and try to
 *   cp inline results from .motor-output/ (which don't exist).
 * - fetch (error): returned inline so the model can see the error message (BLOCKED, 404, etc.).
 *
 * - All other tools (read, bash, grep, etc.): inline up to TRUNCATION_MAX_BYTES (4KB).
 *   Above that, saves to .motor-output/ and returns pointer.
 *   The model needs to SEE read/bash/grep results inline to understand and act on them.
 *
 * Why no preview for saved files: weak models (qwen, deepseek) see content and
 * reconstruct the rest from memory instead of using cp/read. No preview = nothing
 * to fabricate from.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Tools whose output is ALWAYS saved to .motor-output/ (never inline) */
const ALWAYS_SAVE_TOOLS = new Set(['fetch']);

/** Maximum lines before save-to-file triggers */
export const TRUNCATION_MAX_LINES = 2000;

/** Maximum bytes for inline output in context (~1K tokens per tool result) */
export const TRUNCATION_MAX_BYTES = 4 * 1024; // 4KB

/** Directory name for spillover files (relative to workspace) */
export const TRUNCATION_DIR = '.motor-output';

export interface TruncationResult {
  /** The output content (truncated or original) */
  content: string;
  /** Whether truncation was applied */
  truncated: boolean;
  /** Original byte size (only set if truncated) */
  originalBytes?: number;
  /** Path to saved file relative to workspace (only set if truncated) */
  savedPath?: string;
}

/**
 * Truncate tool output for LLM context.
 *
 * - fetch (success): always saves to .motor-output/, returns pointer only
 * - fetch (error): returned inline so the model can see WHY it failed
 * - Other tools: inline if ≤ TRUNCATION_MAX_BYTES and ≤ TRUNCATION_MAX_LINES,
 *   otherwise saves to .motor-output/ and returns pointer
 *
 * @param output - The tool output string
 * @param toolName - Name of the tool that produced the output
 * @param callId - Tool call ID (used for unique filename)
 * @param workspace - Absolute path to workspace directory
 * @param options - Optional: toolOk (whether the tool call succeeded)
 * @returns Truncation result with content and metadata
 */
export async function truncateToolOutput(
  output: string,
  toolName: string,
  callId: string,
  workspace: string,
  options?: { toolOk?: boolean }
): Promise<TruncationResult> {
  const lines = output.split('\n');
  const totalBytes = Buffer.byteLength(output, 'utf-8');

  // Force-save only for SUCCESSFUL fetch results. Errors must be inline
  // so the model can see WHY it failed (BLOCKED domain, HTTP 404, etc.).
  const forceSave = ALWAYS_SAVE_TOOLS.has(toolName) && options?.toolOk !== false;

  // Inline path: output fits within limits AND tool allows inline
  if (!forceSave && lines.length <= TRUNCATION_MAX_LINES && totalBytes <= TRUNCATION_MAX_BYTES) {
    return { content: output, truncated: false };
  }

  // Save full output to workspace file
  const truncDir = join(workspace, TRUNCATION_DIR);
  await mkdir(truncDir, { recursive: true });
  const filename = `${toolName}-${callId.slice(-8)}.txt`;
  const filepath = `${TRUNCATION_DIR}/${filename}`;
  await writeFile(join(truncDir, filename), output, 'utf-8');

  // No content preview — only metadata + pointer.
  const content = [
    `Output saved (${String(totalBytes)} bytes, ${String(lines.length)} lines) to: ${filepath}`,
    `To copy to a file: bash({"command":"cp ${filepath} <target-path>"})`,
    `To read sections: read({"path":"${filepath}", "offset": 1, "limit": 100})`,
  ].join('\n');

  return { content, truncated: true, originalBytes: totalBytes, savedPath: filepath };
}
