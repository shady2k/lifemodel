/** Kubernetes Jobs adapter. It has no registry, allocation or launch authority. */
import { createHash } from 'node:crypto';
import type {
  TaskExecutor,
  TaskLaunch,
  TaskJobObservation,
  TaskSoftStopIntent,
} from './task-executor.js';
import { TaskExecutorError } from './task-executor.js';
import { createTaskKubernetesClient } from './task-kubernetes-client.js';
import type {
  TaskKubernetesClient,
  TaskKubernetesClientOptions,
} from './task-kubernetes-client.js';

export const TASK_LAUNCH_LABEL = 'lifemodel.dev/launch-id';
export const TASK_TEMPLATE_HASH = 'lifemodel.dev/template-hash';
const IMAGE_REPOSITORY = 'ghcr.io/shady2k/lifemodel-workbench';
const MAX_LIST_PAGES = 100;
const MAX_LIST_CONTINUATION_BYTES = 4096;
const LIST_TIMEOUT_MS = 30_000;
type JsonObject = Record<string, unknown>;
export interface TaskKubernetesJob {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    deletionTimestamp?: string;
    [key: string]: unknown;
  };
  spec: JsonObject;
  status?: {
    startTime?: string;
    active?: number;
    succeeded?: number;
    failed?: number;
    conditions?: readonly { type: string; status: string }[];
  };
}
export interface TaskObservedJob {
  readonly name: string;
  readonly uid: string;
  readonly resourceVersion: string;
  readonly launchLabel: string;
  readonly templateHash: string;
  readonly job: TaskKubernetesJob;
}
export interface KubernetesTaskExecutorOptions extends TaskKubernetesClientOptions {
  readonly origin?: string;
  readonly requestTimeoutMs?: number;
  readonly namespace?: string;
  readonly storageEndpoint?: string;
  readonly channelEndpoint?: string;
  readonly modelEndpoint?: string;
  readonly workVolumeBytes?: number;
  readonly client?: TaskKubernetesClient;
}

/** launch_ plus 64 hex is too long for a Kubernetes label. Use the name's 58 hex suffix. */
export function launchLabel(launchId: string): string {
  if (!/^launch_[0-9a-f]{64}$/.test(launchId)) throw new TaskExecutorError('invalid_launch');
  return launchId.slice(7, 65);
}
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TaskExecutorError('template_mismatch');
  return value as JsonObject;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function endpoint(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error();
    return value;
  } catch {
    throw new TaskExecutorError('invalid_launch');
  }
}
function checkLaunch(launch: TaskLaunch): void {
  const { task } = launch;
  const label = launchLabel(task.launchId);
  const deadline = Math.floor(task.profile.timeoutSeconds + task.wrapGraceSeconds);
  if (
    task.jobName !== `task-${label}` ||
    !launch.spaceId ||
    launch.spaceId.length > 256 ||
    !/^sha256:[0-9a-f]{64}$/.test(task.imageRevision) ||
    launch.workbenchImage !== `${IMAGE_REPOSITORY}@${task.imageRevision}` ||
    !Number.isSafeInteger(task.profile.timeoutSeconds) ||
    task.profile.timeoutSeconds <= 0 ||
    !Number.isFinite(task.wrapGraceSeconds) ||
    task.wrapGraceSeconds < 30 ||
    task.wrapGraceSeconds > 3600 ||
    !Number.isSafeInteger(deadline) ||
    deadline > 86400 ||
    !Number.isSafeInteger(task.profile.cpuMillis) ||
    task.profile.cpuMillis <= 0 ||
    !Number.isSafeInteger(task.profile.memoryBytes) ||
    task.profile.memoryBytes <= 0
  )
    throw new TaskExecutorError('invalid_launch');
}

