/**
 * Sandbox Runner - Fork orchestrator for code execution.
 *
 * Manages child process lifecycle, IPC communication, and timeouts.
 * This is the main process entry point for sandbox execution.
 */

import { fork } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MotorToolResult } from '../motor-cortex/motor-protocol.js';
import { guardCode } from './sandbox-guard.js';

/**
 * IPC message types.
 */
interface ExecuteMessage {
  type: 'execute';
  code: string;
}

interface ResultMessage {
  type: 'result';
  ok: boolean;
  output: string;
  error: string;
  durationMs: number;
}

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

  return new Promise<MotorToolResult>((resolve) => {
    let settled = false;
    const settle = (result: MotorToolResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    // Resolve the worker path
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'sandbox-worker.js');

    // Fork the worker process
    const child = fork(workerPath, [], {
      silent: true, // Don't share stdio
      env: {}, // Empty environment
      execArgv: [], // No Node.js flags
    });

    // Set up timeout
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      settle({
        ok: false,
        output: '',
        errorCode: 'timeout',
        retryable: true,
        provenance: 'internal',
        durationMs: timeoutMs,
      });
    }, timeoutMs);

    // Capture stderr for error reporting
    let stderrOutput = '';
    if (child.stderr) {
      child.stderr.on('data', (data: Buffer) => {
        stderrOutput += data.toString();
      });
    }

    // Send code to worker
    const message: ExecuteMessage = {
      type: 'execute',
      code,
    };
    child.send(message);

    // Handle worker response
    child.on('message', (response: unknown) => {
      const result = response as ResultMessage;

      if (result.ok) {
        settle({
          ok: true,
          output: result.output,
          retryable: false,
          provenance: 'internal',
          durationMs: result.durationMs,
        });
      } else {
        // Map error to error codes
        let errorCode: MotorToolResult['errorCode'] = 'execution_error';
        if (result.error.includes('too large')) {
          errorCode = 'invalid_args';
        } else if (result.error.includes('timeout')) {
          errorCode = 'timeout';
        }

        settle({
          ok: false,
          output: result.output,
          errorCode,
          retryable: errorCode === 'timeout',
          provenance: 'internal',
          durationMs: result.durationMs,
        });
      }

      // Clean up child process
      child.kill();
    });

    // Handle worker errors
    child.on('error', (_error: Error) => {
      settle({
        ok: false,
        output: '',
        errorCode: 'execution_error',
        retryable: true,
        provenance: 'internal',
        durationMs: Date.now() - startTime,
      });
    });

    // Handle worker exit (without response)
    child.on('exit', (code: number | null, signal: string | null) => {
      settle({
        ok: false,
        output:
          stderrOutput ||
          `Process exited unexpectedly (code: ${String(code)}, signal: ${String(signal)})`,
        errorCode: 'execution_error',
        retryable: true,
        provenance: 'internal',
        durationMs: Date.now() - startTime,
      });
    });
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
