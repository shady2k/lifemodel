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
}

export interface CommandRunner {
  run(command: string, args: string[], options?: RunOptions): Promise<CommandResult>;
}

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  uid?: number;
  gid?: number;
}

export interface SpawnedProcess {
  readonly pid: number | undefined;
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
          stdio: ['ignore', 'pipe', 'pipe'],
        });
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
        stdio: 'inherit',
      });
      return {
        pid: child.pid,
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
