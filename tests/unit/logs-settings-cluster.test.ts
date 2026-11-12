/**
 * The three Kubernetes objects the retention setting touches (ADR-016 §5,
 * N6): the store's settings ConfigMap, the store's Deployment and its pods,
 * and the claim whose capacity the byte bound is measured against.
 *
 * The API is a recorded stub: this file asserts the paths, the verbs, the exact
 * patch body and what a refusal turns into.
 */
import { describe, expect, it } from 'vitest';
import {
  configMapLogData,
  createLogsSettingsCluster,
  LOGS_CLAIM_PATH,
  LOGS_SETTINGS_CONFIGMAP,
  LOGS_SETTINGS_CONFIGMAP_COLLECTION,
  LOGS_SETTINGS_CONFIGMAP_PATH,
  LOGS_SETTINGS_REVISION_ANNOTATION,
  LOGS_STORE_DEPLOYMENT,
  LOGS_STORE_DEPLOYMENT_PATH,
  LOGS_STORE_PODS_PATH,
  LOGS_PARTITION_KEY_FIELD,
  LOGS_PARTITION_KEY_REVISION_ANNOTATION,
  LOGS_PARTITION_KEY_SECRET,
  LOGS_PARTITION_KEY_SECRET_PATH,
} from '../../loader/src/logs-settings-cluster.js';
import type {
  KubernetesObjectApi,
  KubernetesObjectResponse,
} from '../../loader/src/logs-volume-claim.js';
import { storeFlagsOf, retentionLimits } from '../../loader/src/logs-retention.js';

const GIB = 1024 * 1024 * 1024;
const LIMITS = retentionLimits(3 * GIB);
const FLAGS = storeFlagsOf({ days: 7, maxBytes: 1_073_741_824 }, LIMITS);
const REVISION = '2-abcdef012345';

interface Call {
  method: string;
  path: string;
  body?: string;
}

/** An API that answers from a map of path → object, and records every call. */
function stubApi(objects: Record<string, unknown>, overrides: Record<string, number> = {}): {
  api: KubernetesObjectApi;
  calls: Call[];
} {
  const calls: Call[] = [];
  const answer = (status: number, body: unknown): KubernetesObjectResponse => ({
    status,
    body: JSON.stringify(body),
  });
  const handle = (method: string, path: string, body?: string): KubernetesObjectResponse => {
    calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    const override = overrides[`${method} ${path}`];
    if (override !== undefined) return answer(override, { message: 'refused' });
    const found = objects[path];
    if (method === 'POST') {
      objects[path] = JSON.parse(body ?? '{}') as unknown;
      return answer(201, objects[path]);
    }
    if (found === undefined) return answer(404, { message: 'not found' });
    if (method === 'PUT' || method === 'PATCH') {
      objects[path] = JSON.parse(body ?? '{}') as unknown;
      return answer(200, objects[path]);
    }
    return answer(200, found);
  };
  return {
    calls,
    api: {
      get: async (path) => handle('GET', path),
      patch: async (path, body) => handle('PATCH', path, body),
      create: async (path, body) => handle('POST', path, body),
      update: async (path, body) => handle('PUT', path, body),
    },
  };
}