export function renderTaskJob(
  launch: TaskLaunch,
  options: KubernetesTaskExecutorOptions = {}
): TaskKubernetesJob {
  checkLaunch(launch);
  const namespace = options.namespace ?? 'lifemodel-motor';
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace) || namespace.length > 63)
    throw new TaskExecutorError('invalid_launch');
  const workBytes = options.workVolumeBytes ?? 10 * 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(workBytes) || workBytes <= 0)
    throw new TaskExecutorError('invalid_launch');
  const labels = {
    'app.kubernetes.io/name': 'task',
    [TASK_LAUNCH_LABEL]: launchLabel(launch.task.launchId),
  };
  const caFile = '/var/run/lifemodel/ca/ca.crt';
  const identityDirectory = '/var/run/lifemodel/identity';
  const env = [
    {
      name: 'LIFEMODEL_STORAGE_ENDPOINT',
      value: endpoint(
        options.storageEndpoint ?? 'https://storage-module.lifemodel-system.svc:8443'
      ),
    },
    { name: 'LIFEMODEL_STORAGE_SPACE', value: launch.spaceId },
    { name: 'LIFEMODEL_STORAGE_TOKEN_FILE', value: `${identityDirectory}/storage` },
    { name: 'LIFEMODEL_STORAGE_CA_FILE', value: caFile },
    {
      name: 'LIFEMODEL_TASK_CHANNEL_ENDPOINT',
      value: endpoint(options.channelEndpoint ?? 'https://core.lifemodel.svc:8447'),
    },
    { name: 'LIFEMODEL_TASK_CHANNEL_TOKEN_FILE', value: `${identityDirectory}/channel` },
    { name: 'LIFEMODEL_TASK_CHANNEL_CA_FILE', value: caFile },
    {
      name: 'LIFEMODEL_TASK_MODEL_ENDPOINT',
      value: endpoint(options.modelEndpoint ?? 'https://model-gateway.lifemodel-system.svc:8446'),
    },
    { name: 'LIFEMODEL_TASK_MODEL_TOKEN_FILE', value: `${identityDirectory}/model` },
    { name: 'LIFEMODEL_TASK_MODEL_CA_FILE', value: caFile },
  ];
  const resources = {
    cpu: `${String(launch.task.profile.cpuMillis)}m`,
    memory: String(launch.task.profile.memoryBytes),
  };
  const job: TaskKubernetesJob = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: launch.task.jobName, namespace, labels },
    spec: {
      parallelism: 1,
      completions: 1,
      backoffLimit: 0,
      podReplacementPolicy: 'Failed',
      // Whole native seconds round down: never extend the accepted absolute hard bound.
      activeDeadlineSeconds: Math.floor(
        launch.task.profile.timeoutSeconds + launch.task.wrapGraceSeconds
      ),
      podFailurePolicy: {
        rules: [
          { action: 'FailJob', onPodConditions: [{ type: 'DisruptionTarget', status: 'True' }] },
          { action: 'FailJob', onExitCodes: { operator: 'NotIn', values: [0] } },
        ],
      },
      template: {
        metadata: { labels },
        spec: {
          serviceAccountName: 'task',
          automountServiceAccountToken: false,
          restartPolicy: 'Never',
          terminationGracePeriodSeconds: 0,
          enableServiceLinks: false,
          dnsPolicy: 'ClusterFirst',
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'task',
              image: launch.workbenchImage,
              imagePullPolicy: 'IfNotPresent',
              env,
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              resources: { requests: { ...resources }, limits: { ...resources } },
              volumeMounts: [
                { name: 'work', mountPath: '/work' },
                { name: 'identity', mountPath: identityDirectory, readOnly: true },
                { name: 'ca', mountPath: '/var/run/lifemodel/ca', readOnly: true },
              ],
            },
          ],
          volumes: [
            {
              name: 'work',
              ephemeral: {
                volumeClaimTemplate: {
                  spec: {
                    accessModes: ['ReadWriteOnce'],
                    storageClassName: 'local-path',
                    resources: { requests: { storage: String(workBytes) } },
                  },
                },
              },
            },
            {
              name: 'identity',
              projected: {
                defaultMode: 420,
                sources: ['channel', 'model', 'storage'].map((service) => ({
                  serviceAccountToken: {
                    audience: `lifemodel-task-${service}`,
                    path: service,
                    expirationSeconds: 3600,
                  },
                })),
              },
            },
            {
              name: 'ca',
              configMap: {
                name: 'lifemodel-ca',
                defaultMode: 420,
                items: [{ key: 'ca.crt', path: 'ca.crt' }],
              },
            },
          ],
        },
      },
    },
  };
  job.metadata.annotations = { [TASK_TEMPLATE_HASH]: taskJobTemplateHash(job) };
  return job;
}

