/**
 * Tool Output Truncation
 *
 * Universal truncation for Motor Cortex tool outputs.
 * Adapted from OpenCode's Truncate.output() (MIT licensed).
 *
 * When tool output exceeds limits (line count OR byte size), saves full content
 * to workspace and returns a truncated preview + hint pointing to the file.
 * The agent can then use read/grep to access specific sections.
 *
 * This prevents massive tool results (e.g. 94KB fetch output) from bloating
 * conversation context and consuming LLM tokens on every iteration.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Maximum lines to include in truncated output preview */
export const TRUNCATION_MAX_LINES = 2000;

/** Maximum bytes for truncated output (~3K tokens per tool result) */
export const TRUNCATION_MAX_BYTES = 12 * 1024; // 12KB

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
 * If output exceeds limits (line count OR byte size), saves full content
 * to workspace and returns a preview + hint pointing to the file.
 *
 * @param output - The tool output string
 * @param toolName - Name of the tool that produced the output
 * @param callId - Tool call ID (used for unique filename)
 * @param workspace - Absolute path to workspace directory
 * @returns Truncation result with content and metadata
 */
export async function truncateToolOutput(
  output: string,
  toolName: string,
  callId: string,
  workspace: string
): Promise<TruncationResult> {
  const lines = output.split('\n');
  const totalBytes = Buffer.byteLength(output, 'utf-8');

  // Fast path: output fits within limits
  if (lines.length <= TRUNCATION_MAX_LINES && totalBytes <= TRUNCATION_MAX_BYTES) {
    return { content: output, truncated: false };
  }

  // Build preview: take lines from the head until we hit either limit
  const out: string[] = [];
  let bytes = 0;
  let hitBytes = false;

  for (const [i, line] of lines.entries()) {
    if (i >= TRUNCATION_MAX_LINES) break;
    const size = Buffer.byteLength(line, 'utf-8') + (i > 0 ? 1 : 0);
    if (bytes + size > TRUNCATION_MAX_BYTES) {
      hitBytes = true;
      break;
    }
    out.push(line);
    bytes += size;
  }

  const removed = hitBytes ? totalBytes - bytes : lines.length - out.length;
  const unit = hitBytes ? 'bytes' : 'lines';
  const preview = out.join('\n');

  // Save full output to workspace file
  const truncDir = join(workspace, TRUNCATION_DIR);
  await mkdir(truncDir, { recursive: true });
  const filename = `${toolName}-${callId.slice(-8)}.txt`;
  const filepath = `${TRUNCATION_DIR}/${filename}`;
  await writeFile(join(truncDir, filename), output, 'utf-8');

  // Build truncated response with hint
  const hint = `Output truncated. Full output saved to: ${filepath} — use read with offset/limit or grep to access specific sections.`;
  const content = `${preview}\n\n...${String(removed)} ${unit} truncated...\n\n${hint}`;

  return { content, truncated: true, originalBytes: totalBytes, savedPath: filepath };
}
