/**
 * The doubles the loader's tests use (lifemodel-q4x.2.1).
 *
 * The loader runs unprivileged in a test, so the two boundaries it needs root
 * for - starting lifemodel as uid 1000 and running git/npm - are doubled here
 * and nothing else: the volume is a real directory, the files are really
 * written, the HTTP server really listens.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLoaderApp } from '../../loader/src/app.js';
import { hashPassword } from '../../loader/src/auth.js';
import type { Clock } from '../../loader/src/clock.js';
import { loadConfig, type LoaderConfig } from '../../loader/src/config.js';
import { createNodeFileSystem } from '../../loader/src/fs.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';
import { createLoaderState } from '../../loader/src/state.js';
import type {
  CommandResult,
  CommandRunner,
  ProcessLauncher,
  RunOptions,
  SpawnOptions,
  SpawnedProcess,
} from '../../loader/src/exec.js';

export interface RecordedCommand {
  command: string;
  args: string[];
  options: RunOptions;
}

/**
 * git's own safety options for the instance's repository - `-c
 * safe.directory=<the repository>` - taken out of a command line: they say HOW
 * the loader made git trust the repository, not WHICH command it ran, so the
 * matching and `lines()` leave them out. `rawLines()` and the recorded `args`
 * keep every argument, and one test asserts on them (rework 1: git refuses a
 * repository its caller does not own).
 */
function withoutGitSafetyOptions(args: string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const next = args[index + 1];
    if (argument === '-c' && next !== undefined && next.startsWith('safe.directory=')) {
      index += 1; // the option and its value belong together
      continue;
    }
    if (argument !== undefined) kept.push(argument);
  }
  return kept;
}

/** A command runner whose answers a test writes: `git clone`, `npm ci`, ... */
export class FakeRunner implements CommandRunner {
  readonly calls: RecordedCommand[] = [];
  private readonly handlers: {
    prefix: string;
    handle: (call: RecordedCommand) => CommandResult | Promise<CommandResult>;
  }[] = [];

  /** Answer every command line that starts with `prefix`; the last word wins. */
  on(
    prefix: string,
    handle: (call: RecordedCommand) => CommandResult | Promise<CommandResult>
  ): void {
    this.handlers.unshift({ prefix, handle });
  }

  async run(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    const call: RecordedCommand = { command, args, options };
    this.calls.push(call);
    const line = `${command} ${withoutGitSafetyOptions(args).join(' ')}`;
    for (const handler of this.handlers) {
      if (line.startsWith(handler.prefix)) return handler.handle(call);
    }
    return { code: 0, stdout: '', stderr: '' };
  }

  /** Every command line run so far, as one string per call. */
  lines(): string[] {
    return this.calls.map((call) => `${call.command} ${withoutGitSafetyOptions(call.args).join(' ')}`);
  }

  /** The same lines with every argument as it was passed, git's options included. */
  rawLines(): string[] {
    return this.calls.map((call) => `${call.command} ${call.args.join(' ')}`);
  }
}

export interface FakeChild extends SpawnedProcess {
  readonly signals: NodeJS.Signals[];
  readonly exitListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[];
  /** The test decides when the child dies. */
  exit(code: number | null, signal?: NodeJS.Signals | null): void;
}

export interface SpawnedFake {
  command: string;
  args: string[];
  options: SpawnOptions;
  child: FakeChild;
}

/** A launcher whose children only die when the test says so. */
export class FakeLauncher implements ProcessLauncher {
  readonly spawns: SpawnedFake[] = [];

  spawn(command: string, args: string[], options: SpawnOptions): SpawnedProcess {
    const exitListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
    const errorListeners: ((error: Error) => void)[] = [];
    const child: FakeChild = {
      pid: 4000 + this.spawns.length,
      signals: [],
      exitListeners,
      kill: (signal) => {
        child.signals.push(signal);
      },
      onExit: (listener) => {
        exitListeners.push(listener);
      },
      onError: (listener) => {
        errorListeners.push(listener);
      },
      exit: (code, signal = null) => {
        for (const listener of exitListeners) listener(code, signal);
      },
    };
    this.spawns.push({ command, args, options, child });
    return child;
  }
}

export interface ManualClock extends Clock {
  readonly sleeps: number[];
  advance(ms: number): void;
  /** Let every waiting sleep finish (a backoff, a drain deadline). */
  resolveAll(): void;
  pending(): number;
}

/** A clock a test drives: nothing waits on a real timer. */
export function createManualClock(startMs = 1_700_000_000_000): ManualClock {
  let current = startMs;
  const sleeps: number[] = [];
  const waiters: (() => void)[] = [];
  return {
    sleeps,
    now: () => current,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    advance: (ms: number) => {
      current += ms;
    },
    resolveAll: () => {
      for (const resolve of waiters.splice(0)) resolve();
    },
    pending: () => waiters.length,
  };
}

/** Let every pending promise chain of the loader run to its next wait. */
export async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** A loader that is up, with the two children it owns doubled. */
export interface RunningLoader {
  app: ReturnType<typeof createLoaderApp>;
  lines: RecordedLine[];
  exits: number[];
}

/**
 * Bring a loader up on a volume of its own, with a password already set (as
 * the owner would have set it through boot.<host>) unless asked otherwise.
 */
