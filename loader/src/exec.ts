/** Run bounded platform bootstrap commands behind one testable boundary. */
import { spawn } from 'node:child_process';

/** Bound escalation after a bootstrap command is cancelled. */
const ABORT_KILL_WAIT_MS = 5_000;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /**
   * Kill the command when this signal aborts: the loader's stop aborts the
   * command still belongs to the loader until it has been reaped. The command rejects with the
   * cancellation like a timeout does - but only ONCE THE CHILD IS REAPED:
   * the SIGTERM is escalated to SIGKILL under the command's own shared
   * deadline, and a child that ignores SIGTERM keeps the command's ownership
   * (its promise unsettled) until it is reaped.
   */
  signal?: AbortSignal;
  /**
   * One line written to the command's standard input, which is then closed.
   * A bootstrap command can receive one input line before stdin closes.
   */
  stdin?: string;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: RunOptions): Promise<CommandResult>;
}

export function createNodeRunner(): CommandRunner {
  return {
    run: (command, args, options = {}) =>
      new Promise<CommandResult>((resolve, reject) => {
        const child = spawn(command, args, {
          cwd: options.cwd,
          env: options.env,
          // Input is always a pipe that is closed at once, so a command
          // reading nothing sees end-of-input exactly as it did before, and a
          // command that needs a line (`--password-stdin`) gets it here.
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        // The command may exit before it reads - a refused password, a server
        // that is not up yet - and then the pipe breaks under the write. That
        // is the command's own answer, reported through its exit code below,
        // not an error of the loader's.
        child.stdin.on('error', () => undefined);
        child.stdin.end(options.stdin ?? '');
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let cancelled = false;
        let spawnError: Error | undefined;
        let settled = false;
        const startedAt = Date.now();
        const timer =
          options.timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                timedOut = true;
                child.kill('SIGKILL');
              }, options.timeoutMs);
        /**
         * Cancellation is the loader's to carry through to the child's death:
         * a promise that settled on the abort would report a command the OS
         * child of which is still alive (the round-2 review's N2 - a child
         * that ignores SIGTERM outlives the rejection). So the promise stays
         * owned until `close` - the child is REAPED - and the SIGTERM is
         * escalated to SIGKILL under the command's own shared deadline, never
         * later than `ABORT_KILL_WAIT_MS` after it.
         */
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = (): void => {
          if (cancelled || settled) return;
          cancelled = true;
          child.kill('SIGTERM');
          const sharedRemaining =
            options.timeoutMs === undefined
              ? ABORT_KILL_WAIT_MS
              : Math.max(0, options.timeoutMs - (Date.now() - startedAt));
          killTimer = setTimeout(
            () => child.kill('SIGKILL'),
            Math.min(ABORT_KILL_WAIT_MS, sharedRemaining)
          );
        };
        if (options.signal?.aborted === true) onAbort();
        options.signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        // The error event is NOT the child's death: a failed spawn (no binary)
        // is followed by `close`, and an abort's AbortError arrives while the
        // child may still be alive. Recorded here; the promise settles below,
        // when the child is reaped.
        child.on('error', (error) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          options.signal?.removeEventListener('abort', onAbort);
          reject(error);
        });
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          options.signal?.removeEventListener('abort', onAbort);
          // A child that died by OUR cancellation or the timeout never said
          // its work was done: its rejection says so, once it is reaped.
          if (cancelled && code === null) {
            reject(new Error(`${command} ${args.join(' ')} was cancelled`));
            return;
          }
          if (timedOut && code === null) {
            reject(new Error(`${command} ${args.join(' ')} timed out`));
            return;
          }
          if (spawnError !== undefined) {
            reject(spawnError);
            return;
          }
          resolve({ code: code ?? -1, stdout, stderr });
        });
      }),
  };
}

