/**
 * The instance's repository: seeded once, then built (lifemodel-q4x.2.1,
 * stories S1, S7).
 *
 * The image carries the code as a `git bundle` WITH HISTORY, never as a
 * checkout that could overwrite the instance's work: the first start clones
 * it into the volume, gives it the upstream as its remote, and from then on
 * the instance's repository is the instance's own. A second start - after a
 * restart of the container, after `docker rm -f` - finds it and touches
 * nothing.
 */
import { join } from 'node:path';

import type { LoaderConfig } from './config.js';
import { LoaderFatalError } from './errors.js';
import type { CommandRunner } from './exec.js';
import type { FileSystem } from './fs.js';
import type { LoaderLogger } from './logger.js';
import { describe } from './state.js';

/** Where the instance's repository is: everything the loader needs to look at it. */
export interface RepositoryLocation {
  fs: FileSystem;
  config: LoaderConfig;
}

export interface RepositoryDeps extends RepositoryLocation {
  runner: CommandRunner;
  logger: LoaderLogger;
  /** Which commit is already built (the loader's own state on the volume). */
  builtCommit: () => Promise<string | null>;
  recordBuiltCommit: (commit: string) => Promise<void>;
}

export interface BuildOutcome {
  built: boolean;
  commit: string | null;
}

/** The last non-empty line of a command's error output: one line, in a log line. */
function lastLine(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines[lines.length - 1] ?? 'no output';
}

/**
 * git's own message about a failure: its FIRST line says what went wrong
 * ("fatal: detected dubious ownership in repository at ..."), and the lines
 * after it are git's advice about it. The advice is not the reason, so it must
 * not take the reason's place in a log line (rework 1: the walk's log line
 * said "git config --global --add safe.directory ..." and nothing else).
 */
function gitFailure(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines[0] ?? 'no output';
}

/**
 * The instance's repository belongs to lifemodel (uid 1000) and the loader runs
 * as root, and git REFUSES a repository whose owner is not the caller:
 *
 *   fatal: detected dubious ownership in repository at '/var/lib/lifemodel/repo'
 *
 * (rework 1: the walk reached exactly this, and the loader then claimed the
 * volume held no checkout). Every git call the loader makes on that repository
 * therefore names it as a safe directory - that ONE path, never `*`, so
 * nothing else on the volume becomes trusted by accident.
 */
function gitArgs(config: LoaderConfig, args: string[]): string[] {
  return ['-c', `safe.directory=${config.repoDir}`, ...args];
}

/**
 * The commit the instance's repository is on, or null when the volume holds no
 * repository yet (a first start, before seeding: not an error). A repository
 * that cannot be READ is an error, said with git's own message.
 */
export async function readHeadCommit(deps: RepositoryDeps): Promise<string | null> {
  const { runner, config } = deps;
  if (!(await isRepository(deps))) return null;
  const result = await runner.run('git', gitArgs(config, ['rev-parse', 'HEAD']), {
    cwd: config.repoDir,
  });
  if (result.code !== 0) {
    throw new LoaderFatalError(
      `the instance repository at ${config.repoDir} has no readable commit: ${gitFailure(result.stderr)}`
    );
  }
  return result.stdout.trim();
}

async function isRepository({ fs, config }: RepositoryLocation): Promise<boolean> {
  return fs.isDirectory(join(config.repoDir, '.git'));
}

/** The code the image carries. Without it no first start can seed an instance. */
async function requireSeedBundle({ fs, config }: RepositoryLocation): Promise<void> {
  if (await fs.exists(config.seedBundle)) return;
  throw new LoaderFatalError(
    `the seed bundle is missing at ${config.seedBundle}: the image must carry the code this instance is seeded from`
  );
}

/**
 * The loader's own input check for a volume that holds no repository yet: the
 * image must carry the code, or this instance can never be seeded. It runs
 * before the loader opens its interface, so a missing input is said once and
 * the loader leaves - unlike a failure to seed, build or start, which leaves
 * the loader up with the reason in its state (rework 1). A volume that already
 * holds the instance's repository needs no bundle, so it is not asked for one.
 */
export async function requireSeedBundleForFirstStart(location: RepositoryLocation): Promise<void> {
  if (await isRepository(location)) return;
  await requireSeedBundle(location);
}

/**
 * Clone the code the image carries into the volume, once. Returns whether it
 * seeded: an existing repository is left exactly as it is.
 */
