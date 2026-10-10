import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createNodeFileSystem,
  type FileSystem,
} from '../../loader/src/fs.js';
import { FixtureLifetime } from '../helpers/loader-fixture-lifetime.js';

const BOUND_MS = 2_000;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(
            'Native operation did not settle; retain fixture ownership and root.',
          )),
          BOUND_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface OwnedRoot {
  root: string;
  lifetime?: FixtureLifetime;
  operations: Set<Promise<void>>;
  releases: Set<() => void>;
}

type ConstructedRoot = OwnedRoot & {
  lifetime: FixtureLifetime;
};

const roots = new Set<OwnedRoot>();

async function ownRoot(): Promise<ConstructedRoot> {
  const root = await mkdtemp(join(tmpdir(), 'loader-lifetime-'));
  const entry: OwnedRoot = {
    root,
    operations: new Set(),
    releases: new Set(),
  };
  roots.add(entry);

  const lifetime = new FixtureLifetime();
  return Object.assign(entry, { lifetime });
}

/** Observe rejection immediately without replacing the original promise. */
function track<T>(entry: OwnedRoot, original: Promise<T>): Promise<T> {
  const settlement = original.then(
    () => undefined,
    () => undefined,
  );
  entry.operations.add(settlement);
  void settlement.then(() => {
    entry.operations.delete(settlement);
  });
  return original;
}

/**
 * Start the real atomic write before waiting on the owned gate.
 * Promise.all observes native rejection immediately.
 */
function heldWrite(entry: OwnedRoot, base: FileSystem) {
  const gate = deferred();
  entry.releases.add(gate.resolve);
  let calls = 0;
  let operation: Promise<void> | undefined;

  const fs: FileSystem = {
    ...base,
    writeFileAtomic: (path, contents, mode) => {
      calls += 1;
      const native = track(
        entry,
        base.writeFileAtomic(path, contents, mode),
      );
      operation = track(
        entry,
        Promise.all([native, gate.promise]).then(() => undefined),
      );
      return operation;
    },
  };

  return {
    fs,
    release: gate.resolve,
    calls: () => calls,
    operation: () => operation,
  };
}

