import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { TaskRecord, TaskRegistry } from '../../src/ports/tasks.js';
import { createTaskLaunchReconciler } from '../../src/core/task-launch.js';
import { createFakeTaskExecutor } from '../../src/core/fake-task-executor.js';
import { TaskExecutorError, type TaskJobObservation } from '../../src/core/task-executor.js';
import { createTestLogger } from '../helpers/test-logger.js';

const launchId = `launch_${'a'.repeat(64)}`;
const task = {
  id: 'task-scan-cleanup',
  traceId: 'trace-scan-cleanup',
  launchId,
  jobName: `task-${launchId.slice(7, 65)}`,
  jobUid: 'job-bound',
  imageRevision: `sha256:${'b'.repeat(64)}`,
  allocationReceipt: { space: 'space-cleanup' },
  state: 'running',
  tombstonedAt: new Date(),
  terminalCandidate: null,
} as TaskRecord;

function fixture(fresh: TaskRecord | null, jobUid = 'job-bound', templateHash?: string) {
  const remove = vi.fn(async () => undefined);
  const tombstoneLaunch = vi.fn(async () => fresh!);
  const bindCleanupJob = vi.fn(async (
    _taskId: string,
    _launchId: string,
    boundUid: string,
    boundHash: string
  ) => ({
    ...fresh!,
    jobUid: boundUid,
    templateHash: boundHash,
  }));
  const registry = {
    listLaunchWork: async () => [],
    readByJobName: async () => fresh,
    tombstoneLaunch,
    bindCleanupJob,
    admitNext: async () => null,
  } as unknown as TaskRegistry;
  const executor = createFakeTaskExecutor();
  const observation: TaskJobObservation = {
    taskId: task.id,
    launchId,
    jobName: task.jobName,
    jobUid,
    resourceVersion: '1',
    templateHash: templateHash ?? '',
    startedAt: null,
    phase: 'failed',
  };
  const observe = vi.spyOn(executor, 'observe').mockResolvedValue(observation);
  const deleteNow = vi.spyOn(executor, 'deleteNow').mockResolvedValue(undefined);
  const runtime = createTaskLaunchReconciler({
    registry,
    executor,
    storage: { allocate: vi.fn(), close: vi.fn() },
    logger: createTestLogger(),
    scanJobs: async () => [
      {
        name: task.jobName,
        uid: jobUid,
        launchLabel: launchId.slice(7, 65),
        ...(templateHash ? { templateHash } : {}),
        remove,
      },
    ],
  });
  return { runtime, remove, tombstoneLaunch, bindCleanupJob, observe, observation, deleteNow };
}

