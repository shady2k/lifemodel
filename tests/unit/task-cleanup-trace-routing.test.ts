import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { TaskRecord, TaskRegistry } from '../../src/ports/tasks.js';
import { createTaskLaunchReconciler } from '../../src/core/task-launch.js';
import { createFakeTaskExecutor } from '../../src/core/fake-task-executor.js';
import { TaskExecutorError } from '../../src/core/task-executor.js';
import { createTestLogger, recordingLogger, type RecordedLog } from '../helpers/test-logger.js';

const launchId = `launch_${'a'.repeat(64)}`;
const task = {
  id: 'task-scan-cleanup',
  traceId: 'trace-scan-cleanup',
  launchId,
  jobName: `task-${launchId.slice(7, 65)}`,
  jobUid: 'job-bound',
  state: 'failed',
  tombstonedAt: new Date(),
} as TaskRecord;

function fixture(fresh: TaskRecord | null = task) {
  const remove = vi.fn(async () => undefined);
  const nextRemove = vi.fn(async () => undefined);
  const captureTermination = vi.fn(async (_task: TaskRecord, _signal: AbortSignal) => undefined);
  const tombstoneLaunch = vi.fn(async () => fresh!);
  const admitNext = vi.fn(async () => null);
  const registry = {
    listLaunchWork: async () => [],
    readByJobName: async () => fresh,
    tombstoneLaunch,
    admitNext,
  } as unknown as TaskRegistry;
  const executor = createFakeTaskExecutor();
  const observe = vi.spyOn(executor, 'observe');
  const deleteNow = vi.spyOn(executor, 'deleteNow');
  const logs: RecordedLog[] = [];
  const runtime = createTaskLaunchReconciler({
    registry,
    executor,
    storage: { allocate: vi.fn(), close: vi.fn() },
    logger: recordingLogger(createTestLogger(), logs),
    scanJobs: async () => [
      {
        name: task.jobName,
        uid: 'job-bound',
        launchLabel: launchId.slice(7, 65),
        captureTermination,
        remove,
      },
      {
        name: 'other-job',
        uid: 'other-uid',
        launchLabel: launchId.slice(7, 65),
        remove: nextRemove,
      },
    ],
  });
  return {
    runtime,
    remove,
    nextRemove,
    captureTermination,
    tombstoneLaunch,
    admitNext,
    observe,
    deleteNow,
    logs,
  };
}

describe('task cleanup trace routing', () => {
  it.each(['template-mismatch', 'vanished', 'evidence-unavailable'] as const)(
    'keeps raw removal and admission independent from %s evidence',
    async (failure) => {
      const f = fixture();
      if (failure === 'vanished') f.observe.mockResolvedValue(null);
      else f.observe.mockRejectedValue(new TaskExecutorError('template_mismatch'));
      if (failure !== 'vanished')
        f.captureTermination.mockRejectedValueOnce(new TaskExecutorError('template_mismatch'));
      try {
        expect(await f.runtime.runOnce()).toBe(true);
        expect(f.remove).toHaveBeenCalledOnce();
        expect(f.nextRemove).toHaveBeenCalledOnce();
        expect(f.admitNext).toHaveBeenCalledOnce();
        expect(f.observe).not.toHaveBeenCalled();
        expect(f.deleteNow).not.toHaveBeenCalled();
        expect(f.tombstoneLaunch.mock.invocationCallOrder[0]).toBeLessThan(
          f.remove.mock.invocationCallOrder[0]!
        );
        expect(f.captureTermination.mock.invocationCallOrder[0]).toBeLessThan(
          f.remove.mock.invocationCallOrder[0]!
        );
        if (failure !== 'vanished')
          expect(f.logs.some((log) => log.obj?.code === 'task_pod_evidence_unavailable')).toBe(
            true
          );
      } finally {
        await f.runtime.stop();
      }
    }
  );

  it('continues later Jobs and admission when one exact-UID removal fails', async () => {
    const f = fixture();
    f.remove.mockRejectedValueOnce(new TaskExecutorError('api_error'));
    try {
      expect(await f.runtime.runOnce()).toBe(false);
      expect(f.nextRemove).toHaveBeenCalledOnce();
      expect(f.admitNext).toHaveBeenCalledOnce();
      expect(f.logs.some((log) => log.obj?.code === 'task_scan_cleanup_pending')).toBe(true);
    } finally {
      await f.runtime.stop();
    }
  });

  it('keeps unknown orphan removal without attributing it to any task', async () => {
    const f = fixture(null);
    try {
      expect(await f.runtime.runOnce()).toBe(true);
      expect(f.remove).toHaveBeenCalledOnce();
      expect(f.captureTermination).not.toHaveBeenCalled();
      expect(f.admitNext).toHaveBeenCalledOnce();
    } finally {
      await f.runtime.stop();
    }
  });

  it('shares one bounded production trace writer before finalizer startup and outside channel TLS', () => {
    const source = readFileSync('src/core/container.ts', 'utf8');
    const initialization = source.indexOf('traces = createPostgresTraceStore({');
    expect(initialization).toBeGreaterThan(0);
    expect(initialization).toBeLessThan(source.indexOf('await finalizer.start();'));
    expect(initialization).toBeLessThan(
      source.indexOf('if (!mergedConfig.motorCortex.enabled && channelTlsDir) {')
    );
    expect(source.match(/traces = createPostgresTraceStore\(/g)).toHaveLength(1);
    expect(source).toContain('knownSecrets: [');
    expect(source).toContain('rawPostgres.options.password');
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