const deployment = () => ({
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: LOGS_STORE_DEPLOYMENT, namespace: 'lifemodel-system', generation: 4 },
  spec: {
    replicas: 1,
    template: {
      metadata: { labels: { 'app.kubernetes.io/name': 'logs-store' } },
      spec: { containers: [{ name: 'logs-store' }] },
    },
  },
  status: {
    observedGeneration: 4,
    replicas: 1,
    updatedReplicas: 1,
    availableReplicas: 1,
    conditions: [{ type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable' }],
  },
});

const claim = () => ({
  apiVersion: 'v1',
  kind: 'PersistentVolumeClaim',
  metadata: { name: 'logs-store', namespace: 'lifemodel-system' },
  spec: { resources: { requests: { storage: '3Gi' } } },
  status: { phase: 'Bound', capacity: { storage: '3Gi' } },
});

const pods = (annotations?: Record<string, string>) => ({
  apiVersion: 'v1',
  kind: 'PodList',
  items: [
    {
      metadata: {
        name: 'logs-store-abc123-xyz',
        namespace: 'lifemodel-system',
        ...(annotations === undefined ? {} : { annotations }),
      },
    },
  ],
});

describe("the store's settings ConfigMap", () => {
  it('creates it with the three prefixed keys and the revision annotation', async () => {
    const { api, calls } = stubApi({ [LOGS_SETTINGS_CONFIGMAP_PATH]: undefined });
    const cluster = createLogsSettingsCluster({ api });
    const answer = await cluster.writeConfigMap(FLAGS, REVISION);
    expect(answer).toEqual({ state: 'ok', value: 'written' });
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ['GET', LOGS_SETTINGS_CONFIGMAP_PATH],
      ['POST', LOGS_SETTINGS_CONFIGMAP_COLLECTION],
    ]);
    const body = JSON.parse(calls[1]!.body ?? '{}') as Record<string, any>;
    expect(body.metadata.name).toBe(LOGS_SETTINGS_CONFIGMAP);
    expect(body.metadata.namespace).toBe('lifemodel-system');
    expect(body.metadata.annotations).toEqual({
      // Flux must not prune a ConfigMap the owner's setting owns.
      'kustomize.toolkit.fluxcd.io/prune': 'disabled',
      [LOGS_SETTINGS_REVISION_ANNOTATION]: REVISION,
    });
    expect(body.data).toEqual({
      VL_retentionPeriod: '7d',
      VL_retention_maxDiskSpaceUsageBytes: '1073741824',
      VL_storage_minFreeDiskSpaceBytes: '805306368',
    });
    expect(body.data).toEqual(configMapLogData(FLAGS));
  });

  it('updates with the read resourceVersion only when the data differs', async () => {
    const existing = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: LOGS_SETTINGS_CONFIGMAP,
        namespace: 'lifemodel-system',
        resourceVersion: '41',
        annotations: {
          'kustomize.toolkit.fluxcd.io/prune': 'disabled',
          [LOGS_SETTINGS_REVISION_ANNOTATION]: '1-old',
        },
      },
      data: configMapLogData(storeFlagsOf({ days: 14, maxBytes: 1_610_612_736 }, LIMITS)),
    };
    const { api, calls } = stubApi({ [LOGS_SETTINGS_CONFIGMAP_PATH]: structuredClone(existing) });
    const cluster = createLogsSettingsCluster({ api });
    expect(await cluster.writeConfigMap(FLAGS, REVISION)).toEqual({
      state: 'ok',
      value: 'written',
    });
    const update = calls.find((call) => call.method === 'PUT');
    expect(update?.path).toBe(LOGS_SETTINGS_CONFIGMAP_PATH);
    expect(JSON.parse(update?.body ?? '{}').metadata.resourceVersion).toBe('41');
    // The same write again is a comparison, not a request.
    const again = await createLogsSettingsCluster({ api }).writeConfigMap(FLAGS, REVISION);
    expect(again).toEqual({ state: 'ok', value: 'unchanged' });
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    // A matching data map under an older revision still needs the annotation.
    const older = createLogsSettingsCluster({
      api: stubApi({
        [LOGS_SETTINGS_CONFIGMAP_PATH]: {
          ...structuredClone(existing),
          data: configMapLogData(FLAGS),
        },
      }).api,
    });
    expect((await older.writeConfigMap(FLAGS, REVISION)).state).toBe('ok');
  });

  it('turns a refused write into forbidden and an answerless one into unavailable', async () => {
    const forbidden = createLogsSettingsCluster({
      api: stubApi({}, { [`GET ${LOGS_SETTINGS_CONFIGMAP_PATH}`]: 403 }).api,
    });
    expect(await forbidden.writeConfigMap(FLAGS, REVISION)).toEqual({ state: 'forbidden' });
    const unavailable = createLogsSettingsCluster({
      api: stubApi({}, { [`POST ${LOGS_SETTINGS_CONFIGMAP_COLLECTION}`]: 500 }).api,
    });
    expect(await unavailable.writeConfigMap(FLAGS, REVISION)).toEqual({ state: 'unavailable' });
  });
});

