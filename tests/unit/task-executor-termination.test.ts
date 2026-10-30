import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '../../src/ports/tasks.js';
import type { TaskLaunch } from '../../src/core/task-executor.js';
import type { TaskKubernetesResponse } from '../../src/core/task-kubernetes-client.js';
import { TaskExecutorError } from '../../src/core/task-executor.js';
import { createFakeTaskExecutor } from '../../src/core/fake-task-executor.js';
import {
  createKubernetesTaskExecutor,
  renderTaskJob,
} from '../../src/core/kubernetes-task-executor.js';

const launchId = `launch_${'a'.repeat(64)}`;
const namespace = 'lifemodel-motor';
const task = {
  id: `task_${'b'.repeat(64)}`,
  traceId: 'task-executor-trace',
  parentSpanId: null,
  launchId,
  jobName: `task-${'a'.repeat(58)}`,
  jobUid: 'job-uid',
  podUid: 'pod-uid',
  templateHash: null,
  imageRevision: `sha256:${'c'.repeat(64)}`,
  wrapGraceSeconds: 30,
  profile: { timeoutSeconds: 600, cpuMillis: 500, memoryBytes: 536870912 },
  state: 'running',
} as TaskRecord;
const launch: TaskLaunch = {
  task,
  spaceId: 'space-1',
  workbenchImage: `zot.lifemodel-system.svc:5001/lifemodel/workbench@${task.imageRevision}`,
};
function owner(kind = 'Job', uid = 'job-uid', name = task.jobName) {
  return { apiVersion: kind === 'Job' ? 'batch/v1' : 'v1', kind, uid, name, controller: true };
}
function pod(phase?: string, uid = 'pod-uid', jobUid = 'job-uid') {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `${task.jobName}-${uid}`,
      namespace,
      uid,
      resourceVersion: '7',
      // No labels: ownership, not mutable labels, determines cleanup authority.
      ownerReferences: [owner('Job', jobUid)],
    },
    ...(phase ? { status: { phase } } : {}),
  };
}
function claim(podUid = 'pod-uid', podName = `${task.jobName}-${podUid}`) {
  return {
    metadata: {
      name: `${podName}-work`,
      namespace,
      uid: 'claim-uid',
      resourceVersion: '8',
      ownerReferences: [owner('Pod', podUid, podName)],
    },
  };
}
function fixture() {
  const state = {
    job: null as ReturnType<typeof renderTaskJob> | null,
    pods: [] as ReturnType<typeof pod>[],
    claims: [] as ReturnType<typeof claim>[],
    removeOnDelete: true,
  };
  const request = vi.fn(
    async (method: string, path: string, body?: unknown): Promise<TaskKubernetesResponse> => {
      const url = new URL(path, 'https://kubernetes.invalid');
      if (method === 'GET' && url.pathname.endsWith('/pods'))
        return { status: 200, body: { items: state.pods, metadata: { resourceVersion: '10' } } };
      if (method === 'GET' && url.pathname.endsWith('/persistentvolumeclaims'))
        return { status: 200, body: { items: state.claims, metadata: { resourceVersion: '11' } } };
      if (method === 'GET') return { status: state.job ? 200 : 404, body: state.job ?? {} };
      if (method === 'DELETE') {
        const identity = (body as { preconditions: { uid: string; resourceVersion: string } })
          .preconditions;
        if (url.pathname.includes('/pods/')) {
          const current = state.pods.find(
            (item) => item.metadata.name === url.pathname.split('/').at(-1)
          );
          expect(identity).toEqual({
            uid: current?.metadata.uid,
            resourceVersion: current?.metadata.resourceVersion,
          });
          if (state.removeOnDelete) state.pods = state.pods.filter((item) => item !== current);
        } else {
          if (!state.job) return { status: 404, body: {} };
          expect(identity).toEqual({
            uid: state.job.metadata.uid,
            resourceVersion: state.job.metadata.resourceVersion,
          });
          if (state.removeOnDelete) state.job = null;
        }
        return { status: 202, body: {} };
      }
      throw new Error('Unexpected fake API request');
    }
  );
  const api = createKubernetesTaskExecutor({ client: { request, close: vi.fn() } });
  return { api, request, state };
}

