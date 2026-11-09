/**
 * The three cluster objects the retention setting touches (ADR-016 §5, N6):
 * the store's settings ConfigMap, the store's Deployment and the pod it
 * replaces, and the claim whose capacity the page measures a byte bound
 * against.
 *
 * Every object is named here and reached through the loader's one narrow
 * Kubernetes client: one ConfigMap (`get`, `update`, `create`), one Deployment
 * (`get`, `patch` of its two annotation maps) and a labelled read of its pods.
 * A refused verb is `forbidden`, and anything else that does not answer is
 * `unavailable`; neither is ever a silent success.
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

const NAMESPACE = 'lifemodel-system';
export const LOGS_SETTINGS_CONFIGMAP_PATH = `/api/v1/namespaces/${NAMESPACE}/configmaps/${LOGS_SETTINGS_CONFIGMAP}`;
export const LOGS_SETTINGS_CONFIGMAP_COLLECTION = `/api/v1/namespaces/${NAMESPACE}/configmaps`;
export const LOGS_STORE_DEPLOYMENT_PATH = `/apis/apps/v1/namespaces/${NAMESPACE}/deployments/${LOGS_STORE_DEPLOYMENT}`;
/** The store's pods, by the label its Deployment selects on: one Recreate pod. */
export const LOGS_STORE_PODS_PATH = `/api/v1/namespaces/${NAMESPACE}/pods?labelSelector=app.kubernetes.io%2Fname%3Dlogs-store`;
export const LOGS_CLAIM_PATH = `/api/v1/namespaces/${LOGS_CLAIM_NAMESPACE}/persistentvolumeclaims/${LOGS_CLAIM_NAME}`;

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
  podRevisions: readonly (string | null)[]
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
    progressDeadlineExceeded: conditions.some(
      (condition) =>
        condition.type === 'Progressing' &&
        condition.status === 'False' &&
        condition.reason === 'ProgressDeadlineExceeded'
    ),
    podRevisions,
  };
}

function parsePods(body: ObjectBody): (string | null)[] {
  return (body.items ?? []).map(
    (item) => item.metadata?.annotations?.[LOGS_SETTINGS_REVISION_ANNOTATION] ?? null
  );
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

    async observeDeployment() {
      const deployment = await read(LOGS_STORE_DEPLOYMENT_PATH);
      if (deployment.state !== 'ok') return deployment;
      if (deployment.value === 'missing') return { state: 'unavailable' };
      const pods = await read(LOGS_STORE_PODS_PATH);
      if (pods.state !== 'ok') return pods;
      const revisions = pods.value === 'missing' ? [] : parsePods(pods.value);
      return { state: 'ok', value: parseDeployment(deployment.value, revisions) };
    },
  };
}
