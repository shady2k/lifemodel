/**
 * The three cluster objects the retention setting touches (ADR-016 §5, N6):
 * the store's settings ConfigMap, the store's Deployment and the pod it
 * replaces, and the claim whose capacity the page measures a byte bound
 * against.
 *
 * Every object is named here and reached through the loader's one narrow
 * Kubernetes client: one ConfigMap (`get`, `update`, `create`), the partition
 * key's Secret (`get`, `patch`), one Deployment (`get`, `patch` of its two
 * annotation maps) and a labelled read of its pods. A refused verb is
 * `forbidden`, and anything else that does not answer is `unavailable`; neither
 * is ever a silent success.
 */
import {
  createKubernetesObjectApi,
  type KubernetesObjectApi,
  type KubernetesObjectApiOptions,
} from './logs-volume-claim.js';
import { LOGS_CLAIM_NAME, LOGS_CLAIM_NAMESPACE } from './logs-volume-claim.js';
import { parseKubernetesQuantity, type LogsStoreFlags } from './logs-retention.js';

export const LOGS_SETTINGS_CONFIGMAP = 'lifemodel-logs-settings';
export const LOGS_STORE_DEPLOYMENT = 'logs-store';
/** The annotation the loader writes on both maps so the pod can be told from its predecessor. */
export const LOGS_SETTINGS_REVISION_ANNOTATION = 'lifemodel.dev/logs-settings-revision';
/** The partition key's Secret: the store's file and the evictor's `secretKeyRef` (ADR-016 §5). */
export const LOGS_PARTITION_KEY_SECRET = 'lifemodel-logs-partition-key';
export const LOGS_PARTITION_KEY_FIELD = 'partition-key';
/**
 * The annotation that proves a store pod started after the key was written. It
 * is a second, independent annotation: the revision the retention predicate
 * reads stays the settings one, never this value and never the key.
 */
export const LOGS_PARTITION_KEY_REVISION_ANNOTATION = 'lifemodel.dev/logs-partition-key-revision';

const NAMESPACE = 'lifemodel-system';
export const LOGS_SETTINGS_CONFIGMAP_PATH = `/api/v1/namespaces/${NAMESPACE}/configmaps/${LOGS_SETTINGS_CONFIGMAP}`;
export const LOGS_SETTINGS_CONFIGMAP_COLLECTION = `/api/v1/namespaces/${NAMESPACE}/configmaps`;
export const LOGS_STORE_DEPLOYMENT_PATH = `/apis/apps/v1/namespaces/${NAMESPACE}/deployments/${LOGS_STORE_DEPLOYMENT}`;
/** The store's pods, by the label its Deployment selects on: one Recreate pod. */
export const LOGS_STORE_PODS_PATH = `/api/v1/namespaces/${NAMESPACE}/pods?labelSelector=app.kubernetes.io%2Fname%3Dlogs-store`;
export const LOGS_CLAIM_PATH = `/api/v1/namespaces/${LOGS_CLAIM_NAMESPACE}/persistentvolumeclaims/${LOGS_CLAIM_NAME}`;
export const LOGS_PARTITION_KEY_SECRET_PATH = `/api/v1/namespaces/${NAMESPACE}/secrets/${LOGS_PARTITION_KEY_SECRET}`;

/** An answer that could not be read: the API refused the verb, or did not answer. */
export type LogsClusterAnswer<T> =
  | { readonly state: 'ok'; readonly value: T }
  | { readonly state: 'forbidden' }
  | { readonly state: 'unavailable' };

/** What the Deployment says about its own rollout and the pod it replaced. */
export interface LogsStoreDeployment {
  readonly generation: number;
  readonly observedGeneration: number | null;
  readonly replicas: number;
  readonly updatedReplicas: number;
  readonly availableReplicas: number;
  /** The pod template's revision annotation, or null when it carries none. */
  readonly templateRevision: string | null;
  readonly progressDeadlineExceeded: boolean;
  /** Each pod's revision annotation, newest first; empty when none is listed. */
  readonly podRevisions: readonly (string | null)[];
  /** The pod template's partition key revision, or null before the key was ever written. */
  readonly templateKeyRevision: string | null;
  /** Each pod's partition key revision, newest first; empty when none is listed. */
  readonly podKeyRevisions: readonly (string | null)[];
}

