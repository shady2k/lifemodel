/**
 * Running programs, behind two interfaces (lifemodel-q4x.2.1).
 *
 * `CommandRunner` is the short-lived work: git, npm. `ProcessLauncher` is the
 * long-lived one: lifemodel itself, whose stdout must reach the container's
 * log untouched. Both are doubled in tests, because the loader runs
 * unprivileged there and must not depend on a real git, npm or lifemodel.
 */
import { spawn } from 'node:child_process';

/**
 * How long a CANCELLED command is allowed to sit out its SIGTERM before the
 * runner stops asking and kills it: a provisioning CLI that ignores SIGTERM
 * must not hold the loader's stop past this bound (the command's own
 * `timeoutMs`, when one was given, is the shared deadline the escalation
 * never runs past).
 */
const ABORT_KILL_WAIT_MS = 5_000;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  gid?: number;
  timeoutMs?: number;
  /**
   * Kill the command when this signal aborts: the loader's stop aborts the
   * commands its startup is still running (they are root-owned work, and the
   * stop must reach everything a start made). The command rejects with the
   * cancellation like a timeout does - but only ONCE THE CHILD IS REAPED:
   * the SIGTERM is escalated to SIGKILL under the command's own shared
   * deadline, and a child that ignores SIGTERM keeps the command's ownership
   * (its promise unsettled) until it is reaped.
   */
  signal?: AbortSignal;
  /**
   * One line written to the command's standard input, which is then closed.
   * Agent Vault's CLI takes its master password (and the password of the
   * owner account the loader registers) through `--password-stdin` and
   * nothing else, so a command that needs one is handed it here - and a
   * command with no input behaves exactly as before.
   */
  stdin?: string;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: RunOptions): Promise<CommandResult>;
}

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  uid?: number;
  gid?: number;
  /**
   * One line written to the child's standard input, which is then closed.
   * Agent Vault's server takes the password that protects its store through
   * `--password-stdin`: an EMPTY line is the passwordless store the instance
   * runs (decision 4 - the store is protected by the directory's permissions,
   * not by a password). Without this the server would wait for a terminal
   * that a container does not have.
   */
  stdin?: string;
}

export interface SpawnedProcess {
  readonly pid: number | undefined;
  /**
   * The operating system really started this process. `spawn` returning is not
   * that fact: a spawn that fails (no such binary, a setuid the kernel refuses)
   * reports it asynchronously, so a caller that must not announce a start that
   * never happened waits for this (rework 2, finding 6).
   */
  onSpawn(listener: () => void): void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: (error: Error) => void): void;
  kill(signal: NodeJS.Signals): void;
}

export interface ProcessLauncher {
  spawn(command: string, args: string[], options: SpawnOptions): SpawnedProcess;
}

export function createNodeRunner(): CommandRunner {
  return {
    run: (command, args, options = {}) =>
      new Promise<CommandResult>((resolve, reject) => {
        const child = spawn(command, args, {
          cwd: options.cwd,
          env: options.env,
          uid: options.uid,
          gid: options.gid,
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

export function createNodeLauncher(): ProcessLauncher {
  return {
    spawn: (command, args, options) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        uid: options.uid,
        gid: options.gid,
        // Only a child that is handed a line gets a pipe for its input; every
        // other one keeps the container's own stdio, untouched.
        stdio: options.stdin === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
      });
      if (options.stdin !== undefined && child.stdin !== null) {
        child.stdin.on('error', () => undefined);
        child.stdin.end(options.stdin);
      }
      return {
        pid: child.pid,
        onSpawn: (listener) => {
          child.on('spawn', listener);
        },
        onExit: (listener) => {
          child.on('exit', (code, signal) => {
            listener(code, signal);
          });
        },
        onError: (listener) => {
          child.on('error', listener);
        },
        kill: (signal) => {
          child.kill(signal);
        },
      };
    },
  };
}
