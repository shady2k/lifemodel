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
 *     gives the instance its restart guarantee instead of killing it; a stop
 *     never waits past the budget it is given, the wait after SIGKILL included
 *     (rework 3, review round 2 finding 2);
 *   - a stop that arrives while a start is IN FLIGHT (reading the panic flag,
 *     or waiting for the OS to say the process runs) waits for that start and
 *     then stops what it started, and once the loader is closing no start
 *     happens at all (rework 3, review round 2 finding 1: a stop used to see
 *     no child there, say it had stopped, and the start then ran lifemodel
 *     with nothing left to drain it);
 *   - a start that the OPERATING SYSTEM refused - `spawn` threw, or the child
 *     emitted `error` before it ever ran - is reported as failed and is NOT
 *     retried: the same input fails the same way every time, so the owner is
 *     told instead of watching a backoff loop (rework 2, finding 6).
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

export type StartReason = 'started' | 'already-running' | 'panic' | 'failed' | 'stopping';

export interface StartOutcome {
  started: boolean;
  reason: StartReason;
}

export interface StopOutcome {
  /** False when the stop ended with lifemodel's process not accounted for (see `pending`). */
  stopped: boolean;
  /** What the stop could not finish, in words for the loader's last line; null when nothing. */
  pending: string | null;
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
  /** The loader is leaving: from now on no start happens, a restart included. */
  close(): void;
  /** Stop lifemodel; `budgetMs` caps the wait for its drain (the stop's deadline). */
  stop(reason: string, budgetMs?: number): Promise<StopOutcome>;
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
  /** Set once by `close()`: the loader is leaving and nothing starts again. */
  let closed = false;
  /** The start being made now; a stop waits for it before it looks for a child. */
  let startInFlight: Promise<StartOutcome> | null = null;
  /** The stop being made now; a start (a resume) waits for it, then decides. */
  let stopInFlight: Promise<StopOutcome> | null = null;
  /** Gives up the start in flight: a stop that will not wait for it any longer calls it. */
  let abandonStart: (() => void) | null = null;

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
    // An exit the loader asked for (panic, shutdown) is the expected end of a
    // stop; warn is kept for an exit nobody asked for.
    const log = stopping ? logger.info.bind(logger) : logger.warn.bind(logger);
    log(
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
      if (scheduledEpoch !== epoch || stopping || closed) return;
      if (await isPanicSet()) {
        logger.info({}, 'lifemodel is not restarted: panic is set');
        return;
      }
      await start();
    })();
  }

  /** A start the OS refused: one line, the reason kept, and no retry. */
  function refusedStart(reason: string): StartOutcome {
    state = 'failed';
    lastError = reason;
    logger.error({ error: reason }, 'lifemodel could not be started');
    return { started: false, reason: 'failed' };
  }

  /**
   * The launcher's own verdict on a spawn: `spawn` when the OS started the
   * process, the error when it could not. Both are attached before the answer
   * is awaited, because the error can arrive first.
   */
  function spawnOutcome(spawned: SpawnedProcess): Promise<'spawned' | Error> {
    return new Promise((resolve) => {
      spawned.onSpawn(() => {
        resolve('spawned');
      });
      spawned.onError((error) => {
        resolve(error);
      });
    });
  }

  async function start(): Promise<StartOutcome> {
    // A start asked for while a stop is draining lifemodel (a resume right
    // after a panic) waits for that stop and then decides on the panic flag as
    // it is THEN: the later intent wins, and a resume is never answered as if
    // it had started something it did not (rework 3, review round 3 finding 2).
    while (stopInFlight !== null && !closed) await stopInFlight;
    if (state === 'running' || state === 'starting' || startInFlight !== null) {
      return { started: false, reason: 'already-running' };
    }
    const attempt = startOnce().finally(() => {
      startInFlight = null;
      abandonStart = null;
    });
    startInFlight = attempt;
    return attempt;
  }

  /** Not started: the loader is closing, or a stop began while this start was being made. */
  function notStartedStopping(): StartOutcome {
    logger.info({}, 'lifemodel is not started: it is being stopped');
    return { started: false, reason: 'stopping' };
  }

  async function startOnce(): Promise<StartOutcome> {
    if (closed || stopping) return notStartedStopping();
    // A stop that will not wait for this start any longer gives it up through
    // this signal, and the start then SETTLES at once (rework 3, review round
    // 4 finding 1): it is retired, a later resume makes a fresh one, and no
    // caller waits on a verdict that may never come.
    const abandoned = new Promise<'abandoned'>((resolve) => {
      abandonStart = () => {
        resolve('abandoned');
      };
    });
    const panicSet = await Promise.race([isPanicSet(), abandoned]);
    if (panicSet === 'abandoned') return notStartedStopping();
    if (panicSet) {
      logger.info({}, 'lifemodel is not started: panic is set');
      return { started: false, reason: 'panic' };
    }
    // The panic read above is asynchronous: a stop can begin while it is
    // pending, and then nothing may be spawned.
    if (closed || stopping) return notStartedStopping();
    state = 'starting';
    let spawned: SpawnedProcess;
    try {
      spawned = launcher.spawn('node', [config.lifemodelEntry], spawnOptions());
    } catch (error) {
      return refusedStart(describe(error));
    }
    // The verdict is awaited BEFORE the child is owned. A stop that arrives
    // meanwhile waits for this whole start (`startInFlight`, bounded) and then
    // finds the child below; a stop that gives up waiting abandons it here.
    const outcome = await Promise.race([spawnOutcome(spawned), abandoned]);
    if (outcome === 'abandoned') {
      // Never owned: killed now, and killed again should the OS confirm it
      // later. The start counts as failed, so status says so and a resume
      // retries it with a fresh process.
      spawned.kill('SIGKILL');
      spawned.onSpawn(() => {
        spawned.kill('SIGKILL');
        logger.error(
          { pid: spawned.pid ?? null },
          'lifemodel was spawned after its start was given up: it is killed'
        );
      });
      return refusedStart(
        `the OS did not confirm the start of lifemodel within ${String(config.killWaitMs)} ms of a stop`
      );
    }
    if (outcome instanceof Error) {
      // It never ran, so nothing is running to stop and nothing is retried.
      return refusedStart(describe(outcome));
    }
    child = spawned;
    exit = exitSignal();
    pid = spawned.pid ?? null;
    startedAt = clock.now();
    starts += 1;
    state = 'running';
    lastError = null; // this start worked: the reason of an older failure is gone
    spawned.onExit((code, signal) => {
      settle(spawned, code, signal);
    });
    spawned.onError((error) => {
      // It had started and then failed: it is not running any more, so this is
      // a death the backoff owns, not a refused start.
      lastError = describe(error);
      logger.error({ error: lastError }, 'lifemodel could not be started');
      settle(spawned, null, null);
    });
    logger.info({ pid, entry: config.lifemodelEntry }, 'lifemodel started');
    return { started: true, reason: 'started' };
  }

  /**
   * Stop lifemodel: SIGTERM, then its drain - never longer than the budget the
   * caller has left. `docker stop` gives the whole stop one deadline, and the
   * front door has to leave inside the same one (rework 2, finding 10), so the
   * drain is the smaller of lifemodel's own 95 s and what is left of it, less
   * the room kept for SIGKILL to be reaped; and the wait after SIGKILL ends at
   * the budget too (a child stuck in the kernel is not waited for past it).
   */
  function stop(
    reason: string,
    budgetMs: number = config.drainWaitMs + config.killWaitMs
  ): Promise<StopOutcome> {
    const run = stopOnce(reason, budgetMs).finally(() => {
      if (stopInFlight === run) stopInFlight = null;
    });
    stopInFlight = run;
    return run;
  }

  async function stopOnce(reason: string, budgetMs: number): Promise<StopOutcome> {
    const deadline = clock.now() + Math.max(0, budgetMs);
    const left = (): number => Math.max(0, deadline - clock.now());
    epoch += 1; // a restart scheduled before this stop never starts anything
    stopping = true;
    // A start being made now is waited for: either it sees the stop and spawns
    // nothing, or it spawned and its child is stopped below. Its own waits are
    // the panic read and the OS's spawn verdict, both prompt - but neither is
    // trusted past the room kept for a kill, so a stalled read or a verdict
    // that never comes cannot hold the stop past its deadline (rework 3,
    // review round 3 finding 1).
    const inFlight = startInFlight;
    if (inFlight !== null) {
      const settled = await Promise.race([
        inFlight.then(() => true),
        clock.sleep(Math.min(left(), config.killWaitMs)).then(() => false),
      ]);
      if (!settled) {
        // Not the stop's deadline: its own cap on a start that should take
        // milliseconds. The start is given up and settles at once.
        abandonStart?.();
        await inFlight;
        stopping = false;
        logger.error(
          { reason, waitedMs: config.killWaitMs },
          `a start of lifemodel was still unconfirmed after ${String(config.killWaitMs)} ms: the stop gave it up`
        );
        return {
          stopped: false,
          drainTimedOut: false,
          pending: `lifemodel's start (unconfirmed after ${String(config.killWaitMs)} ms, given up)`,
        };
      }
    }
    const current = child;
    const currentExit = exit;
    if (current === null || currentExit === null) {
      stopping = false;
      state = 'stopped';
      logger.info({ reason }, 'lifemodel is not running');
      return { stopped: true, drainTimedOut: false, pending: null };
    }
    const waitMs = Math.min(config.drainWaitMs, Math.max(0, left() - config.killWaitMs));
    state = 'stopping';
    logger.info({ reason, pid }, 'stopping lifemodel: SIGTERM, then its drain');
    current.kill('SIGTERM');
    const exited = await Promise.race([
      currentExit.promise.then(() => true),
      clock.sleep(waitMs).then(() => false),
    ]);
    let drainTimedOut = false;
    if (!exited) {
      drainTimedOut = true;
      logger.error(
        { pid, drainWaitMs: waitMs },
        `lifemodel did not exit within its ${String(waitMs)} ms drain: it is killed`
      );
      current.kill('SIGKILL');
      const reaped = await Promise.race([
        currentExit.promise.then(() => true),
        clock.sleep(left()).then(() => false),
      ]);
      if (!reaped) {
        // The budget is spent: the stop does not wait any longer for a child
        // the kernel has not let go of. The caller leaves with a failure.
        stopping = false;
        logger.error(
          { pid },
          'lifemodel had not exited after SIGKILL when the stop deadline ran out'
        );
        return {
          stopped: false,
          drainTimedOut: true,
          pending: 'lifemodel (not reaped after SIGKILL by the stop deadline)',
        };
      }
    }
    stopping = false;
    state = 'stopped';
    logger.info({ reason, drainTimedOut }, 'lifemodel stopped');
    return { stopped: true, drainTimedOut, pending: null };
  }

  return {
    start,
    close: () => {
      closed = true;
    },
    stop,
    status: () => ({ state, pid, starts, restarts, startedAt, lastExit, lastError }),
  };
}
