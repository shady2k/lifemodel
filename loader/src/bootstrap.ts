/**
 * First start, and every start after it (lifemodel-q4x.2.1, stories S1, S6, S7).
 *
 * One path, taken once: seed the instance's repository on the volume from the
 * code the image carries, build the commit that is checked out, start
 * lifemodel. It is idempotent - an existing repository is reused, a commit
 * that is already built is not built again - and it is single-flight, so the
 * browser and the command line can ask for it at the same time without two
 * builds running.
 *
 * A failure here does NOT end the loader (rework 1: the walk's build failure
 * restart-looped the container instead of showing the owner what was wrong).
 * It is recorded in the status - phase `failed`, with the reason - and said
 * once in one error line; the loader keeps serving its interface, and the
 * owner's next `lifemodel resume` (or the page's resume button) is the retry.
 * `ensureReady` therefore never rejects; a caller reads the outcome from
 * `status()`.
 */
import type { Clock } from './clock.js';
import type { LoaderConfig } from './config.js';
import { LoaderFatalError } from './errors.js';
import type { CommandRunner } from './exec.js';
import type { FileSystem } from './fs.js';
import type { LoaderLogger } from './logger.js';
import {
  buildIfNeeded,
  readHeadCommit,
  seedRepositoryIfMissing,
  type RepositoryDeps,
} from './repo.js';
import type { LoaderState } from './state.js';
import { describe } from './state.js';
import type { LifemodelProcessState, Supervisor } from './supervisor.js';

export type BootstrapPhase = 'idle' | 'seeding' | 'building' | 'starting' | 'failed';

/** What `lifemodel status` and the loader's own page report. */
export interface InstanceStatus {
  lifemodel: LifemodelProcessState;
  commit: string | null;
  panic: boolean;
  pid: number | null;
  restarts: number;
  phase: BootstrapPhase;
  /**
   * The instance did not come up, whatever the reason and whoever found it:
   * this bootstrap's own failure, or a start the OS refused (rework 2,
   * finding 6). The page and the command line read this one flag.
   */
  failed: boolean;
  lastError: string | null;
}

export interface BootstrapDeps {
  fs: FileSystem;
  runner: CommandRunner;
  logger: LoaderLogger;
  config: LoaderConfig;
  state: LoaderState;
  supervisor: Supervisor;
  clock: Clock;
  /** What a build of the instance's code is given to leave through the proxy. */
  proxyEnvironment?: () => NodeJS.ProcessEnv;
}

export interface Bootstrap {
  /**
   * Seed, build and start, once. Concurrent callers share the one run, and it
   * never rejects: a failure is the instance's state, not the caller's error.
   */
  ensureReady(source: string): Promise<void>;
  status(): Promise<InstanceStatus>;
}

export function createBootstrap(deps: BootstrapDeps): Bootstrap {
  const { fs, runner, logger, config, state, supervisor } = deps;
  const repository: RepositoryDeps = {
    fs,
    runner,
    logger,
    config,
    builtCommit: () => state.readBuiltCommit(),
    recordBuiltCommit: (commit) => state.writeBuiltCommit(commit),
    ...(deps.proxyEnvironment === undefined ? {} : { proxyEnvironment: deps.proxyEnvironment }),
  };

  let phase: BootstrapPhase = 'idle';
  let lastError: string | null = null;
  let inFlight: Promise<void> | null = null;

  async function run(source: string): Promise<void> {
    // A new attempt clears the failure it is retrying: the page says where the
    // instance is now (seeding, building, starting), not where it was.
    lastError = null;
    phase = 'seeding';
    const seeded = await seedRepositoryIfMissing(repository);

    phase = 'building';
    const commit = await readHeadCommit(repository);
    const build = await buildIfNeeded(repository, commit);

    phase = 'starting';
    const started = await supervisor.start();
    if (started.reason === 'failed') {
      // The OS refused the start: the loader keeps the reason (rework 2,
      // finding 6) instead of announcing an instance that never came up.
      throw new LoaderFatalError(supervisor.status().lastError ?? 'lifemodel could not be started');
    }

    phase = 'idle';
    if (!started.started) {
      // Panic holds it down, or it was already running: neither is readiness,
      // and neither is a failure.
      logger.info({ source, reason: started.reason }, 'the instance is not started');
      return;
    }
    logger.info(
      {
        source,
        seeded,
        built: build.built,
        started: true,
        commit,
      },
      'the instance is ready'
    );
  }

  function ensureReady(source: string): Promise<void> {
    if (inFlight !== null) return inFlight;
    const promise = run(source).catch((error: unknown) => {
      phase = 'failed';
      lastError = describe(error);
      // One line, what and why. The loader stays up: its page, `lifemodel
      // status` and the JSON all report failed with this reason, and login,
      // panic and resume keep working.
      logger.error({ source, error: lastError }, `the instance did not come up: ${lastError}`);
    });
    inFlight = promise.finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  /**
   * The commit, or null when the repository cannot be read. A status answers
   * in every state the instance can be in - it is how the owner finds out -
   * and `phase` with `lastError` carries the reason a read failed.
   */
  async function commitOrNull(): Promise<string | null> {
    try {
      return await readHeadCommit(repository);
    } catch {
      return null;
    }
  }

  return {
    ensureReady,
    status: async () => {
      const process_ = supervisor.status();
      return {
        lifemodel: process_.state,
        commit: await commitOrNull(),
        panic: await state.isPanicSet(),
        pid: process_.pid,
        restarts: process_.restarts,
        phase,
        failed: phase === 'failed' || process_.state === 'failed',
        lastError: lastError ?? process_.lastError,
      };
    },
  };
}
