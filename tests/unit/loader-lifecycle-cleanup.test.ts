// tests/unit/loader-lifecycle-cleanup.test.ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { createNodeFileSystem, type FileSystem } from '../../loader/src/fs.js';
import {
  cleanupWorld,
  createLoaderWorld,
  loaderFileSystem,
  loaderRealBound,
  ownedLoaderRoots,
  registerLoaderBeginStop,
  registerLoaderRelease,
  testLoaderApp,
  type LoaderWorld,
} from '../helpers/loader-doubles.js';
import {
  ownLoaderApp,
  registerLoaderLifecycle,
} from '../helpers/loader-lifecycle.js';

const BOUND = 5_000;

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  let released = false;
  return {
    promise,
    release(): void {
      if (released) return;
      released = true;
      resolve();
    },
  };
}

async function microtasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function bounded<T>(promise: Promise<T>): Promise<T> {
  return loaderRealBound(promise, BOUND);
}

describe('independent loader lifecycle cleanup', () => {
  const worlds: LoaderWorld[] = [];
  const savedRoots: string[] = [];
  let bodyFailureReady = false;
  let bodyFailureStopped = false;

  function world(): LoaderWorld {
    const created = createLoaderWorld();
    worlds.push(created);
    savedRoots.push(created.root);
    return created;
  }

  function assertClosed(created: LoaderWorld): void {
    expect(created.fixtureLifetime.isClosed()).toBe(true);
    expect(created.fixtureLifetime.admittedCount()).toBe(0);
    expect(created.runner.admittedCount()).toBe(0);

    const spawns = created.launcher.spawns.length;
    expect(() => created.launcher.spawn(
      created.config.caddy.binary,
      [],
      { cwd: created.root, env: {} }
    )).toThrow();
    expect(created.launcher.spawns).toHaveLength(spawns);

    let handled = false;
    created.runner.on('late-lifecycle-command', () => {
      handled = true;
      return { code: 0, stdout: '', stderr: '' };
    });
    const calls = created.runner.calls.length;
    void created.runner.run('late-lifecycle-command', []).catch(() => {});
    expect(handled).toBe(false);
    expect(created.runner.calls).toHaveLength(calls);
  }

  function assertGone(created: LoaderWorld): void {
    expect(ownedLoaderRoots()).not.toContain(created.root);
    expect(existsSync(created.root)).toBe(false);
    assertClosed(created);
  }

  // Registered FIRST: LIFO runs the actual lifecycle cleanup before this.
  // These assertions are outside it.fails and cannot become expected failures.
  afterAll(async () => {
    await microtasks();
    expect(bodyFailureReady).toBe(true);
    expect(bodyFailureStopped).toBe(true);
    expect(ownedLoaderRoots()).toEqual([]);
    for (const root of savedRoots) expect(existsSync(root)).toBe(false);
    for (const created of worlds) assertClosed(created);
  }, 15_000);

  // Explicit real installer: disabling this call must make afterAll fail.
  registerLoaderLifecycle(
    (cleanup): void => { afterAll(cleanup, 15_000); },
    BOUND
  );

  it('leaves an owned root with a real filesystem-port write for the hook', async () => {
    const created = world();
    const path = join(created.root, 'hook-owned.txt');
    await bounded(created.fs.writeFileAtomic(path, 'owned by lifecycle\n', 0o600));
    expect(existsSync(path)).toBe(true);
    expect(ownedLoaderRoots()).toContain(created.root);
  });

  it.fails('has an expected body failure during factory-held startup', async () => {
    // Setup errors must not masquerade as the deliberate expected failure.
    // Returning here makes it.fails fail because its body unexpectedly passed.
    try {
      const created = world();
      const entered = gate();
      const hold = gate();

      registerLoaderBeginStop(created, (): void => {
        bodyFailureStopped = true;
      });
      registerLoaderRelease(created, hold.release);

      const app = testLoaderApp(created, {
        lines: [],
        fs: (guardedBase) => ({
          ...guardedBase,
          writeFileAtomic: async (...args) => {
            entered.release();
            await hold.promise;
            return guardedBase.writeFileAtomic(...args);
          },
        }),
      });
      ownLoaderApp(created, app, BOUND);
      const startup = app.start();
      void startup.catch(() => {});
      registerLoaderRelease(created, (): void => {}, startup);

      await bounded(entered.promise);
      expect(created.fixtureLifetime.admittedCount()).toBe(0);
      bodyFailureReady = true;
    } catch {
      return;
    }

    // Only this assertion is the expected body failure.
    expect('deliberate body failure').toBe('successful body');
  }, 15_000);

  it('blocks a held factory continuation released after root deletion', async () => {
    const created = world();
    const entered = gate();
    const hold = gate();
    const attempted = gate();
    let nativeWrites = 0;

    const nativeBase = createNodeFileSystem();
    const recordingBase: FileSystem = {
      ...nativeBase,
      writeFileAtomic: (...args) => {
        nativeWrites += 1;
        return nativeBase.writeFileAtomic(...args);
      },
    };
    created.fs = created.fixtureLifetime.wrapFs(recordingBase);

    const port = loaderFileSystem(created, (guardedBase) => ({
      ...guardedBase,
      writeFileAtomic: async (...args) => {
        entered.release();
        await hold.promise;
        attempted.release();
        return guardedBase.writeFileAtomic(...args);
      },
    }));

    // Intentionally no registered release: deletion precedes this release.
    const startupPromise = port.writeFileAtomic(
      join(created.root, 'late.txt'), 'must never reach native I/O\n', 0o600
    );
    void startupPromise.catch(() => {});

    try {
      await bounded(entered.promise);
      expect(nativeWrites).toBe(0);
      expect(created.fixtureLifetime.admittedCount()).toBe(0);

      await bounded(cleanupWorld(created, BOUND));
      assertGone(created);
      const before = nativeWrites;

      hold.release();
      await bounded(attempted.promise);
      await microtasks();

      expect(nativeWrites).toBe(before);
      assertGone(created);
      // startupPromise is now parked at the closed guarded port.
    } finally {
      hold.release();
      await bounded(cleanupWorld(created, BOUND));
    }
  }, 15_000);

  it('waits for the complete admitted native atomic operation before deletion', async () => {
    const created = world();
    const nativeEntered = gate();
    const nativeHold = gate();
    const closureEntered = gate();
    let nativeWrites = 0;
    let nativeFinished = false;
    let cleanupFinished = false;

    const nativeBase = createNodeFileSystem();
    // This facade instruments admission inside wrapFs, not a factory side channel.
    const mockFileSystem: FileSystem = {
      ...nativeBase,
      writeFileAtomic: async (...args) => {
        nativeWrites += 1;
        nativeEntered.release();
        await nativeHold.promise;
        await nativeBase.writeFileAtomic(...args);
        nativeFinished = true;
      },
    };
    created.fs = created.fixtureLifetime.wrapFs(mockFileSystem);
    registerLoaderBeginStop(created, (): void => {
      closureEntered.release();
    });

    const path = join(created.root, 'admitted.txt');
    const write = created.fs.writeFileAtomic(path, 'genuine atomic finish\n', 0o600);
    void write.catch(() => {});
    let cleanup: Promise<void> | undefined;

    try {
      await bounded(nativeEntered.promise);
      expect(nativeWrites).toBe(1);
      expect(created.fixtureLifetime.admittedCount()).toBe(1);

      cleanup = cleanupWorld(created, BOUND);
      void cleanup.then(
        () => { cleanupFinished = true; },
        () => {}
      );
      await bounded(closureEntered.promise);
      await microtasks();

      expect(created.fixtureLifetime.isClosed()).toBe(true);
      expect(cleanupFinished).toBe(false);
      expect(nativeFinished).toBe(false);
      expect(created.fixtureLifetime.admittedCount()).toBe(1);
      expect(ownedLoaderRoots()).toContain(created.root);
      expect(existsSync(created.root)).toBe(true);

      nativeHold.release();
      await bounded(write);
      expect(nativeFinished).toBe(true);
      await bounded(cleanup);
      assertGone(created);
    } finally {
      nativeHold.release();
      // A failed real bound propagates; it never authorizes manual root removal.
      await bounded(cleanup ?? cleanupWorld(created, BOUND));
    }
  }, 15_000);
});
