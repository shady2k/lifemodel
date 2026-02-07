/**
 * Sandbox Worker - Child process entry point.
 *
 * This file runs in a forked child process with stripped environment.
 * Receives code via IPC, executes it, and returns the result.
 *
 * Security approach:
 * - Dangerous globals are deleted before user code runs
 * - Uses `new Function()` instead of `eval()` - no closure access
 * - Result size limited to prevent memory exhaustion
 * - Process has limited access to parent environment
 */

/**
 * Maximum result size in bytes.
 * Prevents memory exhaustion via large return values.
 */
const MAX_RESULT_SIZE = 32 * 1024; // 32KB

/**
 * IPC message types.
 */
interface ResultMessage {
  type: 'result';
  ok: boolean;
  output: string;
  error: string;
  durationMs: number;
}

/**
 * Strip dangerous globals before executing user code.
 *
 * We delete these from the global scope so the user code
 * cannot access them even through indirect means.
 */
function stripDangerousGlobals(): void {
  // @ts-expect-error -- SECURITY: intentionally deleting globals for sandbox isolation
  delete process.env;

  // @ts-expect-error -- SECURITY: intentionally deleting globals for sandbox isolation
  delete require; // eslint-disable-line no-delete-var

  // @ts-expect-error -- SECURITY: intentionally deleting globals for sandbox isolation
  delete __dirname; // eslint-disable-line no-delete-var

  // @ts-expect-error -- SECURITY: intentionally deleting globals for sandbox isolation
  delete __filename; // eslint-disable-line no-delete-var

  // Delete module access
  // @ts-expect-error -- SECURITY: intentionally deleting globals for sandbox isolation
  delete global.module;
  delete global.exports;
}

/**
 * Execute code in a sandboxed environment.
 *
 * Uses `new Function()` instead of `eval()` - this creates a function
 * in the global scope with no access to the calling closure.
 */
function executeCode(code: string): {
  ok: boolean;
  output: string;
  error: string;
  durationMs: number;
} {
  const startTime = Date.now();

  try {
    // SECURITY: intentional — using Function constructor for sandbox eval (no closure access)
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(code) as () => unknown;

    // Execute the function
    const result: unknown = fn();

    // Convert result to string
    let output: string;
    if (result === undefined) {
      output = '(undefined)';
    } else if (result === null) {
      output = '(null)';
    } else if (typeof result === 'string') {
      output = result;
    } else if (typeof result === 'object') {
      // JSON.stringify with error handling for circular references
      try {
        output = JSON.stringify(result, null, 2);
      } catch {
        // Fallback for circular references — intentional [object Object] is acceptable here
        output = Object.prototype.toString.call(result);
      }
    } else {
      output = String(result as string | number | boolean | bigint | symbol);
    }

    // Check result size
    const size = Buffer.byteLength(output, 'utf8');
    if (size > MAX_RESULT_SIZE) {
      return {
        ok: false,
        output: '',
        error: `Result too large (${(size / 1024).toFixed(1)}KB, max ${String(MAX_RESULT_SIZE / 1024)}KB)`,
        durationMs: Date.now() - startTime,
      };
    }

    return { ok: true, output, error: '', durationMs: Date.now() - startTime };
  } catch (error) {
    return {
      ok: false,
      output: '',
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Process message handler (for fork IPC).
 */

// Strip dangerous globals on startup
stripDangerousGlobals();

process.on('message', (message: unknown) => {
  const msg = message as { type: string; code?: string };

  if (msg.type === 'execute' && msg.code) {
    const result = executeCode(msg.code);

    const response: ResultMessage = {
      type: 'result',
      ok: result.ok,
      output: result.output,
      error: result.error,
      durationMs: result.durationMs,
    };

    // Send response back to parent via IPC
    process.send?.(response);
  }
});