/** No await may prevent an owned gate from being released. */
function releaseAndFence(entry: OwnedRoot): void {
  const failures: unknown[] = [];
  for (const release of entry.releases) {
    try {
      release();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    entry.lifetime?.closeAdmission();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length !== 0) {
    throw new AggregateError(failures, 'Fixture release or fence failed');
  }
}

async function settleOwned(entry: OwnedRoot): Promise<void> {
  await bounded(Promise.all([...entry.operations]));
  if (entry.lifetime !== undefined) {
    await bounded(entry.lifetime.drainNativeIo(BOUND_MS));
  }
  if (
    entry.operations.size !== 0 ||
    (entry.lifetime?.admittedCount() ?? 0) !== 0
  ) {
    throw new Error('Retain fixture ownership and root: I/O remains tracked.');
  }
}

afterEach(async () => {
  const failures: unknown[] = [];
  const fenceFailed = new Set<OwnedRoot>();

  // Release every fixture before starting any asynchronous cleanup.
  for (const entry of roots) {
    try {
      releaseAndFence(entry);
    } catch (error) {
      fenceFailed.add(entry);
      failures.push(new Error(
        `Cleanup failed; retained fixture ${entry.root}`,
        { cause: error },
      ));
    }
  }

  for (const entry of roots) {
    try {
      await settleOwned(entry);
      if (fenceFailed.has(entry)) continue;
      await rm(entry.root, { recursive: true, force: true });
      roots.delete(entry);
    } catch (error) {
      // Timeout is not settlement. Keep this entry and its root owned.
      failures.push(new Error(
        `Cleanup failed; retained fixture ${entry.root}`,
        { cause: error },
      ));
    }
  }
  if (failures.length !== 0) {
    throw new AggregateError(failures, 'Fixture cleanup failed');
  }
});

// Local admission and native settlement only; no consumer wiring.
describe('FixtureLifetime standalone proof', () => {
  it('keeps an admitted atomic write tracked until its full promise settles', async () => {
    const entry = await ownRoot();
    const { root, lifetime } = entry;
    const path = join(root, 'nested', 'value');
    const held = heldWrite(entry, createNodeFileSystem());
    const guarded = lifetime.wrapFs(held.fs);

    try {
      const write = track(
        entry,
        guarded.writeFileAtomic(path, 'complete', 0o600),
      );
      expect(held.calls()).toBe(1);
      expect(write).toBe(held.operation());
      expect(lifetime.admittedCount()).toBe(1);

      lifetime.closeAdmission();
      expect(lifetime.isClosed()).toBe(true);

      let drainSettled = false;
      const drain = lifetime.drainNativeIo(BOUND_MS);
      void drain.then(
        () => { drainSettled = true; },
        () => { drainSettled = true; },
      );

      await Promise.resolve();
      expect(drainSettled).toBe(false);
      expect(lifetime.admittedCount()).toBe(1);

      held.release();
      await bounded(write);
      await bounded(drain);
      await settleOwned(entry);

      expect(lifetime.admittedCount()).toBe(0);
      expect(await track(entry, readFile(path, 'utf8'))).toBe('complete');

      // Removal is permitted only after native settlement is established.
      await rm(root, { recursive: true, force: true });

      let lateSettled = false;
      const late = guarded.writeFileAtomic(path, 'late', 0o600);
      void late.then(
        () => { lateSettled = true; },
        () => { lateSettled = true; },
      );

      await Promise.resolve();
      expect(lateSettled).toBe(false);
      expect(held.calls()).toBe(1);
      expect(lifetime.admittedCount()).toBe(0);

      // The late pending promise allocates no native resource.
      await expect(track(entry, stat(root))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      releaseAndFence(entry);
    }
  }, 10_000);

  it('preserves an original rejection and clears its tracking token', async () => {
    const entry = await ownRoot();
    const { root, lifetime } = entry;
    const base = createNodeFileSystem();
    let original: Promise<string> | undefined;

    const guarded = lifetime.wrapFs({
      ...base,
      readFile: (path) => {
        original = track(entry, base.readFile(path));
        return original;
      },
    });

    try {
      const result = track(entry, guarded.readFile(join(root, 'missing')));
      const settlement = Promise.allSettled([result]);

      expect(result).toBe(original);
      expect(lifetime.admittedCount()).toBe(1);
      lifetime.closeAdmission();

      const outcomes = await bounded(settlement);
      expect(outcomes[0]?.status).toBe('rejected');
      const outcome = outcomes[0];
      if (outcome?.status === 'rejected') {
        expect(outcome.reason).toMatchObject({ code: 'ENOENT' });
      }

      await settleOwned(entry);
      expect(lifetime.admittedCount()).toBe(0);
    } finally {
      releaseAndFence(entry);
    }
  }, 10_000);

  it('retains the root and in-flight tracking after a drain timeout', async () => {
    const entry = await ownRoot();
    const { root, lifetime } = entry;
    const held = heldWrite(entry, createNodeFileSystem());
    const guarded = lifetime.wrapFs(held.fs);

    try {
      const write = track(
        entry,
        guarded.writeFileAtomic(join(root, 'value'), 'kept', 0o600),
      );
      lifetime.closeAdmission();

      await expect(lifetime.drainNativeIo(0)).rejects.toThrow(
        'Retain fixture ownership and root.',
      );
      expect(roots.has(entry)).toBe(true);
      expect(entry.operations.size).toBeGreaterThan(0);
      expect(lifetime.admittedCount()).toBe(1);
      expect((await track(entry, stat(root))).isDirectory()).toBe(true);

      held.release();
      await bounded(write);
      await settleOwned(entry);
      expect(lifetime.admittedCount()).toBe(0);
    } finally {
      releaseAndFence(entry);
    }
  }, 10_000);
});