export async function seedRepositoryIfMissing(deps: RepositoryDeps): Promise<boolean> {
  const { fs, runner, logger, config } = deps;

  if (await isRepository(deps)) {
    logger.info({ repo: config.repoDir }, 'the instance repository is already on the volume');
    return false;
  }
  if (await fs.exists(config.repoDir)) {
    throw new LoaderFatalError(
      `${config.repoDir} exists but is not a git repository: refusing to seed over it`
    );
  }
  await requireSeedBundle({ fs, config });

  logger.info({ seed: config.seedBundle, repo: config.repoDir }, 'seeding the instance repository');
  const clone = await runner.run(
    'git',
    gitArgs(config, ['clone', config.seedBundle, config.repoDir])
  );
  if (clone.code !== 0) {
    throw new LoaderFatalError(`git clone of the seed bundle failed: ${gitFailure(clone.stderr)}`);
  }

  const remotes = await runner.run('git', gitArgs(config, ['remote']), { cwd: config.repoDir });
  const names = remotes.stdout.split('\n').map((name) => name.trim());
  if (names.includes('origin')) {
    // The clone named the bundle `origin`; the instance's upstream takes that
    // place. A rename keeps the branch's tracking configuration with it.
    const renamed = await runner.run(
      'git',
      gitArgs(config, ['remote', 'rename', 'origin', 'upstream']),
      { cwd: config.repoDir }
    );
    if (renamed.code !== 0) {
      throw new LoaderFatalError(
        `could not give the instance its upstream remote: ${gitFailure(renamed.stderr)}`
      );
    }
  } else {
    const added = await runner.run(
      'git',
      gitArgs(config, ['remote', 'add', 'upstream', config.upstreamUrl]),
      { cwd: config.repoDir }
    );
    if (added.code !== 0) {
      throw new LoaderFatalError(
        `could not give the instance its upstream remote: ${gitFailure(added.stderr)}`
      );
    }
  }
  const pointed = await runner.run(
    'git',
    gitArgs(config, ['remote', 'set-url', 'upstream', config.upstreamUrl]),
    { cwd: config.repoDir }
  );
  if (pointed.code !== 0) {
    throw new LoaderFatalError(
      `could not point the upstream remote at ${config.upstreamUrl}: ${gitFailure(pointed.stderr)}`
    );
  }

  if (config.privileged) {
    try {
      await fs.chownRecursive(config.repoDir, config.lifemodel.uid, config.lifemodel.gid);
    } catch (error) {
      throw new LoaderFatalError(
        `cannot give ${config.repoDir} to uid ${String(config.lifemodel.uid)}: ${describe(error)}`,
        { cause: error }
      );
    }
  }
  logger.info(
    { repo: config.repoDir, upstream: config.upstreamUrl },
    'the instance repository is seeded'
  );
  return true;
}

/** The environment a build runs in: as lifemodel, with a home it may write. */
function buildEnvironment(config: LoaderConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: config.dataDir,
    npm_config_cache: join(config.dataDir, 'npm-cache'),
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };
}

/**
 * Build the commit lifemodel is to run, once per commit: `npm ci` and
 * `npm run build` in the instance's repository, as the instance's user. The
 * commit that was built is kept in the loader's own state, so a restart of the
 * container does not repeat a build of the same code.
 */
export async function buildIfNeeded(
  deps: RepositoryDeps,
  commit: string | null
): Promise<BuildOutcome> {
  const { fs, runner, logger, config } = deps;
  if (commit === null) {
    throw new LoaderFatalError(
      `nothing to build: ${config.repoDir} holds no git repository, so no code of this instance is on the volume`
    );
  }
  if ((await fs.exists(config.lifemodelEntry)) && (await deps.builtCommit()) === commit) {
    logger.info({ commit }, 'the current commit is already built');
    return { built: false, commit };
  }

  const identity = config.privileged
    ? { uid: config.lifemodel.uid, gid: config.lifemodel.gid }
    : {};
  const options = {
    cwd: config.repoDir,
    env: buildEnvironment(config),
    timeoutMs: config.buildTimeoutMs,
    ...identity,
  };

  logger.info({ commit }, 'installing the instance dependencies');
  const install = await runner.run('npm', ['ci'], options);
  if (install.code !== 0) {
    throw new LoaderFatalError(`npm ci failed in ${config.repoDir}: ${lastLine(install.stderr)}`);
  }

  logger.info({ commit }, 'building the instance');
  const build = await runner.run('npm', ['run', 'build'], options);
  if (build.code !== 0) {
    throw new LoaderFatalError(
      `npm run build failed in ${config.repoDir}: ${lastLine(build.stderr)}`
    );
  }

  if (!(await fs.exists(config.lifemodelEntry))) {
    throw new LoaderFatalError(
      `the build produced no ${config.lifemodelEntry}: the repository's build script does not write what the loader starts`
    );
  }
  await deps.recordBuiltCommit(commit);
  logger.info({ commit }, 'the instance is built');
  return { built: true, commit };
}
