/**
 * Seeding from the code the image carries (lifemodel-q4x.2.1, decisions on the
 * seed bundle and story S7).
 *
 * The image carries a `git bundle` WITH HISTORY, and what the loader does with
 * it is real git work: clone, rename the bundle remote to the instance's
 * upstream, point it at the real upstream. A later merge from upstream needs a
 * common ancestor, so the shared history is what this checks - with the real
 * git, on a real bundle.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../loader/src/config.js';
import { createNodeRunner } from '../../loader/src/exec.js';
import { createNodeFileSystem } from '../../loader/src/fs.js';
import { createRecordingLogger } from '../../loader/src/logger.js';
import { readHeadCommit, seedRepositoryIfMissing } from '../../loader/src/repo.js';

const roots: string[] = [];

afterEach(() => {
  roots.splice(0);
});

function git(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=test', ...args],
    { cwd, encoding: 'utf8' }
  ).trim();
}

describe('the seed bundle', () => {
  it('clones the instance with its history, gives it the upstream and never seeds twice', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loader-seed-'));
    roots.push(root);
    // The code the image carries: two commits, bundled with their history.
    const source = join(root, 'source');
    mkdirSync(source, { recursive: true });
    git(source, ['init', '-q', '-b', 'main']);
    writeFileSync(join(source, 'README.md'), 'the first commit\n');
    git(source, ['add', '-A']);
    git(source, ['commit', '-q', '-m', 'the first commit']);
    const firstCommit = git(source, ['rev-parse', 'HEAD']);
    writeFileSync(join(source, 'src.ts'), 'export const second = true;\n');
    git(source, ['add', '-A']);
    git(source, ['commit', '-q', '-m', 'the second commit']);
    const head = git(source, ['rev-parse', 'HEAD']);
    const bundle = join(root, 'seed.bundle');
    git(source, ['bundle', 'create', bundle, '--all']);

    const config = loadConfig({
      LIFEMODEL_VOLUME_ROOT: root,
      LIFEMODEL_SEED_BUNDLE: bundle,
      LIFEMODEL_UPSTREAM: 'https://github.com/shady2k/lifemodel.git',
    });
    const deps = {
      fs: createNodeFileSystem(),
      runner: createNodeRunner(),
      logger: createRecordingLogger([]),
      config,
      builtCommit: () => Promise.resolve(null),
      recordBuiltCommit: () => Promise.resolve(),
    };

    expect(await seedRepositoryIfMissing(deps)).toBe(true);

    // The instance is on the same commit, with the same history behind it.
    expect(git(config.repoDir, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(config.repoDir, ['merge-base', 'HEAD', firstCommit])).toBe(firstCommit);
    expect(git(config.repoDir, ['log', '--format=%s'])).toBe('the second commit\nthe first commit');

    // One remote, the upstream: the bundle the image carried is not one.
    expect(git(config.repoDir, ['remote'])).toBe('upstream');
    expect(git(config.repoDir, ['remote', 'get-url', 'upstream'])).toBe(config.upstreamUrl);
    // The branch still tracks the remote it came from, now under its new name.
    expect(git(config.repoDir, ['config', 'branch.main.remote'])).toBe('upstream');
    expect(await readHeadCommit(deps)).toBe(head);

    // A second start of the same volume: the instance's own repository, untouched.
    expect(await seedRepositoryIfMissing(deps)).toBe(false);
    expect(git(config.repoDir, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(config.repoDir, ['status', '--porcelain'])).toBe('');
  }, 20_000);

  it('says what is missing when the image carries no bundle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loader-seed-'));
    roots.push(root);
    const config = loadConfig({
      LIFEMODEL_VOLUME_ROOT: root,
      LIFEMODEL_SEED_BUNDLE: join(root, 'not-there.bundle'),
    });
    const deps = {
      fs: createNodeFileSystem(),
      runner: createNodeRunner(),
      logger: createRecordingLogger([]),
      config,
      builtCommit: () => Promise.resolve(null),
      recordBuiltCommit: () => Promise.resolve(),
    };

    await expect(seedRepositoryIfMissing(deps)).rejects.toThrow(/seed bundle is missing/);
  });
});
