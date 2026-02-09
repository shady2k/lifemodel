/**
 * Sandbox Runner - Orchestrator for sandboxed code execution.
 *
 * Manages child process lifecycle, communication, and timeouts.
 * Uses execFile (not fork) so the worker can run both on the host
 * and inside Docker containers without bundling issues.
 */

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MotorToolResult } from '../motor-cortex/motor-protocol.js';
import { guardCode } from './sandbox-guard.js';

/**
 * Shell options for sandbox execution.
 */
export interface SandboxOptions {
  /** Timeout in milliseconds (default: 5000) */
  timeout?: number;
  /** Skip safety guard (for testing only) */
  skipGuard?: boolean;
}

/**
 * Default timeout for oneshot execution (5 seconds).
 */
const DEFAULT_ONESHOT_TIMEOUT = 5_000;

/**
 * Default timeout for agentic code steps (30 seconds).
 */
const DEFAULT_AGENTIC_TIMEOUT = 30_000;

/**
 * Run code in the sandbox.
 *
 * Uses execFile to spawn a worker process that executes code in a
 * stripped global environment. The worker receives code via CLI arg
 * and returns a JSON result on stdout.
 *
 * @param code - JavaScript code to execute
 * @param timeoutMs - Timeout in milliseconds
 * @returns MotorToolResult with execution output
 */
export async function runSandbox(
  code: string,
  timeoutMs: number = DEFAULT_ONESHOT_TIMEOUT
): Promise<MotorToolResult> {
  const startTime = Date.now();

  // Run safety guard (best-effort, real security is process isolation)
  const guardResult = guardCode(code);
  if (!guardResult.safe) {
    return {
      ok: false,
      output: '',
      errorCode: 'invalid_args',
      retryable: false,
      provenance: 'internal',
      durationMs: Date.now() - startTime,
    };
  }

  // Resolve the worker path (match parent's extension: .ts in dev, .js in prod)
  const currentFile = fileURLToPath(import.meta.url);
  const ext = currentFile.endsWith('.ts') ? '.ts' : '.js';
  const workerPath = join(dirname(currentFile), `sandbox-worker${ext}`);

  return new Promise<MotorToolResult>((resolve) => {
    let settled = false;
    const settle = (result: MotorToolResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // Spawn the worker using execFile (not fork)
    // Code is passed via --eval CLI argument
    execFile(
      process.execPath,
      [workerPath, '--eval', code],
      {
        timeout: timeoutMs,
        env: {}, // Empty environment
        maxBuffer: 64 * 1024, // 64KB buffer
      },
      (error, stdout, stderr) => {
        if (error) {
          // Check if it was a timeout
          const err = error as {
            killed?: boolean;
            signal?: string;
            stdout?: string;
            stderr?: string;
          };
          if (err.killed || err.signal === 'SIGTERM') {
            settle({
              ok: false,
              output: '',
              errorCode: 'timeout',
              retryable: true,
              provenance: 'internal',
              durationMs: timeoutMs,
            });
            return;
          }

          // Non-zero exit but worker may have written valid JSON to stdout
          // (worker exits with code 1 on execution errors)
          const stdoutData = stdout || err.stdout || '';
          if (stdoutData) {
            try {
              const result = JSON.parse(stdoutData) as {
                ok: boolean;
                output: string;
                error: string;
                durationMs: number;
              };

              let errorCode: MotorToolResult['errorCode'] = 'execution_error';
              if (result.error.includes('too large')) {
                errorCode = 'invalid_args';
              }

              settle({
                ok: false,
                output: result.output || result.error,
                errorCode,
                retryable: false,
                provenance: 'internal',
                durationMs: result.durationMs,
              });
              return;
            } catch {
              // stdout wasn't valid JSON — fall through
            }
          }

          // Truly unexpected error
          settle({
            ok: false,
            output: stderr || error.message,
            errorCode: 'execution_error',
            retryable: true,
            provenance: 'internal',
            durationMs: Date.now() - startTime,
          });
          return;
        }

        // Parse JSON result from stdout
        try {
          const result = JSON.parse(stdout) as {
            ok: boolean;
            output: string;
            error: string;
            durationMs: number;
          };

          if (result.ok) {
            settle({
              ok: true,
              output: result.output,
              retryable: false,
              provenance: 'internal',
              durationMs: result.durationMs,
            });
          } else {
            let errorCode: MotorToolResult['errorCode'] = 'execution_error';
            if (result.error.includes('too large')) {
              errorCode = 'invalid_args';
            } else if (result.error.includes('timeout')) {
              errorCode = 'timeout';
            }

            settle({
              ok: false,
              output: result.output || result.error,
              errorCode,
              retryable: errorCode === 'timeout',
              provenance: 'internal',
              durationMs: result.durationMs,
            });
          }
        } catch {
          // stdout wasn't valid JSON — treat as raw output
          settle({
            ok: false,
            output: stdout || stderr || 'Process exited without output',
            errorCode: 'execution_error',
            retryable: true,
            provenance: 'internal',
            durationMs: Date.now() - startTime,
          });
        }
      }
    );
  });
}

/**
 * Run code in sandbox with oneshot timeout (5 seconds).
 */
export async function runOneshot(code: string): Promise<MotorToolResult> {
  return runSandbox(code, DEFAULT_ONESHOT_TIMEOUT);
}

/**
 * Run code in sandbox with agentic timeout (30 seconds).
 */
export async function runAgenticCode(code: string): Promise<MotorToolResult> {
  return runSandbox(code, DEFAULT_AGENTIC_TIMEOUT);
}