/** The partition key's value as the store reads it, and the revision written beside it. */
export interface LogsPartitionKey {
  /** Whether the Secret exists at all: the store's step creates it. */
  readonly present: boolean;
  /** The key, or null while the Secret holds no value. */
  readonly value: string | null;
  /** The revision that proves a restart after this key, or null when none was written. */
  readonly revision: string | null;
}

export interface LogsSettingsCluster {
  /** The claim's capacity, or null when it does not exist or is not bound yet. */
  volumeBytes(): Promise<LogsClusterAnswer<number | null>>;
  /** The store's ConfigMap holds exactly these flags under this revision. */
  writeConfigMap(
    flags: LogsStoreFlags,
    revision: string
  ): Promise<LogsClusterAnswer<'unchanged' | 'written'>>;
  /** The Deployment's two annotation maps carry this revision. */
  writeDeploymentRevision(
    revision: string
  ): Promise<LogsClusterAnswer<{ state: 'unchanged' | 'patched'; generation: number }>>;
  /** The partition key's value and revision, as the Secret holds them. */
  readPartitionKey(): Promise<LogsClusterAnswer<LogsPartitionKey>>;
  /** Writes the key (or only the revision, when the value is null) in one patch. */
  writePartitionKey(value: string | null, revision: string): Promise<LogsClusterAnswer<'written'>>;
  /** The Deployment's two annotation maps carry this partition key revision. */
  writeDeploymentKeyRevision(
    revision: string
  ): Promise<LogsClusterAnswer<{ state: 'unchanged' | 'patched'; generation: number }>>;
  observeDeployment(): Promise<LogsClusterAnswer<LogsStoreDeployment>>;
}

export interface LogsSettingsClusterOptions extends KubernetesObjectApiOptions {
  api?: KubernetesObjectApi;
}

interface Metadata {
  resourceVersion?: string;
  generation?: number;
  uid?: string;
  annotations?: Record<string, string>;
}
interface Condition {
  type?: string;
  status?: string;
  reason?: string;
}
interface ObjectBody {
  metadata?: Metadata;
  spec?: {
    replicas?: number;
    template?: { metadata?: { annotations?: Record<string, string> } };
    resources?: { requests?: { storage?: string } };
  };
  status?: {
    observedGeneration?: number;
    replicas?: number;
    updatedReplicas?: number;
    availableReplicas?: number;
    conditions?: Condition[];
    capacity?: { storage?: string };
  };
  data?: Record<string, string>;
  items?: { metadata?: Metadata }[];
}

function failureOf(status: number): { state: 'forbidden' } | { state: 'unavailable' } {
  return status === 403 ? { state: 'forbidden' } : { state: 'unavailable' };
}

function parseBody(response: { status: number; body: string }): ObjectBody | null {
  try {
    const value: unknown = JSON.parse(response.body);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as ObjectBody;
  } catch {
    return null;
  }
}

/**
 * The three ConfigMap keys the store reads through `-envflag.enable
 * -envflag.prefix=VL_` (ADR-016 §5, F3). The env mapping is the one measured
 * working configuration; the flag names it becomes live beside it in
 * `logs-retention.ts`.
 */
export function configMapLogData(flags: LogsStoreFlags): Record<string, string> {
  return {
    VL_retentionPeriod: flags.retentionPeriod,
    VL_retention_maxDiskSpaceUsageBytes: flags.retentionMaxDiskSpaceUsageBytes,
    VL_storage_minFreeDiskSpaceBytes: flags.storageMinFreeDiskSpaceBytes,
  };
}

function configMapBody(flags: LogsStoreFlags, revision: string, resourceVersion?: string) {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: LOGS_SETTINGS_CONFIGMAP,
      namespace: NAMESPACE,
      annotations: {
        // Flux must not own this object: a reconcile would revert the owner's
        // setting to the artifact's, which carries only the defaults.
        'kustomize.toolkit.fluxcd.io/prune': 'disabled',
        [LOGS_SETTINGS_REVISION_ANNOTATION]: revision,
      },
      ...(resourceVersion === undefined ? {} : { resourceVersion }),
    },
    data: configMapLogData(flags),
  };
}

function sameFlags(data: Record<string, string> | undefined, flags: LogsStoreFlags): boolean {
  if (data === undefined) return false;
  const expected = configMapLogData(flags);
  const keys = Object.keys(expected);
  if (Object.keys(data).length !== keys.length) return false;
  return keys.every((key) => data[key] === expected[key]);
}