// Remove only known, semantically equal API defaults. Unknown fields remain in the
// comparison: a matching annotation is never proof of the actual controlled template.
function removeDefault(target: JsonObject, key: string, value: unknown): void {
  if (stable(target[key]) === stable(value)) Reflect.deleteProperty(target, key);
}
function quantity(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const match = /^([0-9]+(?:\.[0-9]+)?)(m|Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(value);
  if (!match) return value;
  const units: Record<string, number> = {
    m: 0.001,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    k: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4,
  };
  return Number(match[1]) * (units[match[2] ?? ''] ?? 1);
}
function normalizeResources(resources: unknown): void {
  if (!resources || typeof resources !== 'object') return;
  const r = object(resources);
  for (const kind of ['requests', 'limits']) {
    if (!r[kind]) continue;
    const fields = object(r[kind]);
    for (const key of Object.keys(fields)) fields[key] = quantity(fields[key]);
  }
}
function normalizedTemplate(job: TaskKubernetesJob): unknown {
  const spec = structuredClone(job.spec);
  delete spec['activeDeadlineSeconds'];
  delete spec['selector'];
  for (const [key, value] of Object.entries({
    suspend: false,
    manualSelector: false,
    completionMode: 'NonIndexed',
    successPolicy: undefined,
  }))
    removeDefault(spec, key, value);
  const template = object(spec['template']);
  const metadata = object(template['metadata']);
  const labels = object(metadata['labels']);
  for (const key of [
    'batch.kubernetes.io/controller-uid',
    'controller-uid',
    'batch.kubernetes.io/job-name',
    'job-name',
  ])
    Reflect.deleteProperty(labels, key);
  removeDefault(metadata, 'creationTimestamp', null);
  const pod = object(template['spec']);
  const defaults = {
    schedulerName: 'default-scheduler',
    serviceAccount: 'task',
    hostNetwork: false,
    hostPID: false,
    hostIPC: false,
    shareProcessNamespace: false,
    preemptionPolicy: 'PreemptLowerPriority',
    priority: 0,
  };
  for (const [key, value] of Object.entries(defaults)) removeDefault(pod, key, value);
  for (const c of pod['containers'] as unknown[]) {
    const container = object(c);
    removeDefault(container, 'terminationMessagePath', '/dev/termination-log');
    removeDefault(container, 'terminationMessagePolicy', 'File');
    normalizeResources(container['resources']);
  }
  for (const v of pod['volumes'] as unknown[]) {
    const volume = object(v);
    if (volume['ephemeral']) {
      const claim = object(object(volume['ephemeral'])['volumeClaimTemplate']);
      if (claim['metadata']) {
        const m = object(claim['metadata']);
        removeDefault(m, 'creationTimestamp', null);
        if (!Object.keys(m).length) delete claim['metadata'];
      }
      const claimSpec = object(claim['spec']);
      removeDefault(claimSpec, 'volumeMode', 'Filesystem');
      normalizeResources(claimSpec['resources']);
    }
  }
  return spec;
}
export function taskJobTemplateHash(job: TaskKubernetesJob): string {
  try {
    return createHash('sha256')
      .update(stable(normalizedTemplate(job)))
      .digest('hex');
  } catch {
    throw new TaskExecutorError('template_mismatch');
  }
}

function validateJob(
  job: TaskKubernetesJob,
  launch: TaskLaunch,
  options: KubernetesTaskExecutorOptions
): TaskJobObservation {
  const expected = renderTaskJob(launch, options);
  if (job.apiVersion !== 'batch/v1' || job.kind !== 'Job')
    throw new TaskExecutorError('template_mismatch');
  if (
    job.metadata.name !== launch.task.jobName ||
    job.metadata.namespace !== expected.metadata.namespace ||
    !job.metadata.uid ||
    !job.metadata.resourceVersion ||
    (launch.task.jobUid !== null && job.metadata.uid !== launch.task.jobUid) ||
    job.metadata.labels?.[TASK_LAUNCH_LABEL] !== launchLabel(launch.task.launchId) ||
    job.metadata.labels?.['app.kubernetes.io/name'] !== 'task'
  )
    throw new TaskExecutorError('identity_mismatch');
  const template = object(job.spec['template']);
  const labels = object(object(template['metadata'])['labels']);
  if (
    labels[TASK_LAUNCH_LABEL] !== launchLabel(launch.task.launchId) ||
    labels['app.kubernetes.io/name'] !== 'task'
  )
    throw new TaskExecutorError('identity_mismatch');
  for (const key of ['batch.kubernetes.io/controller-uid', 'controller-uid'])
    if (labels[key] !== undefined && labels[key] !== job.metadata.uid)
      throw new TaskExecutorError('identity_mismatch');
  for (const key of ['batch.kubernetes.io/job-name', 'job-name'])
    if (labels[key] !== undefined && labels[key] !== job.metadata.name)
      throw new TaskExecutorError('identity_mismatch');
  if (job.spec['selector'] !== undefined) {
    const selector = object(job.spec['selector']);
    const match = object(selector['matchLabels']);
    if (
      Object.keys(selector).some((k) => k !== 'matchLabels') ||
      !Object.keys(match).length ||
      Object.entries(match).some(
        ([k, v]) =>
          !['batch.kubernetes.io/controller-uid', 'controller-uid'].includes(k) ||
          v !== job.metadata.uid
      )
    )
      throw new TaskExecutorError('template_mismatch');
  }
  const hash = expected.metadata.annotations?.[TASK_TEMPLATE_HASH];
  const ads = job.spec['activeDeadlineSeconds'];
  if (
    (launch.task.templateHash !== null && launch.task.templateHash !== hash) ||
    job.metadata.annotations?.[TASK_TEMPLATE_HASH] !== hash ||
    taskJobTemplateHash(job) !== hash ||
    typeof ads !== 'number' ||
    !Number.isSafeInteger(ads) ||
    ads <= 0 ||
    ads > (expected.spec['activeDeadlineSeconds'] as number)
  )
    throw new TaskExecutorError('template_mismatch');
  let startedAt: Date | null = null;
  if (job.status?.startTime !== undefined) {
    startedAt = new Date(job.status.startTime);
    if (!Number.isFinite(startedAt.getTime())) throw new TaskExecutorError('api_error');
  }
  const conditions = job.status?.conditions ?? [];
  const phase = job.metadata.deletionTimestamp
    ? 'deleting'
    : conditions.some((c) => c.type === 'Failed' && c.status === 'True')
      ? 'failed'
      : conditions.some((c) => c.type === 'Complete' && c.status === 'True')
        ? 'succeeded'
        : startedAt
          ? 'running'
          : 'pending';
  return {
    taskId: launch.task.id,
    launchId: launch.task.launchId,
    jobName: job.metadata.name,
    jobUid: job.metadata.uid,
    resourceVersion: job.metadata.resourceVersion,
    templateHash: hash,
    startedAt,
    phase,
  };
}

export function validateTaskJob(
  job: TaskKubernetesJob,
  launch: TaskLaunch,
  options: KubernetesTaskExecutorOptions = {}
): TaskJobObservation {
  try {
    return validateJob(job, launch, options);
  } catch (error) {
    if (error instanceof TaskExecutorError) throw error;
    throw new TaskExecutorError('template_mismatch');
  }
}

export class KubernetesTaskExecutor implements TaskExecutor {
  private readonly client: TaskKubernetesClient;
  private readonly collection: string;
  private watchResourceVersion = '0';
  constructor(private readonly options: KubernetesTaskExecutorOptions = {}) {
    const namespace = options.namespace ?? 'lifemodel-motor';
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace) || namespace.length > 63)
      throw new TaskExecutorError('invalid_launch');
    this.collection = `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs`;
    this.client =
      options.client ??
      createTaskKubernetesClient({
        ...options,
        ...(options.origin ? { apiServer: options.origin } : {}),
        ...(options.requestTimeoutMs ? { timeoutMs: options.requestTimeoutMs } : {}),
      });
  }
  close(): void {
    this.client.close();
  }
  private async send(method: string, path: string, body?: unknown, signal?: AbortSignal) {
    if (signal?.aborted) throw new TaskExecutorError('aborted');
    try {
      return await this.client.request(method, path, body, signal);
    } catch (error) {
      if (error instanceof TaskExecutorError) throw error;
      throw new TaskExecutorError(signal?.aborted ? 'aborted' : 'transport_error');
    }
  }
  async observe(launch: TaskLaunch, signal?: AbortSignal): Promise<TaskJobObservation | null> {
    checkLaunch(launch);
    const result = await this.send(
      'GET',
      `${this.collection}/${launch.task.jobName}`,
      undefined,
      signal
    );
    if (result.status === 404) return null;
    if (result.status !== 200) throw new TaskExecutorError('api_error');
    return validateTaskJob(result.body as TaskKubernetesJob, launch, this.options);
  }
  async ensureStarted(launch: TaskLaunch, signal?: AbortSignal): Promise<TaskJobObservation> {
    if (launch.task.tombstonedAt || ['done', 'failed', 'stopped'].includes(launch.task.state))
      throw new TaskExecutorError('invalid_launch');
    const old = await this.observe(launch, signal);
    if (old) return old;
    if (launch.task.jobUid !== null) throw new TaskExecutorError('bound_job_missing');
    const job = renderTaskJob(launch, this.options);
    let result;
    try {
      result = await this.send('POST', this.collection, job, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      const adopted = await this.observe(launch, signal);
      if (adopted) return adopted;
      throw error;
    }
    if (result.status === 200 || result.status === 201)
      return validateTaskJob(result.body as TaskKubernetesJob, launch, this.options);
    if (
      result.status === 409 ||
      result.status === 408 ||
      result.status >= 500 ||
      result.status === 0
    ) {
      const adopted = await this.observe(launch, signal);
      if (adopted) return adopted;
    }
    throw new TaskExecutorError('api_error');
  }
  requestSoftStop(launch: TaskLaunch, signal?: AbortSignal): Promise<TaskSoftStopIntent> {
    return Promise.resolve().then((): TaskSoftStopIntent => {
      if (signal?.aborted) throw new TaskExecutorError('aborted');
      return { taskId: launch.task.id, launchId: launch.task.launchId, intent: 'soft-stop' };
    });
  }
  async deleteNow(launch: TaskLaunch, signal?: AbortSignal): Promise<void> {
    if (!launch.task.jobUid) throw new TaskExecutorError('identity_mismatch');
    const observed = await this.observe(launch, signal);
    if (!observed) return;
    await this.deleteIdentity(observed.jobName, observed.jobUid, observed.resourceVersion, signal);
  }
  private async deleteIdentity(
    name: string,
    uid: string,
    resourceVersion: string,
    signal?: AbortSignal
  ): Promise<void> {
    if (
      !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) ||
      name.length > 63 ||
      !uid ||
      !resourceVersion
    )
      throw new TaskExecutorError('identity_mismatch');
    const response = await this.send(
      'DELETE',
      `${this.collection}/${name}`,
      {
        apiVersion: 'v1',
        kind: 'DeleteOptions',
        gracePeriodSeconds: 0,
        propagationPolicy: 'Foreground',
        preconditions: { uid, resourceVersion },
      },
      signal
    );
    if (![200, 202, 404].includes(response.status)) throw new TaskExecutorError('api_error');
  }
  async deleteObservedJob(job: TaskKubernetesJob, signal?: AbortSignal): Promise<void> {
    const label = job.metadata.labels?.[TASK_LAUNCH_LABEL];
    if (
      job.metadata.namespace !== (this.options.namespace ?? 'lifemodel-motor') ||
      !job.metadata.uid ||
      !job.metadata.resourceVersion ||
      !label ||
      !/^[a-zA-Z0-9]([a-zA-Z0-9_.-]{0,61}[a-zA-Z0-9])?$/.test(label)
    )
      throw new TaskExecutorError('identity_mismatch');
    await this.deleteIdentity(
      job.metadata.name,
      job.metadata.uid,
      job.metadata.resourceVersion,
      signal
    );
  }
  async deleteJob(observed: TaskObservedJob, signal?: AbortSignal): Promise<void> {
    // List observations carry captured identity scalars. Never reread mutable raw Job identity.
    if (
      !observed.launchLabel ||
      !/^[a-zA-Z0-9]([a-zA-Z0-9_.-]{0,61}[a-zA-Z0-9])?$/.test(observed.launchLabel)
    )
      throw new TaskExecutorError('identity_mismatch');
    await this.deleteIdentity(observed.name, observed.uid, observed.resourceVersion, signal);
  }
  /** Watch notifications only wake the durable reconciler; they are not task authority. */
  async waitForChange(signal?: AbortSignal): Promise<void> {
    const params = new URLSearchParams({
      watch: '1',
      timeoutSeconds: '30',
      resourceVersion: this.watchResourceVersion,
      labelSelector: TASK_LAUNCH_LABEL,
    });
    const response = await this.send('WATCH', `${this.collection}?${params}`, undefined, signal);
    if (response.status === 410) {
      this.watchResourceVersion = '0';
      return;
    }
    if (response.status !== 200) throw new TaskExecutorError('api_error');
  }
  async listJobs(signal?: AbortSignal): Promise<TaskObservedJob[]> {
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const deadline = performance.now() + LIST_TIMEOUT_MS;
    // One deadline covers all pages, including empty filtered pages. Per-request
    // transport timeouts alone would restart the budget on every continuation.
    const timer = setTimeout(() => {
      controller.abort();
    }, LIST_TIMEOUT_MS);
    timer.unref();
    try {
      return await this.listJobsWithinDeadline(combined, deadline);
    } finally {
      clearTimeout(timer);
    }
  }
  private async listJobsWithinDeadline(
    signal: AbortSignal,
    deadline: number
  ): Promise<TaskObservedJob[]> {
    const jobs: TaskObservedJob[] = [];
    const seen = new Set<string>();
    let continuation = '';
    let listResourceVersion: string | undefined;
    let pages = 0;
    do {
      if (signal.aborted || performance.now() >= deadline) throw new TaskExecutorError('aborted');
      if (pages++ >= MAX_LIST_PAGES) throw new TaskExecutorError('api_error');
      const params = new URLSearchParams({ labelSelector: TASK_LAUNCH_LABEL, limit: '100' });
      if (continuation) params.set('continue', continuation);
      const response = await this.send('GET', `${this.collection}?${params}`, undefined, signal);
      if (signal.aborted || performance.now() >= deadline) throw new TaskExecutorError('aborted');
      if (response.status !== 200) throw new TaskExecutorError('api_error');
      const body = object(response.body);
      const metadata = body['metadata'] === undefined ? {} : object(body['metadata']);
      const version = metadata['resourceVersion'];
      if (
        version !== undefined &&
        (typeof version !== 'string' || !version || version.length > 1024)
      )
        throw new TaskExecutorError('api_error');
      if (listResourceVersion !== undefined && version !== listResourceVersion)
        throw new TaskExecutorError('api_error');
      listResourceVersion = version;
      if (!Array.isArray(body['items'])) throw new TaskExecutorError('api_error');
      for (const value of body['items']) {
        const job = value as TaskKubernetesJob;
        if (
          !job ||
          typeof job !== 'object' ||
          !job.metadata?.uid ||
          !job.metadata.resourceVersion ||
          !job.metadata.name
        )
          throw new TaskExecutorError('api_error');
        const label = job.metadata.labels?.[TASK_LAUNCH_LABEL];
        if (
          job.metadata.namespace !== (this.options.namespace ?? 'lifemodel-motor') ||
          !label ||
          !/^[a-zA-Z0-9]([a-zA-Z0-9_.-]{0,61}[a-zA-Z0-9])?$/.test(label)
        )
          throw new TaskExecutorError('identity_mismatch');
        jobs.push(
          Object.freeze({
            name: job.metadata.name,
            uid: job.metadata.uid,
            resourceVersion: job.metadata.resourceVersion,
            launchLabel: job.metadata.labels?.[TASK_LAUNCH_LABEL] ?? '',
            templateHash: job.metadata.annotations?.[TASK_TEMPLATE_HASH] ?? '',
            job,
          })
        );
      }
      if (jobs.length > 10_000) throw new TaskExecutorError('api_error');
      const next =
        body['metadata'] === undefined ? undefined : object(body['metadata'])['continue'];
      if (
        next !== undefined &&
        (typeof next !== 'string' || Buffer.byteLength(next) > MAX_LIST_CONTINUATION_BYTES)
      )
        throw new TaskExecutorError('api_error');
      continuation = next ?? '';
      if (continuation && seen.has(continuation)) throw new TaskExecutorError('api_error');
      if (continuation) seen.add(continuation);
    } while (continuation);
    this.watchResourceVersion = listResourceVersion ?? '0';
    return jobs;
  }
}
export function createKubernetesTaskExecutor(
  options: KubernetesTaskExecutorOptions = {}
): KubernetesTaskExecutor {
  return new KubernetesTaskExecutor(options);
}
