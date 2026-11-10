import { expect, it } from 'vitest';
import {
  createLogsStrandedRecovery,
  LOGS_STRANDED_DAYS_ANNOTATION,
} from '../../loader/src/logs-stranded-recovery.js';
import { LOGS_STORE_DEPLOYMENT_PATH } from '../../loader/src/logs-settings-cluster.js';
import type { LogsEviction } from '../../loader/src/logs-store-adapter.js';
import type { KubernetesObjectApi } from '../../loader/src/logs-volume-claim.js';

const DAY = '20261106';
const stranded = (day = DAY): LogsEviction => ({
  time: '2026-11-09T12:00:00Z',
  day,
  freedBytes: null,
  reason: 'stranded_partition',
  message: 'failed',
});
const drop = (day = DAY): LogsEviction => ({
  time: '2026-11-09T12:01:00Z',
  day,
  freedBytes: 100,
  reason: 'below_threshold',
  message: 'dropped',
});

function fixture() {
  let lines: LogsEviction[] = [stranded()];
  let refuse = false;
  let loseReply = false;
  let resourceVersion = 1;
  let annotations: Record<string, string> = {
    'lifemodel.dev/logs-settings-revision': 'settings',
    'lifemodel.dev/logs-partition-key-revision': 'key',
  };
  const patches: unknown[] = [];
  const api: KubernetesObjectApi = {
    get: async (path) => {
      expect(path).toBe(LOGS_STORE_DEPLOYMENT_PATH);
      return {
        status: 200,
        body: JSON.stringify({
          metadata: { resourceVersion: String(resourceVersion), annotations },
          spec: { template: { metadata: { annotations } } },
        }),
      };
    },
    patch: async (path, body) => {
      expect(path).toBe(LOGS_STORE_DEPLOYMENT_PATH);
      if (refuse) return { status: 403, body: '{}' };
      const patch = JSON.parse(body);
      if (patch.metadata.resourceVersion !== String(resourceVersion))
        return { status: 409, body: '{}' };
      patches.push(patch);
      annotations = { ...annotations, ...patch.metadata.annotations };
      resourceVersion++;
      if (loseReply) throw new Error('response lost');
      return { status: 200, body: '{}' };
    },
    create: async () => {
      throw new Error('must not create');
    },
    update: async () => {
      throw new Error('must not update');
    },
  };
  const options = {
    api,
    store: { evictions: async () => ({ state: 'ok' as const, evictions: lines }) },
    logger: { info: () => undefined, warn: () => undefined },
  };
  return {
    options,
    patches,
    setLines: (value: LogsEviction[]) => {
      lines = value;
    },
    loseReply: () => {
      loseReply = true;
    },
    refuse: () => {
      refuse = true;
    },
  };
}

it('rolls once for a stranded day, including after a loader restart', async () => {
  const f = fixture();
  const recovery = createLogsStrandedRecovery(f.options);
  await recovery.reconcile();
  await recovery.reconcile();
  await createLogsStrandedRecovery(f.options).reconcile();
  expect(f.patches).toEqual([
    {
      metadata: { resourceVersion: '1', annotations: { [LOGS_STRANDED_DAYS_ANNOTATION]: DAY } },
      spec: { template: { metadata: { annotations: { [LOGS_STRANDED_DAYS_ANNOTATION]: DAY } } } },
    },
  ]);
});

it('a later drop clears the pending stranded day; an earlier drop does not', async () => {
  const f = fixture();
  f.setLines([stranded(), drop()]);
  await createLogsStrandedRecovery(f.options).reconcile();
  expect(f.patches).toHaveLength(0);
  f.setLines([{ ...drop(), time: '2026-11-09T11:00:00Z' }, stranded()]);
  await createLogsStrandedRecovery(f.options).reconcile();
  expect(f.patches).toHaveLength(1);
});

it('does nothing without a newest stranded failure', async () => {
  const f = fixture();
  for (const lines of [
    [],
    [drop()],
    [{ ...stranded(), reason: 'rejected' }],
    [stranded(), { ...stranded(), time: '2026-11-09T12:02:00Z', reason: 'timeout' }],
  ]) {
    f.setLines(lines);
    await createLogsStrandedRecovery(f.options).reconcile();
  }
  expect(f.patches).toHaveLength(0);
});

it('remembers all restarted days and does not roll twice on concurrent reads', async () => {
  const f = fixture();
  await Promise.all([
    createLogsStrandedRecovery(f.options).reconcile(),
    createLogsStrandedRecovery(f.options).reconcile(),
  ]);
  expect(f.patches).toHaveLength(1);
  f.setLines([stranded('20261107')]);
  await createLogsStrandedRecovery(f.options).reconcile();
  expect(f.patches).toHaveLength(2);
  f.setLines([stranded()]);
  await createLogsStrandedRecovery(f.options).reconcile();
  expect(f.patches).toHaveLength(2);
});

it('a refused roll stays a failure, never changes retention or the key', async () => {
  const f = fixture();
  f.refuse();
  await createLogsStrandedRecovery(f.options).reconcile();
  expect(f.patches).toHaveLength(0);
});

it('keeps the durable receipt when the accepted rollout response is lost', async () => {
  const f = fixture();
  f.loseReply();
  await createLogsStrandedRecovery(f.options).reconcile();
  await createLogsStrandedRecovery(f.options).reconcile();
  expect(f.patches).toHaveLength(1);
});