describe("the store's Deployment", () => {
  it('patches only its two annotation maps and answers the new generation', async () => {
    const current = deployment();
    const { api, calls } = stubApi({
      [LOGS_STORE_DEPLOYMENT_PATH]: {
        ...current,
        metadata: { ...current.metadata, generation: 5 },
      },
    });
    const cluster = createLogsSettingsCluster({ api });
    expect(await cluster.writeDeploymentRevision(REVISION)).toEqual({
      state: 'ok',
      value: { state: 'patched', generation: 5 },
    });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PATCH']);
    const patch = JSON.parse(calls[1]!.body ?? '{}') as Record<string, any>;
    expect(Object.keys(patch).sort()).toEqual(['metadata', 'spec']);
    expect(Object.keys(patch.metadata)).toEqual(['annotations']);
    expect(Object.keys(patch.spec)).toEqual(['template']);
    expect(Object.keys(patch.spec.template)).toEqual(['metadata']);
    expect(patch.spec.template.metadata.annotations).toEqual({
      [LOGS_SETTINGS_REVISION_ANNOTATION]: REVISION,
    });
    expect(patch.metadata.annotations).toEqual({
      [LOGS_SETTINGS_REVISION_ANNOTATION]: REVISION,
    });
  });

  it('leaves an already-annotated Deployment alone, and reads both maps', async () => {
    const current = deployment();
    const annotated = {
      ...current,
      metadata: {
        ...current.metadata,
        annotations: { [LOGS_SETTINGS_REVISION_ANNOTATION]: REVISION },
      },
    };
    annotated.spec = structuredClone(current.spec);
    (annotated.spec.template.metadata as Record<string, unknown>).annotations = {
      [LOGS_SETTINGS_REVISION_ANNOTATION]: REVISION,
    };
    const { api, calls } = stubApi({ [LOGS_STORE_DEPLOYMENT_PATH]: annotated });
    const cluster = createLogsSettingsCluster({ api });
    expect(await cluster.writeDeploymentRevision(REVISION)).toEqual({
      state: 'ok',
      value: { state: 'unchanged', generation: 4 },
    });
    expect(calls.map((call) => call.method)).toEqual(['GET']);
  });

  it('reports the rollout and the pod that proves it', async () => {
    const { api } = stubApi({
      [LOGS_STORE_DEPLOYMENT_PATH]: {
        ...deployment(),
        status: {
          ...deployment().status,
          observedGeneration: 3,
          updatedReplicas: 0,
          conditions: [
            { type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' },
          ],
        },
      },
      [LOGS_STORE_PODS_PATH]: pods({ [LOGS_SETTINGS_REVISION_ANNOTATION]: REVISION }),
    });
    const cluster = createLogsSettingsCluster({ api });
    const answer = await cluster.observeDeployment();
    expect(answer).toEqual({
      state: 'ok',
      value: {
        generation: 4,
        observedGeneration: 3,
        replicas: 1,
        updatedReplicas: 0,
        availableReplicas: 1,
        templateRevision: null,
        progressDeadlineExceeded: true,
        podRevisions: [REVISION],
        templateKeyRevision: null,
        podKeyRevisions: [null],
      },
    });
  });

  it('answers forbidden when the pod read is refused', async () => {
    const { api } = stubApi(
      { [LOGS_STORE_DEPLOYMENT_PATH]: deployment() },
      { [`GET ${LOGS_STORE_PODS_PATH}`]: 403 }
    );
    expect(await createLogsSettingsCluster({ api }).observeDeployment()).toEqual({
      state: 'forbidden',
    });
  });
});

describe("the claim's capacity", () => {
  it('is the volume the bound is measured against', async () => {
    const { api, calls } = stubApi({ [LOGS_CLAIM_PATH]: claim() });
    const cluster = createLogsSettingsCluster({ api });
    expect(await cluster.volumeBytes()).toEqual({ state: 'ok', value: 3 * GIB });
    expect(calls).toEqual([{ method: 'GET', path: LOGS_CLAIM_PATH }]);
  });

  it('is unknown before the claim binds and unavailable when the read is refused', async () => {
    const missing = createLogsSettingsCluster({ api: stubApi({}).api });
    expect(await missing.volumeBytes()).toEqual({ state: 'ok', value: null });
    const refused = createLogsSettingsCluster({
      api: stubApi({}, { [`GET ${LOGS_CLAIM_PATH}`]: 403 }).api,
    });
    expect(await refused.volumeBytes()).toEqual({ state: 'forbidden' });
  });
});
const KEY = 'partition-key-value-of-32-bytes-__';
const KEY_REVISION = '1-0123456789abcdef';

const secret = () => ({
  apiVersion: 'v1',
  kind: 'Secret',
  metadata: {
    name: LOGS_PARTITION_KEY_SECRET,
    namespace: 'lifemodel-system',
    resourceVersion: '7',
    annotations: { [LOGS_PARTITION_KEY_REVISION_ANNOTATION]: KEY_REVISION },
  },
  type: 'Opaque',
  data: { [LOGS_PARTITION_KEY_FIELD]: Buffer.from(KEY, 'utf8').toString('base64') },
});

describe("the partition key's Secret", () => {
  it('reads the value the store mounts as a file and the revision beside it', async () => {
    const { api, calls } = stubApi({ [LOGS_PARTITION_KEY_SECRET_PATH]: secret() });
    const cluster = createLogsSettingsCluster({ api });
    expect(await cluster.readPartitionKey()).toEqual({
      state: 'ok',
      value: { present: true, value: KEY, revision: KEY_REVISION },
    });
    expect(calls).toEqual([{ method: 'GET', path: LOGS_PARTITION_KEY_SECRET_PATH }]);
  });

  it('calls an empty, keyless or absent value simply empty', async () => {
    for (const body of [
      { ...secret(), data: {} },
      { ...secret(), data: { [LOGS_PARTITION_KEY_FIELD]: '' } },
    ]) {
      const cluster = createLogsSettingsCluster({
        api: stubApi({ [LOGS_PARTITION_KEY_SECRET_PATH]: body }).api,
      });
      expect(await cluster.readPartitionKey()).toEqual({
        state: 'ok',
        value: { present: true, value: null, revision: KEY_REVISION },
      });
    }
    const missing = createLogsSettingsCluster({ api: stubApi({}).api });
    expect(await missing.readPartitionKey()).toEqual({
      state: 'ok',
      value: { present: false, value: null, revision: null },
    });
  });

  it('is unavailable or forbidden when it cannot be read', async () => {
    for (const [status, state] of [
      [403, 'forbidden'],
      [500, 'unavailable'],
    ] as const) {
      const cluster = createLogsSettingsCluster({
        api: stubApi({}, { [`GET ${LOGS_PARTITION_KEY_SECRET_PATH}`]: status }).api,
      });
      expect(await cluster.readPartitionKey()).toEqual({ state });
    }
  });

  it('patches the value and the revision in one merge patch', async () => {
    const { api, calls } = stubApi({ [LOGS_PARTITION_KEY_SECRET_PATH]: secret() });
    const cluster = createLogsSettingsCluster({ api });
    expect(await cluster.writePartitionKey(KEY, KEY_REVISION)).toEqual({
      state: 'ok',
      value: 'written',
    });
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ['PATCH', LOGS_PARTITION_KEY_SECRET_PATH],
    ]);
    expect(JSON.parse(calls[0]!.body ?? '{}')).toEqual({
      data: { [LOGS_PARTITION_KEY_FIELD]: Buffer.from(KEY, 'utf8').toString('base64') },
      metadata: { annotations: { [LOGS_PARTITION_KEY_REVISION_ANNOTATION]: KEY_REVISION } },
    });
  });

  it('writes only the revision when the key is already there', async () => {
    const { api, calls } = stubApi({ [LOGS_PARTITION_KEY_SECRET_PATH]: secret() });
    const cluster = createLogsSettingsCluster({ api });
    expect(await cluster.writePartitionKey(null, '2-new')).toEqual({
      state: 'ok',
      value: 'written',
    });
    expect(JSON.parse(calls[0]!.body ?? '{}')).toEqual({
      metadata: { annotations: { [LOGS_PARTITION_KEY_REVISION_ANNOTATION]: '2-new' } },
    });
  });

  it('turns a refused patch into forbidden and an answerless one into unavailable', async () => {
    for (const [status, state] of [
      [403, 'forbidden'],
      [500, 'unavailable'],
    ] as const) {
      const cluster = createLogsSettingsCluster({
        api: stubApi({}, { [`PATCH ${LOGS_PARTITION_KEY_SECRET_PATH}`]: status }).api,
      });
      expect(await cluster.writePartitionKey(KEY, KEY_REVISION)).toEqual({ state });
    }
  });
});

