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
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  clearTimeout as clearRealNodeTimeout,
  setTimeout as setRealNodeTimeout,
} from 'node:timers';
import { afterAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../loader/src/config.js';
import { createNodeRunner } from '../../loader/src/exec.js';
import { createNodeFileSystem } from '../../loader/src/fs.js';
import { createRecordingLogger } from '../../loader/src/logger.js';
import {
  readHeadCommit,
  seedRepositoryIfMissing,
  type RepositoryDeps,
} from '../../loader/src/repo.js';
import { registerLoaderLifecycle } from '../helpers/loader-lifecycle.js';

registerLoaderLifecycle();

interface SeedRoot {
  root: string;
  closing: boolean;
  failed: boolean;
  admitted: Set<Promise<unknown>>;
}

const seedRoots = new Map<string, SeedRoot>();

function ownSeedRoot(root: string): SeedRoot {
  const entry: SeedRoot = {
    root,
    closing: false,
    failed: false,
    admitted: new Set(),
  };
  seedRoots.set(root, entry);
  return entry;
}

/** Track the complete real repository operation, not only its git call. */
function admitSeedOperation<T>(
  entry: SeedRoot,
  operation: () => Promise<T>
): Promise<T> {
  if (entry.closing) {
    return Promise.reject(new Error('Seed fixture admission is closed'));
  }
  let resolveOperation!: (value: T | PromiseLike<T>) => void;
  let rejectOperation!: (error: unknown) => void;
  const pending = new Promise<T>((resolve, reject) => {
    resolveOperation = resolve;
    rejectOperation = reject;
  });
  entry.admitted.add(pending);
  void pending.then(
    () => { entry.admitted.delete(pending); },
    () => { entry.admitted.delete(pending); }
  );
  try {
    resolveOperation(operation());
  } catch (error) {
    rejectOperation(error);
  }
  return pending;
}

function seed(entry: SeedRoot, deps: RepositoryDeps): Promise<boolean> {
  return admitSeedOperation(entry, () => seedRepositoryIfMissing(deps));
}

function headCommit(
  entry: SeedRoot,
  deps: RepositoryDeps
): Promise<string | null> {
  return admitSeedOperation(entry, () => readHeadCommit(deps));
}

afterAll(async () => {
  // One real, monotonic budget shared by every root.
  const deadline = performance.now() + 10_000;

  // Seal every root and snapshot every complete repository operation
  // before starting any cleanup.
  const entries = [...seedRoots.values()];
  for (const entry of entries) entry.closing = true;
  const claims = entries.map((entry) => ({
    entry,
    operations: [...entry.admitted],
  }));
  const context = claims
    .map(({ entry, operations }) =>
      `${entry.root} (${operations.length} admitted operations)`
    )
    .join('; ');

  const results = await Promise.allSettled(
    claims.map(({ entry, operations }) => new Promise<void>((resolve, reject) => {
      let finished = false;
      let timer: ReturnType<typeof setRealNodeTimeout> | undefined;

      const finish = (result: { ok: true } | { ok: false; error: unknown }) => {
        if (finished) return;
        finished = true;
        if (timer !== undefined) {
          clearRealNodeTimeout(timer);
          timer = undefined;
        }
        if (result.ok) {
          resolve();
        } else {
          entry.failed = true;
          reject(new AggregateError(
            [result.error],
            `Retained seed root: ${entry.root}; tracked claims: ${context}`
          ));
        }
      };

      timer = setRealNodeTimeout(() => {
        finish({
          ok: false,
          error: new Error('Real seed cleanup deadline exceeded'),
        });
      }, Math.max(0, deadline - performance.now()));

      const cleanup = async (): Promise<void> => {
        // Expected repository rejections are not cleanup failures.
        // Both fulfilled and rejected operations must genuinely settle,
        // including their native git and filesystem work.
        await Promise.allSettled(operations);

        // A timeout permanently forbids this continuation from deleting.
        if (entry.failed) {
          throw new Error('Seed root was permanently retained');
        }
        if (performance.now() >= deadline) {
          entry.failed = true;
          throw new Error('Real seed cleanup deadline exceeded');
        }
        if (entry.admitted.size !== 0) {
          throw new Error('Seed root still has admitted operations');
        }

        await rm(entry.root, { recursive: true, force: true });

        // Keep failed ownership even if native removal finishes late.
        if (entry.failed) {
          throw new Error('Seed root was permanently retained');
        }
        if (performance.now() >= deadline) {
          entry.failed = true;
          throw new Error('Real seed cleanup deadline exceeded');
        }
        seedRoots.delete(entry.root);
      };

      // Observe both verdicts even after the bounded result has timed out.
      void cleanup().then(
        () => finish({ ok: true }),
        (error: unknown) => finish({ ok: false, error })
      );
    }))
  );
  const errors = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `Seed fixture cleanup failed; tracked claims: ${context}`
    );
  }
}, 15_000);

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
    const owned = ownSeedRoot(root);
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

    expect(await seed(owned, deps)).toBe(true);

    // The instance is on the same commit, with the same history behind it.
    expect(git(config.repoDir, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(config.repoDir, ['merge-base', 'HEAD', firstCommit])).toBe(firstCommit);
    expect(git(config.repoDir, ['log', '--format=%s'])).toBe('the second commit\nthe first commit');

    // One remote, the upstream: the bundle the image carried is not one.
    expect(git(config.repoDir, ['remote'])).toBe('upstream');
    expect(git(config.repoDir, ['remote', 'get-url', 'upstream'])).toBe(config.upstreamUrl);
    // The branch still tracks the remote it came from, now under its new name.
    expect(git(config.repoDir, ['config', 'branch.main.remote'])).toBe('upstream');
    expect(await headCommit(owned, deps)).toBe(head);

    // A second start of the same volume: the instance's own repository, untouched.
    expect(await seed(owned, deps)).toBe(false);
    expect(git(config.repoDir, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(config.repoDir, ['status', '--porcelain'])).toBe('');
  }, 20_000);

  it('says what is missing when the image carries no bundle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loader-seed-'));
    const owned = ownSeedRoot(root);
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

    await expect(seed(owned, deps)).rejects.toThrow(/seed bundle is missing/);
  });
});
