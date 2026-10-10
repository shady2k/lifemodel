/**
 * Loader test doubles. Volumes and HTTP resources remain real.
 * This helper has no Vitest runtime dependency.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearTimeout, setTimeout as realTimeout } from 'node:timers';

import type { HealthProbe } from '../../loader/src/agent-vault.js';
import { createLoaderApp } from '../../loader/src/app.js';
import { hashPassword } from '../../loader/src/auth.js';
import type { Clock } from '../../loader/src/clock.js';
import { loadConfig, type LoaderConfig } from '../../loader/src/config.js';
import { createNodeFileSystem, type FileSystem } from '../../loader/src/fs.js';
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
import { FixtureLifetime } from './loader-fixture-lifetime.js';

export interface RecordedCommand {
  command: string;
  args: string[];
  options: RunOptions;
}

/** Ignore git safety settings for matching, but preserve recorded arguments. */
function withoutGitSafetyOptions(args: string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const next = args[index + 1];
    if (argument === '-c' && next !== undefined && next.startsWith('safe.directory=')) {
      index += 1;
      continue;
    }
    if (argument !== undefined) kept.push(argument);
  }
  return kept;
}

/** Tracks the entire admitted handler, including direct late filesystem writes. */
export class FakeRunner implements CommandRunner {
  readonly calls: RecordedCommand[] = [];
  private closed = false;
  private readonly admitted = new Set<Promise<CommandResult>>();
  private readonly handlers: {
    prefix: string;
    handle: (call: RecordedCommand) => CommandResult | Promise<CommandResult>;
  }[] = [];

  closeAdmission(): void {
    this.closed = true;
  }

  admittedCount(): number {
    return this.admitted.size;
  }

  async drainHandlers(): Promise<void> {
    if (!this.closed) throw new Error('Runner admission must be closed');
    // No new handlers can enter. Rejections are results, not resource leaks.
    await Promise.allSettled([...this.admitted]);
  }

  /** The most recently registered matching handler wins. */
  on(
    prefix: string,
    handle: (call: RecordedCommand) => CommandResult | Promise<CommandResult>
  ): void {
    this.handlers.unshift({ prefix, handle });
  }

