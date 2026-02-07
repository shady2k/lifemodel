/**
 * Shell Runner - Controlled shell command execution.
 *
 * Uses allowlist-based security and child_process.execFile to prevent
 * shell injection attacks.
 */

import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MotorToolResult } from '../motor-cortex/motor-protocol.js';
import { validatePipeline, isNetworkCommand, DEFAULT_ALLOWLIST } from './shell-allowlist.js';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

/**
 * Shell execution options.
 */
export interface ShellOptions {
  /** Timeout in milliseconds (default: 60000) */
  timeout?: number;

  /** Working directory (default: temp workspace) */
  cwd?: string;

  /** Custom allowlist (default: DEFAULT_ALLOWLIST) */
  allowlist?: Set<string>;

  /** Maximum output size in bytes (default: 10KB) */
  maxOutputSize?: number;
}

/**
 * Default options.
 */
const DEFAULT_OPTIONS: Required<Omit<ShellOptions, 'cwd' | 'allowlist'>> = {
  timeout: 60_000, // 60 seconds
  maxOutputSize: 10 * 1024, // 10KB
};

/**
 * Workspace directory for shell execution.
 *
 * Created per run to isolate file operations.
 */
let workspaceDir: string | null = null;

/**
 * Get or create workspace directory.
 */
async function getWorkspace(): Promise<string> {
  workspaceDir ??= await mkdtemp(join(tmpdir(), 'motor-cortex-shell-'));
  return workspaceDir;
}

/**
 * Clean up workspace directory.
 */
export async function cleanupWorkspace(): Promise<void> {
  if (workspaceDir) {
    try {
      await rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = null;
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Truncate output to max size.
 */
function truncateOutput(output: string, maxSize: number): string {
  const size = Buffer.byteLength(output, 'utf8');
  if (size <= maxSize) {
    return output;
  }

  // Truncate and add ellipsis
  const truncated = output.slice(0, maxSize);
  return `${truncated}\n\n[... output truncated (${(size / 1024).toFixed(1)}KB exceeds limit ${String(maxSize / 1024)}KB) ...]`;
}

/**
 * Run a shell command with strict controls.
 *
 * @param command - Shell command to run
 * @param options - Execution options
 * @returns MotorToolResult with execution output
 */
export async function runShell(
  command: string,
  options: ShellOptions = {}
): Promise<MotorToolResult> {
  const startTime = Date.now();
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Validate command against allowlist
  const validation = validatePipeline(command, opts.allowlist ?? DEFAULT_ALLOWLIST);
  if (!validation.valid) {
    return {
      ok: false,
      output: '',
      errorCode: 'invalid_args',
      retryable: false,
      provenance: 'internal',
      durationMs: Date.now() - startTime,
    };
  }

  // Check if pipeline contains network commands
  const hasNetwork = validation.commands?.some((c) => isNetworkCommand(c)) ?? false;

  // Create workspace if not provided
  const cwd = opts.cwd ?? (await getWorkspace());

  try {
    let stdout: string;
    let stderr: string;

    // Check if command contains pipe
    if (command.includes('|')) {
      // Pipeline: use exec with sh -c
      // Note: We already validated each command in the pipeline
      const { stdout: out, stderr: err } = await execAsync(command, {
        cwd,
        timeout: opts.timeout,
        env: { PATH: process.env['PATH'] }, // Only pass PATH
      });
      stdout = out;
      stderr = err;
    } else {
      // Single command: use execFile (no shell interpretation)
      const parts = command.split(/\s+/);
      const cmd = parts[0];
      if (!cmd) {
        return {
          ok: false,
          output: '',
          errorCode: 'invalid_args',
          retryable: false,
          provenance: 'internal',
          durationMs: Date.now() - startTime,
        };
      }
      const args = parts.slice(1);

      const { stdout: out, stderr: err } =
        args.length > 0
          ? await execFileAsync(cmd, args, {
              cwd,
              timeout: opts.timeout,
              env: { PATH: process.env['PATH'] }, // Only pass PATH
            })
          : await execFileAsync(cmd, {
              cwd,
              timeout: opts.timeout,
              env: { PATH: process.env['PATH'] }, // Only pass PATH
            });
      stdout = out;
      stderr = err;
    }

    // Combine stdout and stderr
    const output = truncateOutput(stdout + (stderr ? `\n${stderr}` : ''), opts.maxOutputSize);

    return {
      ok: true,
      output,
      retryable: false,
      provenance: hasNetwork ? 'web' : 'internal',
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    // Determine error code
    let errorCode: MotorToolResult['errorCode'] = 'execution_error';
    let retryable = false;

    if ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      errorCode = 'timeout';
      retryable = true;
    } else if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      errorCode = 'not_found';
      retryable = false;
    } else if ((error as NodeJS.ErrnoException).code === 'EACCES') {
      errorCode = 'permission_denied';
      retryable = false;
    }

    // Extract error message
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      ok: false,
      output: truncateOutput(errorMessage, opts.maxOutputSize),
      errorCode,
      retryable,
      provenance: 'internal',
      durationMs: duration,
    };
  }
}
