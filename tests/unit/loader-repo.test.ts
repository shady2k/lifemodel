/**
 * git on the instance's repository (lifemodel-q4x.2.1 rework 1, defect 1).
 *
 * The loader runs as root and the instance's repository belongs to lifemodel
 * (uid 1000), and git REFUSES a repository its caller does not own. The walk
 * in the real container hit exactly that, and the loader then said the volume
 * held no checkout - so this file covers both halves of the defect: every git
 * call the loader makes on that repository names it as a safe directory (that
 * one path, never `*`), and a git failure is reported with git's OWN message
 * rather than with the advice git prints under it.
 *
 * The doubles are at the command boundary only: the volume is a real
 * directory, the files are really written.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createLoaderApp } from '../../loader/src/app.js';
import {
  ownLoaderApp,
  registerLoaderLifecycle,
} from '../helpers/loader-lifecycle.js';
import { createRecordingLogger } from '../../loader/src/logger.js';
import {
  readHeadCommit,
  requireSeedBundleForFirstStart,
  seedRepositoryIfMissing,
  type RepositoryDeps,
} from '../../loader/src/repo.js';
import {
  createLoaderWorld,
  scriptRepository,
  type LoaderWorld,
} from '../helpers/loader-doubles.js';

registerLoaderLifecycle();

/**
 * What git printed in the walk, verbatim: its own message first, its advice
 * after it. The loader's log line carried the advice and nothing else.
 */
const DUBIOUS_OWNERSHIP = [
  "fatal: detected dubious ownership in repository at '/var/lib/lifemodel/repo'",
  'To add an exception for this directory, call:',
  '',
  '\tgit config --global --add safe.directory /var/lib/lifemodel/repo',
  '',
].join('\n');

/** The one option the loader makes git trust the instance's repository with. */
function safety(world: LoaderWorld): string {
  return `-c safe.directory=${world.config.repoDir}`;
}

function repositoryDeps(world: LoaderWorld): RepositoryDeps {

  return {
    fs: world.fs,
    runner: world.runner,
    logger: createRecordingLogger([]),
    config: world.config,
    builtCommit: () => Promise.resolve(null),
    recordBuiltCommit: () => Promise.resolve(),
  };
}

describe('git and the instance repository', () => {
  it('is not asked for a commit while the volume holds no repository', async () => {
    const world = createLoaderWorld();
    const deps = repositoryDeps(world);

    expect(await readHeadCommit(deps)).toBeNull();
    expect(world.runner.lines()).toEqual([]);
  });

  it('reads the commit with the repository named as safe, and that path only', async () => {
    const world = createLoaderWorld();
    scriptRepository(world);
    mkdirSync(join(world.config.repoDir, '.git'), { recursive: true });
    const deps = repositoryDeps(world);

    expect(await readHeadCommit(deps)).toBe('c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ff');
    expect(world.runner.rawLines()).toEqual([`git ${safety(world)} rev-parse HEAD`]);
    // Never `*`: nothing else on the volume becomes trusted by accident.
    for (const line of world.runner.rawLines()) {
      expect(line).not.toContain('safe.directory=*');
    }
  });

  it('seeds with the repository named as safe on every call it makes', async () => {
    const world = createLoaderWorld();
    scriptRepository(world);
    const deps = repositoryDeps(world);

    expect(await seedRepositoryIfMissing(deps)).toBe(true);

    expect(world.runner.rawLines()).toEqual([
      `git ${safety(world)} clone ${world.config.seedBundle} ${world.config.repoDir}`,
      `git ${safety(world)} remote`,
      `git ${safety(world)} remote rename origin upstream`,
      `git ${safety(world)} remote set-url upstream ${world.config.upstreamUrl}`,
    ]);
    for (const line of world.runner.rawLines()) {
      // Every git call, not just the first: the flag is part of how the loader
      // calls git on this repository.
      expect(line.startsWith(`git ${safety(world)} `)).toBe(true);
    }
  });

  it('makes every git call of a first start safe, through the loader itself', async () => {
    const world = createLoaderWorld();
    scriptRepository(world);

    const app = createLoaderApp({
      config: world.config,
      fs: world.fs,
      runner: world.runner,
      launcher: world.launcher,
      logger: createRecordingLogger([]),
      clock: world.clock,
      exit: () => undefined,
    });
    ownLoaderApp(world, app);

    await app.bootstrap.ensureReady('setup');

    const gitCalls = world.runner.rawLines().filter((line) => line.startsWith('git '));
    expect(gitCalls.length).toBeGreaterThan(0);
    for (const line of gitCalls) {
      expect(line.startsWith(`git ${safety(world)} `)).toBe(true);
    }
  });

  it("reports git's own message, not the advice under it", async () => {
    const world = createLoaderWorld();
    scriptRepository(world);
    mkdirSync(join(world.config.repoDir, '.git'), { recursive: true });
    world.runner.on('git rev-parse HEAD', () => ({
      code: 128,
      stdout: '',
      stderr: DUBIOUS_OWNERSHIP,
    }));
    const deps = repositoryDeps(world);

    const failure = await readHeadCommit(deps).catch((error: unknown) => error);
    const message = failure instanceof Error ? failure.message : String(failure);

    expect(message).toContain('has no readable commit');
    expect(message).toContain(
      "fatal: detected dubious ownership in repository at '/var/lib/lifemodel/repo'"
    );
    // The hint is a suggestion, not the reason.
    expect(message).not.toContain('git config --global --add');
  });

  it('says the same when it is the clone that fails', async () => {
    const world = createLoaderWorld();
    world.runner.on('git clone', () => ({ code: 128, stdout: '', stderr: DUBIOUS_OWNERSHIP }));
    const deps = repositoryDeps(world);

    const failure = await seedRepositoryIfMissing(deps).catch((error: unknown) => error);
    const message = failure instanceof Error ? failure.message : String(failure);

    expect(message).toContain('git clone of the seed bundle failed');
    expect(message).toContain('fatal: detected dubious ownership in repository at');
    expect(message).not.toContain('git config --global --add');
  });
});

describe('the code the image carries', () => {
  it('is asked for only while the volume holds no repository', async () => {
    const world = createLoaderWorld();
    const missing = { ...world.config, seedBundle: join(world.root, 'not-there.bundle') };


    await expect(
      requireSeedBundleForFirstStart({ fs: world.fs, config: missing })
    ).rejects.toThrow(/seed bundle is missing/);

    // The volume has an instance already: the bundle is never used again, so a
    // start is not refused for its absence.
    mkdirSync(join(world.config.repoDir, '.git'), { recursive: true });
    await expect(
      requireSeedBundleForFirstStart({ fs: world.fs, config: missing })
    ).resolves.toBeUndefined();
  });
});