  run(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    if (this.closed) return new Promise<CommandResult>(() => {});

    // Reserve before invoking even the synchronous portion of the handler.
    let resolveOperation!: (
      result: CommandResult | PromiseLike<CommandResult>
    ) => void;
    let rejectOperation!: (error: unknown) => void;
    const operation = new Promise<CommandResult>((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    this.admitted.add(operation);
    void operation.then(
      () => { this.admitted.delete(operation); },
      () => { this.admitted.delete(operation); }
    );

    const call: RecordedCommand = { command, args, options };
    this.calls.push(call);
    const line = `${command} ${withoutGitSafetyOptions(args).join(' ')}`;
    try {
      const handler = this.handlers.find((candidate) => line.startsWith(candidate.prefix));
      resolveOperation(
        handler ? handler.handle(call) : { code: 0, stdout: '', stderr: '' }
      );
    } catch (error) {
      rejectOperation(error);
    }
    return operation;
  }

  lines(): string[] {
    return this.calls.map(
      (call) => `${call.command} ${withoutGitSafetyOptions(call.args).join(' ')}`
    );
  }

  rawLines(): string[] {
    return this.calls.map((call) => `${call.command} ${call.args.join(' ')}`);
  }
}

export interface FakeChild extends SpawnedProcess {
  readonly signals: NodeJS.Signals[];
  readonly exitListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[];
  exit(code: number | null, signal?: NodeJS.Signals | null): void;
  fail(error: Error): void;
  confirmSpawn(): void;
}

export interface SpawnedFake {
  command: string;
  args: string[];
  options: SpawnOptions;
  child: FakeChild;
}

/** Fake children keep asynchronous spawn acknowledgement and explicit exits. */
export class FakeLauncher implements ProcessLauncher {
  readonly spawns: SpawnedFake[] = [];
  private closed = false;
  private eventsFrozen = false;
  private failError: { error: Error; command?: string } | null = null;
  private refuseError: { error: Error; command?: string } | null = null;
  private holding = false;

  closeAdmission(): void {
    this.closed = true;
  }

  freezeEvents(): void {
    this.eventsFrozen = true;
  }

  holdSpawns(): void {
    this.holding = true;
  }

  failSpawns(error: Error, command?: string): void {
    this.failError = { error, ...(command === undefined ? {} : { command }) };
  }

  refuseSpawns(error: Error, command?: string): void {
    this.refuseError = { error, ...(command === undefined ? {} : { command }) };
  }

  private appliesTo(
    refusal: { error: Error; command?: string } | null,
    command: string
  ): Error | null {
    if (refusal === null) return null;
    if (refusal.command !== undefined && refusal.command !== command) return null;
    return refusal.error;
  }

  spawn(command: string, args: string[], options: SpawnOptions): SpawnedProcess {
    if (this.closed) throw new Error('FakeLauncher admission is closed');
    const refused = this.appliesTo(this.refuseError, command);
    if (refused !== null) throw refused;
    const failing = this.appliesTo(this.failError, command);
    const spawnListeners: (() => void)[] = [];
    const exitListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
    const errorListeners: ((error: Error) => void)[] = [];
    let spawned = failing === null && !this.holding;
    let failure: Error | null = null;
    const child: FakeChild = {
      pid: 4000 + this.spawns.length,
      signals: [],
      exitListeners,
      kill: (signal) => {
        child.signals.push(signal);
      },
      onSpawn: (listener) => {
        if (this.eventsFrozen) return;
        if (spawned) {
          queueMicrotask(() => {
            if (!this.eventsFrozen) listener();
          });
        } else {
          spawnListeners.push(listener);
        }
      },
      onExit: (listener) => {
        if (!this.eventsFrozen) exitListeners.push(listener);
      },
      onError: (listener) => {
        if (this.eventsFrozen) return;
        if (failure !== null) {
          const error = failure;
          queueMicrotask(() => {
            if (!this.eventsFrozen) listener(error);
          });
        } else {
          errorListeners.push(listener);
        }
      },
      exit: (code, signal = null) => {
        if (this.eventsFrozen) return;
        for (const listener of exitListeners) listener(code, signal);
      },
      fail: (error) => {
        if (this.eventsFrozen) return;
        failure = error;
        for (const listener of errorListeners.splice(0)) listener(error);
      },
      confirmSpawn: () => {
        if (this.eventsFrozen) return;
        spawned = true;
        for (const listener of spawnListeners.splice(0)) listener();
      },
    };
    this.spawns.push({ command, args, options, child });
    if (failing !== null) {
      queueMicrotask(() => {
        if (this.eventsFrozen) return;
        spawned = false;
        child.fail(failing);
      });
    }
    return child;
  }
}

export interface ManualClock extends Clock {
  readonly sleeps: number[];
  advance(ms: number): void;
  /** Explicit test action only; cleanup never resolves virtual deadlines. */
  resolveAll(): void;
  pending(): number;
  /** Abandon virtual waiters without resolving them. */
  freeze(): void;
}

export function createManualClock(startMs = 1_700_000_000_000): ManualClock {
  let current = startMs;
  let frozen = false;
  const sleeps: number[] = [];
  const waiters: (() => void)[] = [];
  return {
    sleeps,
    now: () => current,
    sleep: (ms: number) => {
      sleeps.push(ms);
      if (frozen) return new Promise<void>(() => {});
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    advance: (ms: number) => {
      if (!frozen) current += ms;
    },
    resolveAll: () => {
      if (frozen) return;
      for (const resolve of waiters.splice(0)) resolve();
    },
    pending: () => waiters.length,
    freeze: () => {
      frozen = true;
      waiters.length = 0;
    },
  };
}

export async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Factory overrides may hold, record, synthesize results, or throw. ALL native
 * filesystem work MUST use the supplied guardedBase. Raw filesystem APIs,
 * unguarded delegates, and native side channels are forbidden by this mock
 * contract; this is not sandbox enforcement. Virtual holds are not native I/O.
 * Object overrides remain whole-promise tracked because they may close over
 * an unguarded delegate; admitted work must genuinely settle before deletion.
 */
export type LoaderFileSystemOverride =
  | FileSystem
  | ((guardedBase: FileSystem) => FileSystem);

export function loaderFileSystem(
  world: LoaderWorld,
  override?: LoaderFileSystemOverride
): FileSystem {
  if (override === undefined) return world.fs;
  // Factory overrides contain virtual holds. Their only native I/O must
  // delegate through guardedBase; wrapping the hold again would count an
  // inert post-fence continuation as admitted native work forever.
  if (typeof override === 'function') return override(world.fs);
  // Object overrides may close over an unguarded native filesystem, so
  // their entire already-admitted operation must genuinely settle.
  return world.fixtureLifetime.wrapFs(override);
}

export type LoaderAppRegistrar = (
  world: LoaderWorld,
  app: ReturnType<typeof createLoaderApp>
) => void;

/** Construct an app for a test that drives startup itself. */
export function testLoaderApp(
  world: LoaderWorld,
  options: {
    fs?: LoaderFileSystemOverride;
    lines: RecordedLine[];
    exits?: number[];
    exit?: (code: number) => void;
    config?: LoaderConfig;
  }
): ReturnType<typeof createLoaderApp> {
  scriptAgentVault(world);
  const exits = options.exits;
  return createLoaderApp({
    config: options.config ?? world.config,
    fs: loaderFileSystem(world, options.fs),
    runner: world.runner,
    launcher: world.launcher,
    logger: createRecordingLogger(options.lines),
    clock: world.clock,
    exit:
      options.exit ??
      ((code: number): void => {
        exits?.push(code);
      }),
    agentVaultProbe: (): Promise<boolean> => Promise.resolve(true),
  });
}

export interface RunningLoader {
  app: ReturnType<typeof createLoaderApp>;
  lines: RecordedLine[];
  exits: number[];
}

/**
 * The injected registrar runs synchronously after construction and before
 * start, including starts that subsequently fail. Consumers supply the
 * Vitest adapter; this pure helper does not import it.
 */
export async function createRunningLoader(
  world: LoaderWorld,
  options: {
    password?: string | null;
    fs?: LoaderFileSystemOverride;
    vault?: boolean;
    agentVaultProbe?: HealthProbe;
    injectAppRegistrar?: LoaderAppRegistrar;
  } = {}
): Promise<RunningLoader> {
  const password = options.password === undefined ? 'right' : options.password;
  const fs = loaderFileSystem(world, options.fs);
  if (options.vault !== false) scriptAgentVault(world);
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
    agentVaultProbe: options.agentVaultProbe ?? ((): Promise<boolean> => Promise.resolve(true)),
  });
  if (options.injectAppRegistrar !== undefined) {
    const entry = owner(world);
    try {
      invokeSynchronous(entry, 'app registrar', () => options.injectAppRegistrar!(world, app));
    } catch (error) {
      entry.errors.push(error);
      throw error;
    }
  }
  await app.start();
  await waitUntil(
    () => vaultSpawn(world) !== undefined || exits.length > 0,
    'the loader is up (or left with a reason)'
  );
  return { app, lines, exits };
}

export async function waitUntil(
  condition: () => boolean,
  what: string,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`not seen within ${timeoutMs}ms: ${what}`);
    await new Promise((resolve) => realTimeout(resolve, 2));
  }
}