describe('exact-UID compute and volume cleanup confirmation', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    `ghcr.io/shady2k/lifemodel-workbench@${task.imageRevision}`,
    'zot.lifemodel-system.svc:5001/lifemodel/workbench:latest',
    `zot.lifemodel-system.svc:5001/lifemodel/other@${task.imageRevision}`,
    `other.example:5001/lifemodel/workbench@${task.imageRevision}`,
    `zot.lifemodel-system.svc:5001/lifemodel/workbench@sha256:${'A'.repeat(64)}`,
    `zot.lifemodel-system.svc:5001/lifemodel/workbench@sha256:${'a'.repeat(63)}`,
  ])(
    'refuses noncanonical image %s with a safe code before any Kubernetes call',
    async (workbenchImage) => {
      const { api, request } = fixture();
      const invalid = { ...launch, workbenchImage };
      expect(() => renderTaskJob(invalid)).toThrow('TaskExecutorError: invalid_launch');
      await expect(api.ensureStarted(invalid)).rejects.toMatchObject({ code: 'invalid_launch' });
      await expect(api.observe(invalid)).rejects.toMatchObject({ code: 'invalid_launch' });
      await expect(api.requestSoftStop(invalid)).rejects.toMatchObject({ code: 'invalid_launch' });
      await expect(api.deleteNow(invalid)).rejects.toMatchObject({ code: 'invalid_launch' });
      await expect(api.confirmTerminated(invalid)).rejects.toMatchObject({
        code: 'invalid_launch',
      });
      await expect(api.confirmCleanup(invalid)).rejects.toMatchObject({ code: 'invalid_launch' });
      expect(request).not.toHaveBeenCalled();
    }
  );

  it('projects pulling-image with the event clock before the start claim, without raw values', async () => {
    const { api, request, state } = fixture();
    const starting = {
      ...launch,
      task: { ...task, state: 'starting' as const, podUid: null },
    };
    state.job = renderTaskJob(starting);
    state.job.metadata.uid = 'job-uid';
    state.job.metadata.resourceVersion = '1';
    state.pods = [pod('Pending')];
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, path, body) => {
      if (path.includes('/events?'))
        return {
          status: 200,
          body: {
            items: [
              {
                involvedObject: { uid: 'pod-uid' },
                reason: 'Pulling',
                firstTimestamp: '2026-10-30T22:00:00Z',
                lastTimestamp: '2026-10-30T22:00:00Z',
                message: 'PRIVATE image and node values',
              },
            ],
          },
        };
      return original(method, path, body);
    });
    const observation = await api.observe(starting);
    expect(observation?.startup).toEqual({
      phase: 'pulling-image',
      since: new Date('2026-10-30T22:00:00Z'),
    });
    expect(JSON.stringify(observation)).not.toContain('PRIVATE');
  });

  it.each([
    ['Pulling', 'pulling-image'],
    ['Pulled', 'image-pulled'],
    ['Started', 'container-started'],
  ])('projects %s as %s using eventTime before the legacy lastTimestamp', async (reason, phase) => {
    const { api, request, state } = fixture();
    const starting = { ...launch, task: { ...task, state: 'starting' as const, podUid: null } };
    state.job = renderTaskJob(starting);
    Object.assign(state.job.metadata, { uid: 'job-uid', resourceVersion: '1' });
    state.pods = [pod('Pending')];
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, path, body) => {
      if (path.includes('/events?'))
        return {
          status: 200,
          body: {
            items: [
              {
                involvedObject: { uid: 'pod-uid' },
                reason: 'Pulling',
                lastTimestamp: '2026-10-30T22:00:01Z',
              },
              { involvedObject: { uid: 'pod-uid' }, reason, eventTime: '2026-10-30T22:00:02Z' },
            ],
          },
        };
      return original(method, path, body);
    });
    expect((await api.observe(starting))?.startup).toEqual({
      phase,
      since: new Date('2026-10-30T22:00:02Z'),
    });
  });

  it('does not hide failed Job evidence when the startup Pod projection fails', async () => {
    const { api, request, state } = fixture();
    const starting = {
      ...launch,
      task: {
        ...task,
        state: 'starting' as const,
        podUid: null,
        acceptedAt: new Date('2026-10-30T22:00:00Z'),
      },
    };
    state.job = renderTaskJob(starting);
    Object.assign(state.job.metadata, { uid: 'job-uid', resourceVersion: '1' });
    state.job.status = { conditions: [{ type: 'Failed', status: 'True' }] };
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, path, body) => {
      if (path.includes('/pods?')) return { status: 500, body: {} };
      return original(method, path, body);
    });
    expect(await api.ensureStarted(starting)).toMatchObject({
      phase: 'failed',
      jobUid: 'job-uid',
      startup: { phase: 'waiting-for-scheduling', since: starting.task.acceptedAt },
    });
  });

  it.each(['Pending', 'Running', 'Unknown', undefined])(
    'Job 404 does not confirm an owned %s Pod has terminated',
    async (phase) => {
      const { api, state } = fixture();
      state.pods = [pod(phase)];
      expect(await api.observe(launch)).toBeNull();
      expect(await api.confirmTerminated(launch)).toBe(false);
      expect(await api.confirmCleanup(launch)).toBe(false);
    }
  );

  it.each(['Succeeded', 'Failed'])(
    'a terminal %s Pod releases compute but not cleanup',
    async (phase) => {
      const { api, state } = fixture();
      state.pods = [pod(phase)];
      expect(await api.confirmTerminated(launch)).toBe(true);
      expect(await api.confirmCleanup(launch)).toBe(false);
      await api.deleteNow(launch);
      expect(await api.confirmCleanup(launch)).toBe(true);
    }
  );

  it('deletes all exact-owned orphan Pods even after Job deletion, never a foreign UID', async () => {
    const { api, request, state } = fixture();
    state.pods = [
      pod('Running'),
      pod('Pending', 'duplicate'),
      pod('Running', 'foreign', 'different-job'),
    ];
    await api.deleteNow(launch);
    expect(state.pods.map((item) => item.metadata.uid)).toEqual(['foreign']);
    const deletes = request.mock.calls.filter(([method]) => method === 'DELETE');
    expect(deletes).toHaveLength(2);
    for (const [, , options] of deletes)
      expect(options).toMatchObject({ gracePeriodSeconds: 1, propagationPolicy: 'Foreground' });
    expect(await api.confirmTerminated(launch)).toBe(true);
    expect(await api.confirmCleanup(launch)).toBe(true);
  });

  it.each([null, 'pod-uid'])(
    'records startup termination before deletion without a bound Pod (%s)',
    async (podUid) => {
      const { request, state } = fixture();
      const records: import('../../src/ports/observability.js').TraceRecord[] = [];
      const enqueue = vi.fn((record: import('../../src/ports/observability.js').TraceRecord) => {
        expect(request.mock.calls.some(([method]) => method === 'DELETE')).toBe(false);
        records.push(record);
        return true;
      });
      const api = createKubernetesTaskExecutor({
        client: { request, close: vi.fn() },
        traces: { enqueue },
      });
      state.job = renderTaskJob(launch);
      Object.assign(state.job.metadata, {
        uid: 'job-uid',
        resourceVersion: '1',
      });
      state.job.status = { conditions: [{ type: 'Failed', status: 'True' }] };
      const failed = pod('Failed');
      Object.assign(failed.status!, {
        containerStatuses: [
          {
            name: 'task',
            state: {
              terminated: {
                exitCode: 1,
                reason: 'Error',
                message:
                  '{"code":"launcher_start_failed","reasonCode":"ERR_MODULE_NOT_FOUND","module":"model-error-excerpt.js"}',
              },
            },
          },
        ],
      });
      const foreign = pod('Failed', 'foreign', 'different-job');
      state.pods = [foreign, failed];
      await api.deleteNow({ ...launch, task: { ...task, podUid } });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        kind: 'span',
        span: {
          traceId: task.traceId,
          parentSpanId: task.launchId,
          component: 'task.pod',
          status: 'failed',
          attrs: {
            taskId: task.id,
            podUid: 'pod-uid',
            exitCode: 1,
            reason: 'Error',
            terminationMessage: expect.stringContaining('model-error-excerpt.js'),
          },
        },
      });
      expect(request.mock.calls.some(([method]) => method === 'DELETE')).toBe(true);
    }
  );

  it.each(['old-template', 'vanished'] as const)(
    'captures exact controller evidence and removes a %s scanned Job without template GET',
    async (mode) => {
      const { request, state } = fixture();
      const records: import('../../src/ports/observability.js').TraceRecord[] = [];
      const api = createKubernetesTaskExecutor({
        client: { request, close: vi.fn() },
        traces: {
          enqueue: (record) => {
            records.push(record);
            return true;
          },
        },
      });
      const old = renderTaskJob(launch);
      Object.assign(old.metadata, { uid: 'job-uid', resourceVersion: '1' });
      old.spec['activeDeadlineSeconds'] = 86400; // Invalid for today's accepted template.
      state.job = mode === 'vanished' ? null : old;
      const failed = pod('Failed');
      Object.assign(failed.status!, {
        containerStatuses: [
          {
            name: 'task',
            state: {
              terminated: { exitCode: 1, reason: 'Error', message: 'launcher_start_failed' },
            },
          },
        ],
      });
      state.pods = [failed, pod('Failed', 'foreign', 'different-job')];
      const observed = {
        name: task.jobName,
        uid: 'job-uid',
        resourceVersion: '1',
        launchLabel: task.launchId.slice(7, 65),
        templateHash: 'obsolete',
        job: old,
      };
      await api.capturePodTermination(observed, task);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        kind: 'span',
        span: { attrs: { exitCode: 1, reason: 'Error' } },
      });
      await api.deleteJob(observed);
      expect(
        request.mock.calls.some(([method, path]) => method === 'GET' && path.includes('/jobs/'))
      ).toBe(false);
      expect(request.mock.calls.some(([method]) => method === 'DELETE')).toBe(true);
    }
  );

  it('bounds and scrubs untrusted termination fields without reading pod logs', async () => {
    const { request, state } = fixture();
    const records: import('../../src/ports/observability.js').TraceRecord[] = [];
    const api = createKubernetesTaskExecutor({
      client: { request, close: vi.fn() },
      traces: {
        enqueue: (record) => {
          records.push(record);
          return true;
        },
      },
    });
    const failed = pod('Failed');
    Object.assign(failed.status!, {
      containerStatuses: [
        {
          name: 'task',
          state: {
            terminated: {
              exitCode: 137,
              reason: 'OOMKilled\u001b[31m',
              message: `token=private-value\n${'x'.repeat(6000)}\u001b[2J`,
            },
          },
        },
      ],
    });
    state.pods = [failed];
    await api.deleteNow(launch);
    const record = records[0];
    expect(record?.kind).toBe('span');
    if (record?.kind !== 'span') throw new Error('missing Pod span');
    expect(record.span.attrs['exitCode']).toBe(137);
    expect(record.span.attrs['reason']).not.toContain('\u001b');
    expect(Buffer.byteLength(String(record.span.attrs['terminationMessage']))).toBeLessThanOrEqual(
      2048
    );
    expect(JSON.stringify(records)).not.toContain('private-value');
    expect(request.mock.calls.every(([, path]) => !path.includes('/log'))).toBe(true);
  });

  it('keeps deletion fail-open when the disposable trace queue rejects evidence', async () => {
    const { request, state } = fixture();
    const failed = pod('Failed');
    Object.assign(failed.status!, {
      containerStatuses: [
        {
          name: 'task',
          state: { terminated: { exitCode: 1, reason: 'Error' } },
        },
      ],
    });
    state.pods = [failed];
    const api = createKubernetesTaskExecutor({
      client: { request, close: vi.fn() },
      traces: { enqueue: () => false },
    });
    await api.deleteNow(launch);
    expect(request.mock.calls.some(([method]) => method === 'DELETE')).toBe(true);
  });

  it('does not treat an accepted DELETE or deletionTimestamp as termination', async () => {
    const { api, state } = fixture();
    state.removeOnDelete = false;
    state.pods = [pod('Running')];
    Object.assign(state.pods[0]!.metadata, { deletionTimestamp: new Date().toISOString() });
    await api.deleteNow(launch);
    expect(await api.confirmTerminated(launch)).toBe(false);
  });

  it('does not infer unbound launch termination from Job 404 with an owned orphan Pod', async () => {
    const { api, state } = fixture();
    const unbound = { ...launch, task: { ...task, jobUid: null, podUid: null } };
    state.pods = [pod('Running')];
    expect(await api.confirmTerminated(unbound)).toBe(false);
    await expect(api.deleteNow(unbound)).rejects.toMatchObject({ code: 'identity_mismatch' });
    state.pods = [];
    state.claims = [claim('duplicate')];
    expect(await api.confirmTerminated(unbound)).toBe(true);
    expect(await api.confirmCleanup(unbound)).toBe(false);
    state.claims = [];
    expect(await api.confirmCleanup(unbound)).toBe(true);
  });

  it.each(['missing', 'failed', 'running', 'replacement'] as const)(
    'observes %s bound Pod evidence before stale Job status catches up',
    async (mode) => {
      const { api, state } = fixture();
      state.job = renderTaskJob(launch);
      Object.assign(state.job.metadata, { uid: 'job-uid', resourceVersion: '1' });
      state.job.status = { startTime: '2026-10-24T00:00:00Z' };
      state.pods =
        mode === 'missing'
          ? []
          : [
              pod(
                mode === 'failed' ? 'Failed' : 'Running',
                mode === 'replacement' ? 'replacement' : 'pod-uid'
              ),
            ];
      const observed = await api.observe(launch);
      if (mode === 'running') {
        expect(observed).toMatchObject({ phase: 'running' });
        expect(observed?.failureReason).toBeUndefined();
      } else {
        expect(observed).toMatchObject({
          phase: 'failed',
          failureReason: mode === 'failed' ? 'pod_failed' : 'compute_missing',
        });
      }
    }
  );

  it('does not fail an unbound pending Job just because no Pod has appeared yet', async () => {
    const { api, request, state } = fixture();
    state.job = renderTaskJob(launch);
    Object.assign(state.job.metadata, { uid: 'job-uid', resourceVersion: '1' });
    expect(await api.observe({ ...launch, task: { ...task, podUid: null } })).toMatchObject({
      phase: 'pending',
    });
    expect(request.mock.calls).toHaveLength(1);
  });

  it('fake scripts Pod failure evidence without teaching callers another backend', async () => {
    const api = createFakeTaskExecutor();
    const unbound = { ...launch, task: { ...task, jobUid: null } };
    const first = await api.ensureStarted(unbound);
    api.setObservation(task.jobName, { phase: 'failed', failureReason: 'compute_missing' });
    expect(await api.observe({ ...launch, task: { ...task, jobUid: first.jobUid } })).toMatchObject(
      {
        phase: 'failed',
        failureReason: 'compute_missing',
      }
    );
  });

  it('waits for Job disappearance even when no Pods are listed', async () => {
    const { api, state } = fixture();
    state.job = renderTaskJob(launch);
    Object.assign(state.job.metadata, { uid: 'job-uid', resourceVersion: '1' });
    state.job.status = { conditions: [{ type: 'Complete', status: 'True' }] };
    expect(await api.confirmTerminated(launch)).toBe(false);
    await api.deleteNow(launch);
    expect(await api.confirmTerminated(launch)).toBe(true);
  });

  it('refuses a same-name replacement Job UID without deleting it', async () => {
    const { api, request, state } = fixture();
    state.job = renderTaskJob(launch);
    Object.assign(state.job.metadata, { uid: 'replacement', resourceVersion: '2' });
    await expect(api.deleteNow(launch)).rejects.toMatchObject({ code: 'identity_mismatch' });
    await expect(api.confirmTerminated(launch)).rejects.toMatchObject({
      code: 'identity_mismatch',
    });
    expect(request.mock.calls.some(([method]) => method === 'DELETE')).toBe(false);
  });

  it('waits for generic ephemeral PVC GC after Pod loss, including an unbound duplicate Pod', async () => {
    const { api, request, state } = fixture();
    state.claims = [claim(), claim('duplicate')];
    expect(await api.confirmTerminated(launch)).toBe(true);
    expect(await api.confirmCleanup(launch)).toBe(false);
    state.claims.shift();
    expect(await api.confirmCleanup(launch)).toBe(false);
    state.claims = [claim('foreign', 'unrelated-pod')];
    expect(await api.confirmCleanup(launch)).toBe(true);
    expect(request.mock.calls.some(([method]) => method === 'DELETE')).toBe(false);
  });

  it('reads every page before claiming absence', async () => {
    const { api, request } = fixture();
    request.mockImplementation(async (_method, path) => {
      if (path.includes('/jobs/')) return { status: 404, body: {} };
      const last = new URL(path, 'https://fake').searchParams.has('continue');
      return {
        status: 200,
        body: {
          items: last ? [pod('Running')] : [],
          metadata: { resourceVersion: '10', continue: last ? '' : 'next' },
        },
      };
    });
    expect(await api.confirmTerminated(launch)).toBe(false);
    expect(request.mock.calls.at(-1)?.[1]).toContain('continue=next');
  });

  it.each(['loop', 'version', 'oversized', 'status', 'malformed'])(
    'fails closed on a %s list response',
    async (mode) => {
      const { api, request } = fixture();
      let pages = 0;
      request.mockImplementation(async (_method, path) => {
        if (path.includes('/jobs/')) return { status: 404, body: {} };
        pages++;
        return {
          status: mode === 'status' ? 403 : 200,
          body: {
            items: mode === 'malformed' ? [{}] : [],
            metadata: {
              resourceVersion: mode === 'version' ? String(pages) : '10',
              continue: mode === 'oversized' ? 'x'.repeat(4097) : 'same',
            },
          },
        };
      });
      await expect(api.confirmTerminated(launch)).rejects.toBeInstanceOf(TaskExecutorError);
      expect(pages).toBeLessThanOrEqual(2);
    }
  );

  it('shares one Pod-list deadline across pages and cancels an outstanding request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { api, request } = fixture();
    const signals: AbortSignal[] = [];
    // The fixture mock's public transport supports an AbortSignal even though
    // its ordinary immediate handler does not inspect that fourth argument.
    request.mockImplementation(async (...args) => {
      const path = args[1];
      if (path.includes('/jobs/')) return { status: 404, body: {} };
      const signal = (args as unknown as [string, string, unknown, AbortSignal])[3];
      signals.push(signal);
      return new Promise((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(new TaskExecutorError('aborted'));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort);
          resolve({
            status: 200,
            body: {
              items: [],
              metadata: { resourceVersion: '1', continue: `next-${signals.length}` },
            },
          });
        }, 10_000);
        signal.addEventListener('abort', abort, { once: true });
      });
    });
    const pending = api.confirmTerminated(launch).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ code: 'aborted' });
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds empty unique pages and honors cancellation', async () => {
    const { api, request } = fixture();
    let pages = 0;
    request.mockImplementation(async (_method, path) => {
      if (path.includes('/jobs/')) return { status: 404, body: {} };
      return {
        status: 200,
        body: { items: [], metadata: { resourceVersion: '10', continue: `page-${++pages}` } },
      };
    });
    await expect(api.confirmTerminated(launch)).rejects.toMatchObject({ code: 'api_error' });
    expect(pages).toBe(100);
    const controller = new AbortController();
    controller.abort();
    await expect(api.confirmTerminated(launch, controller.signal)).rejects.toMatchObject({
      code: 'aborted',
    });
  });

  it('fake separates Job absence, delayed Pod termination and volume cleanup', async () => {
    const api = createFakeTaskExecutor();
    const first = await api.ensureStarted({ ...launch, task: { ...task, jobUid: null } });
    const bound = { ...launch, task: { ...task, jobUid: first.jobUid } };
    api.setTerminationPending(first.jobUid, true);
    api.setCleanupPending(first.jobUid, true);
    await api.deleteNow(bound);
    expect(await api.observe(bound)).toBeNull();
    expect(await api.confirmTerminated(bound)).toBe(false);
    api.setTerminationPending(first.jobUid, false);
    expect(await api.confirmTerminated(bound)).toBe(true);
    expect(await api.confirmCleanup(bound)).toBe(false);
    api.setCleanupPending(first.jobUid, false);
    expect(await api.confirmCleanup(bound)).toBe(true);
  });
});