function parseDeployment(
  body: ObjectBody,
  podRevisions: readonly (string | null)[],
  podKeyRevisions: readonly (string | null)[]
): LogsStoreDeployment {
  const status = body.status ?? {};
  const conditions = status.conditions ?? [];
  return {
    generation: body.metadata?.generation ?? 0,
    observedGeneration: status.observedGeneration ?? null,
    replicas: body.spec?.replicas ?? 1,
    updatedReplicas: status.updatedReplicas ?? 0,
    availableReplicas: status.availableReplicas ?? 0,
    templateRevision:
      body.spec?.template?.metadata?.annotations?.[LOGS_SETTINGS_REVISION_ANNOTATION] ?? null,
    templateKeyRevision:
      body.spec?.template?.metadata?.annotations?.[LOGS_PARTITION_KEY_REVISION_ANNOTATION] ?? null,
    progressDeadlineExceeded: conditions.some(
      (condition) =>
        condition.type === 'Progressing' &&
        condition.status === 'False' &&
        condition.reason === 'ProgressDeadlineExceeded'
    ),
    podRevisions,
    podKeyRevisions,
  };
}

function parsePods(body: ObjectBody): {
  revisions: (string | null)[];
  keyRevisions: (string | null)[];
} {
  return {
    revisions: (body.items ?? []).map(
      (item) => item.metadata?.annotations?.[LOGS_SETTINGS_REVISION_ANNOTATION] ?? null
    ),
    keyRevisions: (body.items ?? []).map(
      (item) => item.metadata?.annotations?.[LOGS_PARTITION_KEY_REVISION_ANNOTATION] ?? null
    ),
  };
}