export function containerHasIpv6(world: LoaderWorld, line: string): void {
  writeFileSync(world.config.egress.procPath, line);
}

export function lifemodelSpawn(world: LoaderWorld): SpawnedFake | undefined {
  return world.launcher.spawns.findLast((spawn) => spawn.args[0] === world.config.lifemodelEntry);
}

export function caddySpawn(world: LoaderWorld): SpawnedFake | undefined {
  return world.launcher.spawns.findLast((spawn) => spawn.command === world.config.caddy.binary);
}

export function vaultSpawn(world: LoaderWorld): SpawnedFake | undefined {
  return world.launcher.spawns.findLast(
    (spawn) => spawn.command === world.config.agentVault.binary && spawn.args[0] === 'server'
  );
}

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
  const vault = vaultSpawn(world);
  if (vault !== undefined) {
    await waitUntil(() => vault.child.signals.length > 0, 'Agent Vault is asked to stop');
    vault.child.exit(0, null);
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
  fixtureLifetime: FixtureLifetime;
  fs: FileSystem;
  config: LoaderConfig;
  runner: FakeRunner;
  launcher: FakeLauncher;
  clock: ManualClock;
}

/** Latches and hold releases must finish synchronously and return void. */
export type LoaderSynchronousCallback = () => void;

/**
 * Native cleanup must seal its own admission synchronously when called and
 * return a promise covering its complete native closure.
 */
