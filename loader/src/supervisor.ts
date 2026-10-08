/**
 * lifemodel's process, from the loader's side (lifemodel-q4x.2.1, stories S1,
 * S6, S8).
 *
 * The loader is the container's main process and lifemodel is its child. That
 * is what makes three promises keepable:
 *
 *   - a start is REFUSED while panic is set, and a lifemodel that died is not
 *     brought back while panic is set either;
 *   - a lifemodel that dies on its own is started again, after a growing
 *     backoff, so a crash loop does not become a busy loop;
 *   - SIGTERM is FORWARDED and its exit is awaited for the length of
 *     lifemodel's own drain (95 s against a 90 s drain), so `docker stop`
 *     gives the instance its restart guarantee instead of killing it.
 */
import type { Clock } from './clock.js';
import type { LoaderConfig } from './config.js';
import type { ProcessLauncher, SpawnOptions, SpawnedProcess } from './exec.js';
import type { LoaderLogger } from './logger.js';
import { describe } from './state.js';

export type LifemodelProcessState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export interface LifemodelExit {
  code: number | null;
  signal: string | null;
  at: number;
  /** How long the child ran: a run past the healthy mark resets the backoff. */
  ranMs: number;
}

export interface LifemodelStatus {
  state: LifemodelProcessState;
  pid: number | null;
  /** Every start since the loader came up, including the restarts. */
  starts: number;
  /** How many of those were restarts after a death. */
  restarts: number;
  startedAt: number | null;
  lastExit: LifemodelExit | null;
  lastError: string | null;
}

export type StartReason = 'started' | 'already-running' | 'panic' | 'failed';

export interface StartOutcome {
  started: boolean;
  reason: StartReason;
}

export interface StopOutcome {
  stopped: boolean;
  /** lifemodel was still running when its drain ran out and was killed. */
  drainTimedOut: boolean;
}

export interface SupervisorDeps {
  launcher: ProcessLauncher;
  logger: LoaderLogger;
  clock: Clock;
  config: LoaderConfig;
  /** The root-only panic flag on the volume. */
  isPanicSet: () => Promise<boolean>;
}

export interface Supervisor {
  start(): Promise<StartOutcome>;
  stop(reason: string): Promise<StopOutcome>;
  status(): LifemodelStatus;
}

/** The environment lifemodel runs in: its data on the volume, a home it may write. */
function childEnvironment(config: LoaderConfig): NodeJS.ProcessEnv {
  return { ...process.env, DATA_PATH: config.dataDir, HOME: config.dataDir };
}

interface ExitSignal {
  promise: Promise<void>;
  resolve: () => void;
}

function exitSignal(): ExitSignal {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  const { launcher, logger, clock, config, isPanicSet } = deps;

  let state: LifemodelProcessState = 'stopped';
  let child: SpawnedProcess | null = null;
  let exit: ExitSignal | null = null;
  let pid: number | null = null;
  let startedAt: number | null = null;
  let starts = 0;
  let restarts = 0;
  let lastExit: LifemodelExit | null = null;
  let lastError: string | null = null;
  let consecutiveFailures = 0;
  /** Bumped by every stop: a restart scheduled for an older epoch is dropped. */
  let epoch = 0;
  let stopping = false;

  function spawnOptions(): SpawnOptions {
    const options: SpawnOptions = {
      cwd: config.volumeRoot,
      env: childEnvironment(config),
    };
    if (config.privileged) {
      options.uid = config.lifemodel.uid;
      options.gid = config.lifemodel.gid;
    }
    return options;
  }

  function settle(spawned: SpawnedProcess, code: number | null, signal: string | null): void {
    if (child !== spawned) return; // an older child, already replaced or stopped
    const ranMs = startedAt === null ? 0 : clock.now() - startedAt;
    lastExit = { code, signal, at: clock.now(), ranMs };
    child = null;
    pid = null;
    startedAt = null;
    state = 'stopped';
    const signal_ = exit;
    exit = null;
    signal_?.resolve();
    logger.warn(
      { code, signal, ranMs },
      code === null && signal === null
        ? 'lifemodel did not start'
        : `lifemodel exited (code ${String(code ?? signal)})`
    );
    if (stopping) return; // the stop is waiting for exactly this
    scheduleRestart(ranMs);
  }

  function scheduleRestart(ranMs: number): void {
    if (ranMs >= config.restart.healthyRunMs) consecutiveFailures = 0;
    else consecutiveFailures += 1;
    const delay = Math.min(
      config.restart.initialDelayMs * 2 ** Math.max(0, consecutiveFailures - 1),
      config.restart.maxDelayMs
    );
    restarts += 1;
    const scheduledEpoch = epoch;
    logger.info(
      { delayMs: delay, failures: consecutiveFailures },
      'lifemodel is started again after a backoff'
    );
    void (async () => {
      await clock.sleep(delay);
      if (scheduledEpoch !== epoch || stopping) return;
      if (await isPanicSet()) {
        logger.info({}, 'lifemodel is not restarted: panic is set');
        return;
      }
      await start();
    })();
  }

  async function start(): Promise<StartOutcome> {
    if (state === 'running' || state === 'starting') {
      return { started: false, reason: 'already-running' };
    }
    if (await isPanicSet()) {
      logger.info({}, 'lifemodel is not started: panic is set');
      return { started: false, reason: 'panic' };
    }
    state = 'starting';
    let spawned: SpawnedProcess;
    try {
      spawned = launcher.spawn('node', [config.lifemodelEntry], spawnOptions());
    } catch (error) {
      state = 'failed';
      lastError = describe(error);
      logger.error({ error: lastError }, 'lifemodel could not be started');
      return { started: false, reason: 'failed' };
    }
    child = spawned;
    exit = exitSignal();
    pid = spawned.pid ?? null;
    startedAt = clock.now();
    starts += 1;
    state = 'running';
    spawned.onExit((code, signal) => {
      settle(spawned, code, signal);
    });
    spawned.onError((error) => {
      lastError = describe(error);
      logger.error({ error: lastError }, 'lifemodel could not be started');
      settle(spawned, null, null);
    });
    logger.info({ pid, entry: config.lifemodelEntry }, 'lifemodel started');
    return { started: true, reason: 'started' };
  }

  async function stop(reason: string): Promise<StopOutcome> {
    epoch += 1; // a restart scheduled before this stop never starts anything
    stopping = true;
    const current = child;
    const currentExit = exit;
    if (current === null || currentExit === null) {
      stopping = false;
      state = 'stopped';
      logger.info({ reason }, 'lifemodel is not running');
      return { stopped: true, drainTimedOut: false };
    }
    state = 'stopping';
    logger.info({ reason, pid }, 'stopping lifemodel: SIGTERM, then its drain');
    current.kill('SIGTERM');
    const exited = await Promise.race([
      currentExit.promise.then(() => true),
      clock.sleep(config.drainWaitMs).then(() => false),
    ]);
    let drainTimedOut = false;
    if (!exited) {
      drainTimedOut = true;
      logger.error(
        { pid, drainWaitMs: config.drainWaitMs },
        `lifemodel did not exit within its ${String(config.drainWaitMs)} ms drain: it is killed`
      );
      current.kill('SIGKILL');
      await currentExit.promise;
    }
    stopping = false;
    state = 'stopped';
    logger.info({ reason, drainTimedOut }, 'lifemodel stopped');
    return { stopped: true, drainTimedOut };
  }

  return {
    start,
    stop,
    status: () => ({ state, pid, starts, restarts, startedAt, lastExit, lastError }),
  };
}