describe('task cleanup trace routing', () => {
  it('uses the diagnostic deletion boundary for exact bound Jobs outside the current work page', async () => {
    const f = fixture(task);
    try {
      expect(await f.runtime.runOnce()).toBe(true);
      expect(f.tombstoneLaunch).toHaveBeenCalledWith(task.id, launchId);
      expect(f.deleteNow).toHaveBeenCalledWith(
        expect.objectContaining({ task, spaceId: 'space-cleanup' }),
        expect.any(AbortSignal)
      );
      expect(f.tombstoneLaunch.mock.invocationCallOrder[0]).toBeLessThan(
        f.deleteNow.mock.invocationCallOrder[0]!
      );
      expect(f.remove).not.toHaveBeenCalled();
    } finally {
      await f.runtime.stop();
    }
  });

  it('binds an unbound late CREATE with its observed hash before diagnostic cleanup', async () => {
    const unbound = {
      ...task,
      jobUid: null,
      terminalCandidate: 'failed',
    } as TaskRecord;
    const hash = 'c'.repeat(64);
    const f = fixture(unbound, 'job-late', 'd'.repeat(64));
    f.observe.mockResolvedValueOnce({ ...f.observation, templateHash: hash });
    // A tombstone re-read returns the newly bound durable row during cleanup.
    f.tombstoneLaunch.mockResolvedValueOnce(unbound).mockResolvedValueOnce({
      ...unbound,
      jobUid: 'job-late',
      templateHash: hash,
    });
    try {
      expect(await f.runtime.runOnce()).toBe(true);
      expect(f.observe).toHaveBeenCalledWith(
        expect.objectContaining({ task: unbound }),
        expect.any(AbortSignal)
      );
      expect(f.observe.mock.invocationCallOrder[0]).toBeLessThan(
        f.bindCleanupJob.mock.invocationCallOrder[0]!
      );
      expect(f.bindCleanupJob).toHaveBeenCalledWith(task.id, launchId, 'job-late', hash);
      expect(f.deleteNow).toHaveBeenCalledWith(
        expect.objectContaining({
          task: expect.objectContaining({ jobUid: 'job-late' }),
        }),
        expect.any(AbortSignal)
      );
      expect(f.bindCleanupJob.mock.invocationCallOrder[0]).toBeLessThan(
        f.deleteNow.mock.invocationCallOrder[0]!
      );
      expect(f.remove).not.toHaveBeenCalled();
    } finally {
      await f.runtime.stop();
    }
  });

  it.each(['template-mismatch', 'different-uid', 'missing-job'] as const)(
    'never binds or deletes an unbound late CREATE after %s validation',
    async (failure) => {
      const unbound = { ...task, jobUid: null, terminalCandidate: 'failed' } as TaskRecord;
      const f = fixture(unbound, 'job-late', 'c'.repeat(64));
      if (failure === 'template-mismatch')
        f.observe.mockRejectedValueOnce(new TaskExecutorError('template_mismatch'));
      else if (failure === 'different-uid')
        f.observe.mockResolvedValueOnce({ ...f.observation, jobUid: 'foreign-job' });
      else f.observe.mockResolvedValueOnce(null);
      try {
        expect(await f.runtime.runOnce()).toBe(false);
        expect(f.observe).toHaveBeenCalledOnce();
        expect(f.bindCleanupJob).not.toHaveBeenCalled();
        expect(f.remove).not.toHaveBeenCalled();
        expect(f.deleteNow).not.toHaveBeenCalled();
      } finally {
        await f.runtime.stop();
      }
    }
  );

  it.each(['unknown', 'different-uid', 'missing-hash'] as const)(
    'keeps %s observed removal separate from attributed task evidence',
    async (kind) => {
      const fresh =
        kind === 'unknown'
          ? null
          : kind === 'missing-hash'
            ? ({ ...task, jobUid: null } as TaskRecord)
            : task;
      const f = fixture(fresh, 'job-not-bound');
      try {
        expect(await f.runtime.runOnce()).toBe(true);
        expect(f.remove).toHaveBeenCalledOnce();
        expect(f.deleteNow).not.toHaveBeenCalled();
        expect(f.bindCleanupJob).not.toHaveBeenCalled();
      } finally {
        await f.runtime.stop();
      }
    }
  );

  it('shares one bounded production trace writer before finalizer startup and outside channel TLS', () => {
    const source = readFileSync('src/core/container.ts', 'utf8');
    const initialization = source.indexOf(
      'traces = createPostgresTraceStore({ pool: tracePool });'
    );
    expect(initialization).toBeGreaterThan(0);
    expect(initialization).toBeLessThan(source.indexOf('await finalizer.start();'));
    expect(initialization).toBeLessThan(
      source.indexOf('if (!mergedConfig.motorCortex.enabled && channelTlsDir) {')
    );
    expect(source.match(/createPostgresTraceStore\(\{ pool: tracePool \}\)/g)).toHaveLength(1);
    expect(
      source.match(
        /createKubernetesTaskExecutor\(\{\s*\.\.\.\(traces \? \{ traces \} : \{\}\),?\s*\}\)/g
      )
    ).toHaveLength(2);
    expect(source).toContain('traces?.enqueue({');
    expect(source).toMatch(
      /const tracePool = new Pool\(\{[^}]*max: 1,[^}]*application_name: 'lifemodel-observability'/
    );
    expect(source).toContain('await traceStore.close(deadline, signal);');
    expect(source).toContain(
      'const taskTraceDrain = stopTaskTraces?.(deadline, traceStop.signal);'
    );
  });
});
