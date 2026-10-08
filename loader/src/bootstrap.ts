/**
 * First start, and every start after it (lifemodel-q4x.2.1, stories S1, S6, S7).
 *
 * One path, taken once: seed the instance's repository on the volume from the
 * code the image carries, build the commit that is checked out, start
 * lifemodel. It is idempotent - an existing repository is reused, a commit
 * that is already built is not built again - and it is single-flight, so the
 * browser and the command line can ask for it at the same time without two
 * builds running.
 */
import type { Clock } from './clock.js';
import type { LoaderConfig } from './config.js';
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
}

export interface Bootstrap {
  /** Seed, build and start, once. Concurrent callers share the one run. */
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
  };

  let phase: BootstrapPhase = 'idle';
  let lastError: string | null = null;
  let inFlight: Promise<void> | null = null;

  async function run(source: string): Promise<void> {
    phase = 'seeding';
    const seeded = await seedRepositoryIfMissing(repository);

    phase = 'building';
    const commit = await readHeadCommit(repository);
    const build = await buildIfNeeded(repository, commit);

    phase = 'starting';
    const started = await supervisor.start();

    phase = 'idle';
    logger.info(
      {
        source,
        seeded,
        built: build.built,
        started: started.started,
        reason: started.reason,
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
      throw error;
    });
    inFlight = promise.finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    ensureReady,
    status: async () => {
      const process_ = supervisor.status();
      return {
        lifemodel: process_.state,
        commit: await readHeadCommit(repository),
        panic: await state.isPanicSet(),
        pid: process_.pid,
        restarts: process_.restarts,
        phase,
        lastError: process_.lastError ?? lastError,
      };
    },
  };
}
