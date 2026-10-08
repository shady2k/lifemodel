/**
 * Running programs, behind two interfaces (lifemodel-q4x.2.1).
 *
 * `CommandRunner` is the short-lived work: git, npm. `ProcessLauncher` is the
 * long-lived one: lifemodel itself, whose stdout must reach the container's
 * log untouched. Both are doubled in tests, because the loader runs
 * unprivileged there and must not depend on a real git, npm or lifemodel.
 */
import { spawn } from 'node:child_process';

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
        const timer =
          options.timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                timedOut = true;
                child.kill('SIGKILL');
              }, options.timeoutMs);
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        child.on('error', (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        });
        child.on('close', (code) => {
          if (timer) clearTimeout(timer);
          if (timedOut) {
            reject(new Error(`${command} ${args.join(' ')} timed out`));
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