export function createLogsSettingsCluster(
  options: LogsSettingsClusterOptions = {}
): LogsSettingsCluster {
  const api = options.api ?? createKubernetesObjectApi(options);

  async function read(path: string): Promise<LogsClusterAnswer<ObjectBody | 'missing'>> {
    const response = await api.get(path);
    if (response.status === 404) return { state: 'ok', value: 'missing' };
    if (response.status !== 200) return failureOf(response.status);
    const body = parseBody(response);
    return body === null ? { state: 'unavailable' } : { state: 'ok', value: body };
  }

  return {
    async volumeBytes() {
      const claim = await read(LOGS_CLAIM_PATH);
      if (claim.state !== 'ok') return claim;
      if (claim.value === 'missing') return { state: 'ok', value: null };
      const reported =
        claim.value.status?.capacity?.storage ?? claim.value.spec?.resources?.requests?.storage;
      const bytes = reported === undefined ? null : parseKubernetesQuantity(reported);
      return { state: 'ok', value: bytes };
    },

    async writeConfigMap(flags, revision) {
      const current = await read(LOGS_SETTINGS_CONFIGMAP_PATH);
      if (current.state !== 'ok') return current;
      if (current.value !== 'missing') {
        const annotations = current.value.metadata?.annotations ?? {};
        if (
          sameFlags(current.value.data, flags) &&
          annotations[LOGS_SETTINGS_REVISION_ANNOTATION] === revision
        )
          return { state: 'ok', value: 'unchanged' };
        const resourceVersion = current.value.metadata?.resourceVersion;
        if (resourceVersion === undefined) return { state: 'unavailable' };
        const updated = await api.update(
          LOGS_SETTINGS_CONFIGMAP_PATH,
          JSON.stringify(configMapBody(flags, revision, resourceVersion))
        );
        if (updated.status !== 200) return failureOf(updated.status);
        return { state: 'ok', value: 'written' };
      }
      const created = await api.create(
        LOGS_SETTINGS_CONFIGMAP_COLLECTION,
        JSON.stringify(configMapBody(flags, revision))
      );
      if (created.status !== 201) return failureOf(created.status);
      return { state: 'ok', value: 'written' };
    },

    async writeDeploymentRevision(revision) {
      const current = await read(LOGS_STORE_DEPLOYMENT_PATH);
      if (current.state !== 'ok') return current;
      if (current.value === 'missing') return { state: 'unavailable' };
      const body = current.value;
      const generation = body.metadata?.generation ?? 0;
      const templateRevision =
        body.spec?.template?.metadata?.annotations?.[LOGS_SETTINGS_REVISION_ANNOTATION] ?? null;
      const objectRevision =
        body.metadata?.annotations?.[LOGS_SETTINGS_REVISION_ANNOTATION] ?? null;
      if (templateRevision === revision && objectRevision === revision)
        return { state: 'ok', value: { state: 'unchanged', generation } };
      // Exactly the two annotation maps and nothing else: the admission clamp
      // refuses any other field, and the template's change is what makes
      // `Recreate` replace the store's single pod.
      const answered = await api.patch(
        LOGS_STORE_DEPLOYMENT_PATH,
        JSON.stringify({
          metadata: { annotations: { [LOGS_SETTINGS_REVISION_ANNOTATION]: revision } },
          spec: {
            template: {
              metadata: { annotations: { [LOGS_SETTINGS_REVISION_ANNOTATION]: revision } },
            },
          },
        })
      );
      if (answered.status !== 200) return failureOf(answered.status);
      const patched = parseBody(answered);
      return {
        state: 'ok',
        value: { state: 'patched', generation: patched?.metadata?.generation ?? generation },
      };
    },

    async readPartitionKey() {
      const secret = await read(LOGS_PARTITION_KEY_SECRET_PATH);
      if (secret.state !== 'ok') return secret;
      if (secret.value === 'missing')
        return { state: 'ok', value: { present: false, value: null, revision: null } };
      const encoded = secret.value.data?.[LOGS_PARTITION_KEY_FIELD] ?? '';
      const value = encoded === '' ? '' : Buffer.from(encoded, 'base64').toString('utf8');
      return {
        state: 'ok',
        value: {
          present: true,
          value: value === '' ? null : value,
          revision:
            secret.value.metadata?.annotations?.[LOGS_PARTITION_KEY_REVISION_ANNOTATION] ?? null,
        },
      };
    },

    async writePartitionKey(value, revision) {
      // One merge patch for both halves: the key and the revision that proves
      // its restart are never disagreeing in the Secret, so a crash leaves
      // either nothing to do or a restart to request.
      const answered = await api.patch(
        LOGS_PARTITION_KEY_SECRET_PATH,
        JSON.stringify({
          ...(value === null
            ? {}
            : {
                data: { [LOGS_PARTITION_KEY_FIELD]: Buffer.from(value, 'utf8').toString('base64') },
              }),
          metadata: { annotations: { [LOGS_PARTITION_KEY_REVISION_ANNOTATION]: revision } },
        })
      );
      if (answered.status !== 200) return failureOf(answered.status);
      return { state: 'ok', value: 'written' };
    },

    async writeDeploymentKeyRevision(revision) {
      const current = await read(LOGS_STORE_DEPLOYMENT_PATH);
      if (current.state !== 'ok') return current;
      if (current.value === 'missing') return { state: 'unavailable' };
      const body = current.value;
      const generation = body.metadata?.generation ?? 0;
      const templateRevision =
        body.spec?.template?.metadata?.annotations?.[LOGS_PARTITION_KEY_REVISION_ANNOTATION] ??
        null;
      const objectRevision =
        body.metadata?.annotations?.[LOGS_PARTITION_KEY_REVISION_ANNOTATION] ?? null;
      if (templateRevision === revision && objectRevision === revision)
        return { state: 'ok', value: { state: 'unchanged', generation } };
      // Exactly the two annotation maps, and the settings revision they already
      // carry stays where it is: `Recreate` replaces the store's single pod.
      const answered = await api.patch(
        LOGS_STORE_DEPLOYMENT_PATH,
        JSON.stringify({
          metadata: { annotations: { [LOGS_PARTITION_KEY_REVISION_ANNOTATION]: revision } },
          spec: {
            template: {
              metadata: { annotations: { [LOGS_PARTITION_KEY_REVISION_ANNOTATION]: revision } },
            },
          },
        })
      );
      if (answered.status !== 200) return failureOf(answered.status);
      const patched = parseBody(answered);
      return {
        state: 'ok',
        value: { state: 'patched', generation: patched?.metadata?.generation ?? generation },
      };
    },

    async observeDeployment() {
      const deployment = await read(LOGS_STORE_DEPLOYMENT_PATH);
      if (deployment.state !== 'ok') return deployment;
      if (deployment.value === 'missing') return { state: 'unavailable' };
      const pods = await read(LOGS_STORE_PODS_PATH);
      if (pods.state !== 'ok') return pods;
      const found =
        pods.value === 'missing' ? { revisions: [], keyRevisions: [] } : parsePods(pods.value);
      return {
        state: 'ok',
        value: parseDeployment(deployment.value, found.revisions, found.keyRevisions),
      };
    },
  };
}