export type LoaderNativeCleanup = () => Promise<unknown>;

type Diagnostic = {
  source: string;
  status: 'fulfilled' | 'rejected';
  value: unknown;
};

type OwnedRoot = {
  root: string;
  fixtureLifetime: FixtureLifetime;
  world?: LoaderWorld;
  stopping: boolean;
  stops: LoaderSynchronousCallback[];
  releases: LoaderSynchronousCallback[];
  native: LoaderNativeCleanup[];
  errors: unknown[];
  diagnostics: Diagnostic[];
  finalAccounting: boolean;
  cleanup?: Promise<void>;
};

const loaderRoots = new Map<string, OwnedRoot>();

export function ownedLoaderRoots(): readonly string[] {
  return [...loaderRoots.keys()];
}

function owner(world: LoaderWorld): OwnedRoot {
  const entry = loaderRoots.get(world.root);
  if (!entry || entry.world !== world || entry.stopping) {
    throw new Error('Loader world is not an open owned fixture');
  }
  return entry;
}

function ownedEntry(world: LoaderWorld): OwnedRoot {
  const entry = loaderRoots.get(world.root);
  if (!entry || entry.world !== world) {
    throw new Error('Loader world is not an owned fixture');
  }
  return entry;
}

function diagnostic(
  entry: OwnedRoot,
  source: string,
  status: Diagnostic['status'],
  value: unknown
): void {
  // Virtual continuations may remain parked forever or reject much later.
  // They never mutate final error accounting or authorize root deletion.
  if (!entry.finalAccounting) entry.diagnostics.push({ source, status, value });
}

function observeDiagnostic(
  entry: OwnedRoot,
  source: string,
  promise: PromiseLike<unknown>
): void {
  void Promise.resolve(promise).then(
    (value) => { diagnostic(entry, source, 'fulfilled', value); },
    (error) => { diagnostic(entry, source, 'rejected', error); }
  );
}

/**
 * TypeScript permits async functions where () => void is expected.
 * Enforce the runtime contract too. Misuse is an immediate cleanup error;
 * observe the returned promise without awaiting it or allowing an unhandled
 * rejection. Native work belongs in registerLoaderCleanup instead.
 */
function invokeSynchronous(
  entry: OwnedRoot,
  source: string,
  callback: LoaderSynchronousCallback
): void {
  const result: unknown = callback();
  if (result !== null && result !== undefined &&
      (typeof result === 'object' || typeof result === 'function')) {
    const then = (result as { then?: unknown }).then;
    if (typeof then === 'function') {
      observeDiagnostic(entry, `${source}: invalid promise`, result as PromiseLike<unknown>);
      throw new TypeError(
        `${source} must return void synchronously; register native cleanup separately`
      );
    }
  }
  if (result !== undefined) {
    throw new TypeError(`${source} must return void synchronously`);
  }
}

export function registerLoaderBeginStop(
  world: LoaderWorld,
  stop: LoaderSynchronousCallback
): void {
  owner(world).stops.push(stop);
}

export function registerLoaderCleanup(
  world: LoaderWorld,
  close: LoaderNativeCleanup
): void {
  owner(world).native.push(close);
}

/**
 * Register holds when they are created, before an operation can wait on them.
 * startPromise is diagnostic only; it is not native settlement evidence.
 */
export function registerLoaderRelease(
  world: LoaderWorld,
  release: LoaderSynchronousCallback,
  startPromise?: Promise<unknown>
): void {
  const entry = owner(world);
  let released = false;
  entry.releases.push(() => {
    if (released) return;
    released = true;
    // Preserve the runtime result so invokeSynchronous can reject misuse.
    return release();
  });
  if (startPromise !== undefined) {
    observeDiagnostic(entry, 'held startup', startPromise);
  }
}

/** Observe virtual shutdown without awaiting it or adding late cleanup errors. */
export function observeLoaderStop(world: LoaderWorld, promise: Promise<unknown>): void {
  observeDiagnostic(ownedEntry(world), 'virtual stop', promise);
}

function validateBound(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError('Real cleanup bound must be between 0 and 2147483647');
  }
}

