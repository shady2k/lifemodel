import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeFileSystem } from '../../loader/src/fs.js';
import { createWorkbenchImportTask } from '../../loader/src/workbench-task.js';
import { createRecordingLogger } from '../../loader/src/logger.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const pinnedDigest = `sha256:${'a'.repeat(64)}`;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'workbench-task-'));
  roots.push(root);
  const sleepers: Array<() => void> = [];
  let now = 1000;
  const clock = {
    now: () => now,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        sleepers.push(() => {
          now += ms;
          resolve();
        });
      }),
  };
  const fs = createNodeFileSystem();
  return { root, fs, clock, sleepers, config: { loaderDir: root } };
}

describe('durable independent workbench import task', () => {
  it('does not trust exception messages, custom names or arbitrary code strings', async () => {
    const f = await fixture();
    const entries: Parameters<typeof createRecordingLogger>[0] = [];
    const task = createWorkbenchImportTask({
      ...f,
      pinnedDigest,
      logger: createRecordingLogger(entries),
      run: async () => {
        throw Object.assign(new Error('https://user-canary:password-canary@registry.example'), {
          name: 'user-canary',
          code: 'password-canary',
        });
      },
    });
    try {
      await task.start();
      await vi.waitFor(() => expect(task.status().state).toBe('failed'));
      const saved = await f.fs.readFile(join(f.root, 'workbench-import.json'));
      expect(task.status()).toMatchObject({
        reason: 'unavailable',
        detail: { errorName: 'Error' },
      });
      expect(saved + JSON.stringify(entries) + JSON.stringify(task.status())).not.toMatch(
        /user-canary|password-canary/
      );
    } finally {
      await task.stop();
    }
  });
  it('admits only one owner when start is called concurrently', async () => {
    const f = await fixture();
    const run = vi.fn(async () => {});
    const task = createWorkbenchImportTask({
      ...f,
      pinnedDigest,
      logger: createRecordingLogger([]),
      run,
    });
    await Promise.all([task.start(), task.start(), task.start()]);
    await vi.waitFor(() => expect(task.status().state).toBe('ready'));
    expect(run).toHaveBeenCalledTimes(1);
    await task.stop();
  });

  it('records failure safely, retries with backoff and succeeds without a restart', async () => {
    const f = await fixture();
    let reachable = false;
    const run = vi.fn(async () => {
      if (!reachable) throw new Error('workbench-import:unavailable secret-canary');
    });
    const task = createWorkbenchImportTask({
      ...f,
      pinnedDigest,
      logger: createRecordingLogger([]),
      run,
    });
    await task.start();
    await vi.waitFor(() => expect(task.status().state).toBe('failed'));
    expect(task.status()).toMatchObject({ reason: 'unavailable', lastAttemptAt: 1000 });
    expect(await f.fs.readFile(join(f.root, 'workbench-import.json'))).not.toContain(
      'secret-canary'
    );
    reachable = true;
    f.sleepers.shift()?.();
    await vi.waitFor(() => expect(task.status().state).toBe('ready'));
    expect(run).toHaveBeenCalledTimes(2);
    await task.stop();
  });

  it('a settings save cancels the old attempt and immediately retries the new source', async () => {
    const f = await fixture();
    let first = true;
    const run = vi.fn(async (signal: AbortSignal) => {
      if (!first) return;
      first = false;
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      );
    });
    const task = createWorkbenchImportTask({
      ...f,
      pinnedDigest,
      logger: createRecordingLogger([]),
      run,
    });
    await task.start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await task.trigger();
    await vi.waitFor(() => expect(task.status().state).toBe('ready'));
    expect(run).toHaveBeenCalledTimes(2);
    await task.stop();
  });

  it('a fresh process resumes a durable importing record after a kill', async () => {
    const f = await fixture();
    await f.fs.writeFileAtomic(
      join(f.root, 'workbench-import.json'),
      JSON.stringify({ state: 'importing', lastAttemptAt: 500, pinnedDigest }),
      0o600
    );
    let during: string | undefined;
    const task = createWorkbenchImportTask({
      ...f,
      pinnedDigest,
      logger: createRecordingLogger([]),
      run: async () => {
        during = JSON.parse(await f.fs.readFile(join(f.root, 'workbench-import.json'))).state;
      },
    });
    await task.start();
    await vi.waitFor(() => expect(task.status().state).toBe('ready'));
    expect(during).toBe('importing');
    await task.stop();
    const secondRun = vi.fn(async () => {});
    const restarted = createWorkbenchImportTask({
      ...f,
      pinnedDigest,
      logger: createRecordingLogger([]),
      run: secondRun,
    });
    await restarted.start();
    await vi.waitFor(() => expect(restarted.status().state).toBe('ready'));
    expect(secondRun).toHaveBeenCalledTimes(1);
    await restarted.stop();
  });
});