describe("the partition key's revision on the store Deployment", () => {
  it('patches the two annotation maps and nothing else', async () => {
    const current = deployment();
    const { api, calls } = stubApi({
      [LOGS_STORE_DEPLOYMENT_PATH]: {
        ...current,
        metadata: { ...current.metadata, generation: 8 },
      },
    });
    const cluster = createLogsSettingsCluster({ api });
    expect(await cluster.writeDeploymentKeyRevision(KEY_REVISION)).toEqual({
      state: 'ok',
      value: { state: 'patched', generation: 8 },
    });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PATCH']);
    const patch = JSON.parse(calls[1]!.body ?? '{}') as Record<string, any>;
    expect(Object.keys(patch).sort()).toEqual(['metadata', 'spec']);
    expect(patch.metadata).toEqual({
      annotations: { [LOGS_PARTITION_KEY_REVISION_ANNOTATION]: KEY_REVISION },
    });
    expect(patch.spec).toEqual({
      template: {
        metadata: { annotations: { [LOGS_PARTITION_KEY_REVISION_ANNOTATION]: KEY_REVISION } },
      },
    });
  });

  it('leaves a Deployment that already carries it alone, and reads it back with the pods', async () => {
    const current = deployment();
    const annotated = {
      ...current,
      metadata: {
        ...current.metadata,
        annotations: { [LOGS_PARTITION_KEY_REVISION_ANNOTATION]: KEY_REVISION },
      },
    };
    annotated.spec = structuredClone(current.spec);
    (annotated.spec.template.metadata as Record<string, unknown>).annotations = {
      [LOGS_PARTITION_KEY_REVISION_ANNOTATION]: KEY_REVISION,
    };
    const { api, calls } = stubApi({
      [LOGS_STORE_DEPLOYMENT_PATH]: annotated,
      [LOGS_STORE_PODS_PATH]: pods({
        [LOGS_SETTINGS_REVISION_ANNOTATION]: REVISION,
        [LOGS_PARTITION_KEY_REVISION_ANNOTATION]: KEY_REVISION,
      }),
    });
    const cluster = createLogsSettingsCluster({ api });
    expect(await cluster.writeDeploymentKeyRevision(KEY_REVISION)).toEqual({
      state: 'ok',
      value: { state: 'unchanged', generation: 4 },
    });
    expect(calls.map((call) => call.method)).toEqual(['GET']);
    const observation = await cluster.observeDeployment();
    if (observation.state !== 'ok') throw new Error('the Deployment is readable');
    expect(observation.value.templateKeyRevision).toBe(KEY_REVISION);
    expect(observation.value.podKeyRevisions).toEqual([KEY_REVISION]);
  });

  it('answers forbidden when the patch is refused', async () => {
    const cluster = createLogsSettingsCluster({
      api: stubApi(
        { [LOGS_STORE_DEPLOYMENT_PATH]: deployment() },
        {
          [`PATCH ${LOGS_STORE_DEPLOYMENT_PATH}`]: 403,
        }
      ).api,
    });
    expect(await cluster.writeDeploymentKeyRevision(KEY_REVISION)).toEqual({ state: 'forbidden' });
  });
});