export async function loaderRealBound<T>(
  work: Promise<T>,
  timeoutMs: number
): Promise<T> {
  // Observe even if validation fails before the race is installed.
  void work.catch(() => {});
  validateBound(timeoutMs);
  let timer: ReturnType<typeof realTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = realTimeout(
          () => reject(new Error(`Loader cleanup timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function initiate(entry: OwnedRoot): Promise<unknown>[] {
  entry.stopping = true;
  const invoke = (source: string, callback: LoaderSynchronousCallback): void => {
    try {
      invokeSynchronous(entry, source, callback);
    } catch (error) {
      entry.errors.push(error);
    }
  };

  // Set every stop latch before revoking resource admission or releasing holds.
  for (const stop of entry.stops.splice(0)) invoke('stop latch', stop);
  entry.world?.runner.closeAdmission();
  entry.world?.launcher.closeAdmission();
  entry.fixtureLifetime.closeAdmission();

  // Native closure callbacks execute now, not in a later microtask. HTTP
  // closure thereby seals its state-keyed admission before holds are released.
  const native = entry.native.splice(0).map((close) => {
    let operation: Promise<unknown>;
    try {
      operation = Promise.resolve(close());
    } catch (error) {
      operation = Promise.reject(error);
    }
    void operation.catch(() => {});
    return operation;
  });

  for (const release of entry.releases.splice(0)) invoke('hold release', release);

  // Keep clocks and fake events live until independent native settlement.
  return native;
}

function disposeEntry(entry: OwnedRoot, timeoutMs: number): Promise<void> {
  if (entry.cleanup !== undefined) return entry.cleanup;
  try {
    validateBound(timeoutMs);
  } catch (error) {
    return Promise.reject(error);
  }

  // Publish the shared cleanup promise before callbacks can reenter cleanup.
  entry.cleanup = Promise.resolve().then(async () => {
    const native = initiate(entry);
    const fences = [
      ...native,
      entry.world?.runner.drainHandlers() ?? Promise.resolve(),
      entry.fixtureLifetime.drainNativeIo(timeoutMs),
    ];
    const results = await Promise.allSettled(
      fences.map((promise) => loaderRealBound(promise, timeoutMs))
    );
    for (const result of results) {
      if (result.status === 'rejected') entry.errors.push(result.reason);
    }

    const admittedIo = entry.fixtureLifetime.admittedCount();
    const admittedHandlers = entry.world?.runner.admittedCount() ?? 0;
    const settlementComplete =
      results.every((result) => result.status === 'fulfilled') &&
      entry.fixtureLifetime.isClosed() &&
      admittedIo === 0 &&
      admittedHandlers === 0;

    if (!settlementComplete) {
      entry.errors.push(new Error(
        `Independent settlement incomplete: ${admittedIo} native operation(s), ` +
        `${admittedHandlers} runner handler(s); retain ${entry.root}`
      ));
    } else {
      // Never resolveAll() or pump a virtual deadline to get here.
      entry.world?.clock.freeze();
      entry.world?.launcher.freezeEvents();
    }

    // Only synchronous contract failures and bounded native evidence affect
    // deletion. Observers of parked virtual promises cannot add errors later.
    entry.finalAccounting = true;
    if (entry.errors.length > 0) {
      throw new AggregateError(
        [...entry.errors],
        `Retained loader root: ${entry.root}`
      );
    }

    try {
      await rm(entry.root, { recursive: true, force: true });
    } catch (error) {
      entry.errors.push(error);
      throw new AggregateError(
        [...entry.errors],
        `Retained loader ownership after root removal failed: ${entry.root}`
      );
    }
    loaderRoots.delete(entry.root);
  });
  return entry.cleanup;
}

export function cleanupWorld(world: LoaderWorld, timeoutMs = 5_000): Promise<void> {
  const entry = loaderRoots.get(world.root);
  if (!entry) return Promise.resolve();
  if (entry.world !== world) return Promise.reject(new Error('Loader ownership mismatch'));
  return disposeEntry(entry, timeoutMs);
}

export async function disposeLoaderWorlds(timeoutMs = 5_000): Promise<void> {
  const results = await Promise.allSettled(
    [...loaderRoots.values()].map((entry) => disposeEntry(entry, timeoutMs))
  );
  const errors = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Loader fixture cleanup failed');
  }
}

export interface RecordingFileSystem extends FileSystem {
  readonly chowns: string[];
  readonly freshTrees: string[];
}

export function createRecordingFileSystem(
  inner: FileSystem = createNodeFileSystem()
): RecordingFileSystem {
  const chowns: string[] = [];
  const freshTrees: string[] = [];
  return {
    ...inner,
    chowns,
    freshTrees,
    chown: (path, uid, gid) => {
      chowns.push(path);
      return inner.chown(path, uid, gid);
    },
    chownFreshTree: (path, uid, gid) => {
      freshTrees.push(path);
      return inner.chownFreshTree(path, uid, gid);
    },
  };
}

export interface LoaderWorldOptions {
  privileged?: boolean;
  identity?: { uid: number; gid: number };
}

export function createLoaderWorld(options: LoaderWorldOptions = {}): LoaderWorld {
  const fixtureLifetime = new FixtureLifetime();
  const root = mkdtempSync(join(tmpdir(), 'loader-test-'));
  // Own the root immediately, before any subsequent construction or writes.
  const entry: OwnedRoot = {
    root,
    fixtureLifetime,
    stopping: false,
    stops: [],
    releases: [],
    native: [],
    errors: [],
    diagnostics: [],
    finalAccounting: false,
  };
  loaderRoots.set(root, entry);

  try {
    const fs = fixtureLifetime.wrapFs(createNodeFileSystem());
    const identity = options.identity ?? {
      uid: typeof process.getuid === 'function' ? process.getuid() : 1000,
      gid: typeof process.getgid === 'function' ? process.getgid() : 1000,
    };
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
      agentVault: {
        ...loadConfig({}).agentVault,
        binary: join(root, 'agent-vault'),
        storeDir: join(root, 'vault'),
        caPath: join(root, 'vault-ca.pem'),
        startWaitMs: 1_000,
        stopWaitMs: 1_000,
      },
      httpPort: 0,
      privileged: options.privileged ?? false,
      lifemodel: identity,
      drainWaitMs: 5_000,
      killWaitMs: 1_000,
      stopBudgetMs: 6_000,
      restart: { initialDelayMs: 1_000, maxDelayMs: 30_000, healthyRunMs: 60_000 },
    };
    config.egress = {
      ...config.egress,
      ipv6Binary: join(root, 'ip6tables'),
      procPath: join(root, 'if-inet6'),
    };
    writeFileSync(config.seedBundle, 'a git bundle the image carries\n');
    writeFileSync(config.caddy.binary, '#!/bin/sh\n# caddy, the only web entrance\n');
    writeFileSync(config.caddy.config, ':80 {\n\trespond "the front door"\n}\n');
    writeFileSync(config.agentVault.binary, '#!/bin/sh\n# agent-vault, the keys\n');
    writeFileSync(config.egress.procPath, '');

    const world: LoaderWorld = {
      root,
      fixtureLifetime,
      fs,
      config,
      runner: new FakeRunner(),
      launcher: new FakeLauncher(),
      clock: createManualClock(),
    };
    entry.world = world;
    return world;
  } catch (error) {
    // Failed construction remains registered and is reported by suite cleanup.
    entry.errors.push(error);
    throw error;
  }
}

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

export function vaultSessionPath(world: LoaderWorld): string {
  return join(world.config.agentVault.storeDir, '.agent-vault', 'session.json');
}

export function scriptAgentVault(world: LoaderWorld, token = 'av_agt_a-test-token'): void {
  const { runner, config } = world;
  const binary = config.agentVault.binary;
  runner.on(`${binary} auth login`, () => {
    mkdirp(join(config.agentVault.storeDir, '.agent-vault'));
    writeFileSync(vaultSessionPath(world), '{"token":"a-cli-session"}');
    return { code: 0, stdout: '✓ Login successful.\n', stderr: '' };
  });
  runner.on(`${binary} vault credential-store show`, () => ({
    code: 0,
    stdout: `Vault: ${config.agentVault.vaultName}\nCredential store: builtin\n`,
    stderr: '',
  }));
  runner.on(`${binary} agent info`, () => ({
    code: 0,
    stdout: `Agent: ${config.agentVault.agentName}\nStatus:      active\n`,
    stderr: '',
  }));
  runner.on(`${binary} agent rotate`, () => ({ code: 0, stdout: `${token}\n`, stderr: '' }));
  runner.on(`${binary} ca fetch`, () => ({
    code: 0,
    stdout: '-----BEGIN CERTIFICATE-----\nMIIBthe-proxy-ca\n-----END CERTIFICATE-----\n',
    stderr: '',
  }));
}