export async function createRunningLoader(
  world: LoaderWorld,
  options: { password?: string | null } = {}
): Promise<RunningLoader> {
  const password = options.password === undefined ? 'right' : options.password;
  const fs = createNodeFileSystem();
  const state = createLoaderState({ fs, config: world.config, logger: createRecordingLogger([]) });
  await state.ensureLayout();
  if (password !== null) await state.writeAuth(await hashPassword(password));
  const lines: RecordedLine[] = [];
  const exits: number[] = [];
  const app = createLoaderApp({
    config: world.config,
    fs,
    runner: world.runner,
    launcher: world.launcher,
    logger: createRecordingLogger(lines),
    clock: world.clock,
    exit: (code) => exits.push(code),
  });
  await app.start();
  await waitUntil(
    () => caddySpawn(world) !== undefined || exits.length > 0,
    'the loader is up (or left with a reason)'
  );
  return { app, lines, exits };
}

/** Wait for the event a test asserts on (a spawn, a file), never for a tick count. */
export async function waitUntil(
  condition: () => boolean,
  what: string,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`not seen within ${timeoutMs}ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** The child the loader started for lifemodel (the front door starts first). */
export function lifemodelSpawn(world: LoaderWorld): SpawnedFake | undefined {
  return world.launcher.spawns.findLast((spawn) => spawn.args[0] === world.config.lifemodelEntry);
}

/** The child the loader started for the front door. */
export function caddySpawn(world: LoaderWorld): SpawnedFake | undefined {
  return world.launcher.spawns.findLast((spawn) => spawn.command === world.config.caddy.binary);
}

/**
 * Stop the loader the way the container does, and let the front door leave:
 * a test that never stops Caddy would hang on the loader's own shutdown.
 */
export async function shutdownLoader(
  world: LoaderWorld,
  app: { shutdown(reason: string): Promise<number> },
  reason = 'test'
): Promise<number> {
  const leaving = app.shutdown(reason);
  const lifemodel = lifemodelSpawn(world);
  if (lifemodel !== undefined) {
    await waitUntil(() => lifemodel.child.signals.length > 0, 'lifemodel is asked to stop');
    lifemodel.child.exit(0, null);
  }
  const caddy = caddySpawn(world);
  if (caddy !== undefined) {
    await waitUntil(() => caddy.child.signals.length > 0, 'the front door is asked to stop');
    caddy.child.exit(0, null);
  }
  return leaving;
}

export interface LoaderWorld {
  root: string;
  config: LoaderConfig;
  runner: FakeRunner;
  launcher: FakeLauncher;
  clock: ManualClock;
}

/**
 * A volume of its own in /tmp: the same layout the image gives the loader, on
 * a filesystem a test may really write to.
 */
export function createLoaderWorld(): LoaderWorld {
  const root = mkdtempSync(join(tmpdir(), 'loader-test-'));
  const config: LoaderConfig = {
    ...loadConfig({}),
    volumeRoot: root,
    repoDir: join(root, 'repo'),
    dataDir: join(root, 'data'),
    loaderDir: join(root, 'loader'),
    seedBundle: join(root, 'seed.bundle'),
    lifemodelEntry: join(root, 'repo', 'dist', 'index.js'),
    caddy: {
      binary: join(root, 'caddy'),
      config: join(root, 'Caddyfile'),
      stopWaitMs: 1_000,
    },
    httpPort: 0,
    privileged: false,
    drainWaitMs: 5_000,
    restart: { initialDelayMs: 1_000, maxDelayMs: 30_000, healthyRunMs: 60_000 },
  };
  writeFileSync(config.seedBundle, 'a git bundle the image carries\n');
  // The front door the image carries: the loader starts it, so the test
  // volume holds the two files it needs.
  writeFileSync(config.caddy.binary, '#!/bin/sh\n# caddy, the only web entrance\n');
  writeFileSync(config.caddy.config, ':80 {\n\trespond "the front door"\n}\n');
  return {
    root,
    config,
    runner: new FakeRunner(),
    launcher: new FakeLauncher(),
    clock: createManualClock(),
  };
}

/**
 * What the real git and npm would do to a volume: a repository on the commit
 * the test names, dependencies installed, the entry built. Registered on a
 * FakeRunner so the loader's own sequencing is what is under test.
 */
export function scriptRepository(
  world: LoaderWorld,
  commit = 'c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ff'
): void {
  const { runner, config } = world;
  runner.on('git clone', () => {
    mkdirp(join(config.repoDir, '.git'));
    return { code: 0, stdout: '', stderr: '' };
  });
  runner.on('git remote', () => ({ code: 0, stdout: 'origin\n', stderr: '' }));
  runner.on('git rev-parse HEAD', () => ({ code: 0, stdout: `${commit}\n`, stderr: '' }));
  runner.on('npm ci', () => ({ code: 0, stdout: 'added 1 package\n', stderr: '' }));
  runner.on('npm run build', () => {
    mkdirp(join(config.repoDir, 'dist'));
    writeFileSync(config.lifemodelEntry, '// the built instance\n');
    return { code: 0, stdout: '', stderr: '' };
  });
}

function mkdirp(path: string): void {
  mkdirSync(path, { recursive: true });
}
