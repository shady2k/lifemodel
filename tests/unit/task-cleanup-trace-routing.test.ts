import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { TaskRecord, TaskRegistry } from '../../src/ports/tasks.js';
import { createTaskLaunchReconciler } from '../../src/core/task-launch.js';
import { createFakeTaskExecutor } from '../../src/core/fake-task-executor.js';
import { TaskExecutorError } from '../../src/core/task-executor.js';
import { createKubernetesTaskExecutor } from '../../src/core/kubernetes-task-executor.js';
import type { TaskKubernetesResponse } from '../../src/core/task-kubernetes-client.js';
import { postgresKnownSecrets } from '../../src/storage/postgres-known-secrets.js';
import { scrubTraceRecord } from '../../src/storage/postgres-trace-store.js';
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
  it.each(['template-mismatch', 'evidence-unavailable'] as const)(
    'keeps raw removal and admission independent from %s evidence',
    async (failure) => {
      const f = fixture();
      f.observe.mockRejectedValue(new TaskExecutorError('template_mismatch'));
      f.captureTermination.mockRejectedValueOnce(
        new TaskExecutorError(failure === 'template-mismatch' ? 'template_mismatch' : 'api_error')
      );
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
        expect(f.logs.some((log) => log.obj?.code === 'task_pod_evidence_unavailable')).toBe(true);
      } finally {
        await f.runtime.stop();
      }
    }
  );

  it('keeps scan cleanup and admission working when Pods and the listed Job vanish', async () => {
    const job = {
      metadata: {
        name: task.jobName,
        namespace: 'lifemodel-motor',
        uid: task.jobUid,
        resourceVersion: '7',
        labels: { 'lifemodel.dev/launch-id': launchId.slice(7, 65) },
      },
      spec: {}, // An older template must not veto exact-UID scan cleanup.
    };
    const request = vi.fn(async (method: string, path: string): Promise<TaskKubernetesResponse> => {
      if (method === 'GET' && path.includes('/jobs?'))
        return {
          status: 200,
          body: { items: [job], metadata: { resourceVersion: '8' } },
        };
      if (method === 'GET' && path.includes('/pods?'))
        return {
          status: 200,
          body: { items: [], metadata: { resourceVersion: '9' } },
        };
      if (method === 'DELETE' && path.endsWith(`/jobs/${task.jobName}`))
        return { status: 404, body: {} };
      throw new Error('Unexpected scan API request');
    });
    const enqueue = vi.fn(() => true);
    const executor = createKubernetesTaskExecutor({
      client: { request, close: vi.fn() },
      traces: { enqueue },
    });
    const admitNext = vi.fn(async () => null);
    const logs: RecordedLog[] = [];
    const runtime = createTaskLaunchReconciler({
      registry: {
        listLaunchWork: async () => [],
        readByJobName: async () => task,
        tombstoneLaunch: vi.fn(async () => task),
        admitNext,
      } as unknown as TaskRegistry,
      executor,
      storage: { allocate: vi.fn(), close: vi.fn() },
      logger: recordingLogger(createTestLogger(), logs),
      scanJobs: async (signal) =>
        (await executor.listJobs(signal)).map((observed) => ({
          ...observed,
          captureTermination: (record: TaskRecord, abortSignal: AbortSignal) =>
            executor.capturePodTermination(observed, record, abortSignal),
          remove: (abortSignal: AbortSignal) => executor.deleteJob(observed, abortSignal),
        })),
    });
    try {
      expect(await runtime.runOnce()).toBe(true);
      expect(request.mock.calls.map(([method, path]) => [method, path.split('?')[0]])).toEqual([
        ['GET', '/apis/batch/v1/namespaces/lifemodel-motor/jobs'],
        ['GET', '/api/v1/namespaces/lifemodel-motor/pods'],
        ['DELETE', `/apis/batch/v1/namespaces/lifemodel-motor/jobs/${task.jobName}`],
      ]);
      expect(enqueue).not.toHaveBeenCalled();
      expect(logs).toEqual([]);
      expect(admitNext).toHaveBeenCalledOnce();
    } finally {
      await runtime.stop();
      executor.close();
    }
  });

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

  it.each(['plain-canary', 'encoded%2Fcanary%3Avalue'])(
    'redacts the bare database credential in trace and mailbox text',
    (password) => {
      const databaseUrl = `postgres://core:${password}@database.invalid/core`;
      const secrets = postgresKnownSecrets(databaseUrl);
      const clean = scrubTraceRecord(
        {
          kind: 'event',
          event: {
            recordId: 'credential-redaction',
            traceId: 'credential-redaction',
            spanId: 'root',
            event: 'output',
            ts: '2026-01-01T00:00:00Z',
            fields: {
              trace: `Reading ${password} safely`,
              mailbox: `Reading ${decodeURIComponent(password)} safely`,
            },
          },
        },
        secrets
      );
      expect(clean.kind === 'event' && clean.event.fields).toEqual({
        trace: 'Reading [REDACTED] safely',
        mailbox: 'Reading [REDACTED] safely',
      });
    }
  );

  it('does not add an empty password or duplicate a plain password', () => {
    const databaseUrl = 'postgres://core@database.invalid/core';
    expect(postgresKnownSecrets(databaseUrl)).toEqual([databaseUrl]);
    expect(postgresKnownSecrets('postgres://core:plain-canary@database.invalid/core')).toHaveLength(
      2
    );
  });

  it('shares one bounded trace writer before finalizer startup, model wiring and channel TLS', () => {
    const source = readFileSync('src/core/container.ts', 'utf8');
    const initialization = source.indexOf('traces = createPostgresTraceStore({');
    expect(initialization).toBeGreaterThan(0);
    expect(initialization).toBeLessThan(source.indexOf('await finalizer.start();'));
    expect(initialization).toBeLessThan(
      source.indexOf('if (!mergedConfig.motorCortex.enabled && channelTlsDir) {')
    );
    // One writer, created whether or not the task channel exists, before the
    // provider that records model calls into it (lifemodel-d4t8).
    expect(source.match(/traces = createPostgresTraceStore\(/g)).toHaveLength(1);
    expect(initialization).toBeLessThan(
      source.indexOf('createLLMProvider(llmConfig, logger, traces)')
    );
    expect(initialization).toBeLessThan(
      source.indexOf('if (!mergedConfig.motorCortex.enabled && controlTokenFile')
    );
    expect(source.match(/knownSecrets: postgresKnownSecrets\(databaseUrl\)/g)).toHaveLength(2);
    expect(source.match(/createKubernetesTaskExecutor\(\{ traces \}\)/g)).toHaveLength(2);
    expect(source).toContain('traces.enqueue({');
    expect(source).toMatch(
      /const tracePool = new Pool\(\{[^}]*max: 1,[^}]*application_name: 'lifemodel-observability'/
    );
    expect(source).toContain('await traces.close(deadline, signal);');
    expect(source).toContain('const taskTraceDrain = stopTaskTraces(deadline, traceStop.signal);');
  });
});
