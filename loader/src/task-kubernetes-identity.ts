/** Fresh task TokenReview and live Pod/Job proof. No caller task IDs or liveness cache. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Agent, request } from 'node:https';
import { StorageAccessError } from './storage-access-error.js';

export interface TaskKubernetesProof {
  podUid: string;
  podName: string;
  jobUid: string;
  jobName: string;
  /** The executor's 58-hex label, not the full registry launch ID. */
  launchLabel: string;
  templateHash: string;
  startedAt: string;
}
export interface TaskKubernetesIdentityOptions {
  apiServer?: string;
  tokenFile?: string;
  caFile?: string;
  timeoutMs?: number;
  /** Listener-specific projected token audience; identity checks stay identical. */
  audience?: 'lifemodel-task-model' | 'lifemodel-task-channel';
}
type JsonObject = Record<string, unknown>;
const NAMESPACE = 'lifemodel-motor';
const LAUNCH_LABEL = 'lifemodel.dev/launch-id';
const TEMPLATE_HASH = 'lifemodel.dev/template-hash';
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const UID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
function denied(): never {
  throw new StorageAccessError(403, 'identity_denied');
}
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) denied();
  return value as JsonObject;
}
function one(value: unknown): string {
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'string') denied();
  return value[0];
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

// Keep normalization in sync with src/core/kubernetes-task-executor.ts.
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
function normalizedTemplate(job: { spec: JsonObject }): unknown {
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
function taskJobTemplateHash(job: { spec: JsonObject }): string {
  try {
    return createHash('sha256')
      .update(stable(normalizedTemplate(job)))
      .digest('hex');
  } catch {
    denied();
  }
}

export function createTaskKubernetesIdentity(options: TaskKubernetesIdentityOptions = {}): {
  verify(token: string, signal?: AbortSignal): Promise<TaskKubernetesProof>;
  close(): void;
} {
  let base: URL;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const audience = options.audience ?? 'lifemodel-task-model';
  try {
    base = new URL(
      options.apiServer ??
        `https://${process.env['KUBERNETES_SERVICE_HOST'] ?? 'kubernetes.default.svc'}:${process.env['KUBERNETES_SERVICE_PORT_HTTPS'] ?? '443'}`
    );
    if (
      base.protocol !== 'https:' ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 2_147_483_647
    )
      throw new Error();
  } catch {
    throw new StorageAccessError(500, 'identity_config');
  }
  const agent = new Agent({
    keepAlive: true,
    maxSockets: 10,
    maxTotalSockets: 10,
    maxFreeSockets: 2,
  });
  // Keep these listeners through teardown, including late errors on idle sockets.
  agent.on('error', () => undefined);
  const sockets = new WeakSet<object>();
  const closing = new AbortController();
  async function call(path: string, payload: unknown, signal: AbortSignal): Promise<JsonObject> {
    signal.throwIfAborted();
    // Read the gateway's projected credentials for every API call, including GETs.
    const [token, ca] = await Promise.all([
      readFile(options.tokenFile ?? `${SA}/token`, { encoding: 'utf8', signal }),
      readFile(options.caFile ?? `${SA}/ca.crt`, { signal }),
    ]);
    signal.throwIfAborted();
    const credential = token.trim();
    if (!credential || credential.length > 16_384 || /\s/.test(credential))
      throw new StorageAccessError(503, 'identity_unavailable');
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    if (body !== undefined && Buffer.byteLength(body) > 32 * 1024)
      throw new StorageAccessError(503, 'identity_unavailable');
    return new Promise((resolve, reject) => {
      const fail = (): void => {
        reject(new StorageAccessError(503, 'identity_unavailable'));
      };
      const req = request(
        new URL(path, base),
        {
          method: body === undefined ? 'GET' : 'POST',
          ca,
          signal,
          agent,
          headers: {
            authorization: `Bearer ${credential}`,
            ...(body === undefined
              ? {}
              : {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(body),
                }),
          },
        },
        (res) => {
          res.on('error', fail);
          res.on('aborted', fail);
          res.on('close', () => {
            if (!res.complete) fail();
          });
          if (res.statusCode !== 200 && !(payload !== undefined && res.statusCode === 201)) {
            const refusal =
              res.statusCode === 401 ||
              res.statusCode === 403 ||
              (payload === undefined && res.statusCode === 404);
            reject(
              new StorageAccessError(
                refusal ? 403 : 503,
                refusal ? 'identity_denied' : 'identity_unavailable'
              )
            );
            // Never drain an unbounded error body or leave it on a reusable socket.
            res.destroy();
            req.destroy();
            return;
          }
          let size = 0;
          const parts: Buffer[] = [];
          res.on('data', (part: Buffer) => {
            size += part.length;
            if (size > 256 * 1024) {
              fail();
              res.destroy();
              req.destroy();
            } else parts.push(part);
          });
          res.on('end', () => {
            try {
              resolve(object(JSON.parse(Buffer.concat(parts).toString('utf8'))));
            } catch {
              fail();
            }
          });
        }
      );
      req.on('error', fail);
      req.on('socket', (socket) => {
        if (!sockets.has(socket)) {
          sockets.add(socket);
          socket.on('error', () => undefined);
        }
      });
      req.end(body);
    });
  }
  return {
    close: () => {
      closing.abort();
      agent.destroy();
    },
    verify: async (token, parent) => {
      const signal = AbortSignal.any([
        AbortSignal.timeout(timeoutMs),
        closing.signal,
        ...(parent ? [parent] : []),
      ]);
      try {
        signal.throwIfAborted();
        if (typeof token !== 'string' || !token || token.length > 16_384 || /\s/.test(token))
          denied();
        const review = object(
          (
            await call(
              '/apis/authentication.k8s.io/v1/tokenreviews',
              {
                apiVersion: 'authentication.k8s.io/v1',
                kind: 'TokenReview',
                spec: { token, audiences: [audience] },
              },
              signal
            )
          )['status']
        );
        if (
          review['authenticated'] !== true ||
          !Array.isArray(review['audiences']) ||
          !review['audiences'].includes(audience)
        )
          denied();
        const user = object(review['user']);
        if (
          user['username'] !== `system:serviceaccount:${NAMESPACE}:task` ||
          typeof user['uid'] !== 'string' ||
          !UID.test(user['uid'])
        )
          denied();
        const extra = object(user['extra']);
        const podName = one(extra['authentication.kubernetes.io/pod-name']);
        const podUid = one(extra['authentication.kubernetes.io/pod-uid']);
        if (!NAME.test(podName) || !UID.test(podUid)) denied();
        const pod = await call(
          `/api/v1/namespaces/${NAMESPACE}/pods/${encodeURIComponent(podName)}`,
          undefined,
          signal
        );
        const metadata = object(pod['metadata']);
        if (
          pod['apiVersion'] !== 'v1' ||
          pod['kind'] !== 'Pod' ||
          metadata['name'] !== podName ||
          metadata['namespace'] !== NAMESPACE ||
          metadata['uid'] !== podUid ||
          metadata['deletionTimestamp'] != null ||
          object(pod['spec'])['serviceAccountName'] !== 'task'
        )
          denied();
        const owners = metadata['ownerReferences'];
        if (!Array.isArray(owners)) denied();
        const controllers = owners.map(object).filter((owner) => owner['controller'] === true);
        const controller = controllers[0];
        if (
          controllers.length !== 1 ||
          controller?.['kind'] !== 'Job' ||
          controller['apiVersion'] !== 'batch/v1' ||
          typeof controller['name'] !== 'string' ||
          !NAME.test(controller['name']) ||
          typeof controller['uid'] !== 'string' ||
          !UID.test(controller['uid'])
        )
          denied();
        const jobName = controller['name'];
        const jobUid = controller['uid'];
        const job = await call(
          `/apis/batch/v1/namespaces/${NAMESPACE}/jobs/${encodeURIComponent(jobName)}`,
          undefined,
          signal
        );
        const jobMetadata = object(job['metadata']);
        if (
          job['apiVersion'] !== 'batch/v1' ||
          job['kind'] !== 'Job' ||
          jobMetadata['name'] !== jobName ||
          jobMetadata['namespace'] !== NAMESPACE ||
          jobMetadata['uid'] !== jobUid ||
          jobMetadata['deletionTimestamp'] != null
        )
          denied();
        const labels = object(jobMetadata['labels']);
        const launchLabel = labels[LAUNCH_LABEL];
        const templateHash = object(jobMetadata['annotations'])[TEMPLATE_HASH];
        if (
          typeof launchLabel !== 'string' ||
          !/^[0-9a-f]{58}$/.test(launchLabel) ||
          jobName !== `task-${launchLabel}` ||
          labels['app.kubernetes.io/name'] !== 'task' ||
          typeof templateHash !== 'string' ||
          !/^[0-9a-f]{64}$/.test(templateHash)
        )
          denied();
        const spec = object(job['spec']);
        const template = object(spec['template']);
        const templateLabels = object(object(template['metadata'])['labels']);
        if (
          templateLabels[LAUNCH_LABEL] !== launchLabel ||
          templateLabels['app.kubernetes.io/name'] !== 'task' ||
          object(template['spec'])['serviceAccountName'] !== 'task'
        )
          denied();
        // These API-generated fields are omitted by the hash only after validating identity,
        // just as the executor's adoption path does.
        for (const key of ['batch.kubernetes.io/controller-uid', 'controller-uid'])
          if (templateLabels[key] !== undefined && templateLabels[key] !== jobUid) denied();
        for (const key of ['batch.kubernetes.io/job-name', 'job-name'])
          if (templateLabels[key] !== undefined && templateLabels[key] !== jobName) denied();
        if (spec['selector'] !== undefined) {
          const selector = object(spec['selector']);
          const match = object(selector['matchLabels']);
          if (
            Object.keys(selector).some((key) => key !== 'matchLabels') ||
            !Object.keys(match).length ||
            Object.entries(match).some(
              ([key, value]) =>
                !['batch.kubernetes.io/controller-uid', 'controller-uid'].includes(key) ||
                value !== jobUid
            )
          )
            denied();
        }
        const ads = spec['activeDeadlineSeconds'];
        if (
          typeof ads !== 'number' ||
          !Number.isSafeInteger(ads) ||
          ads <= 0 ||
          ads > 86_400 ||
          taskJobTemplateHash({ spec }) !== templateHash
        )
          denied();
        const startedAt = object(job['status'])['startTime'];
        if (
          typeof startedAt !== 'string' ||
          startedAt.length > 64 ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(startedAt) ||
          !Number.isFinite(new Date(startedAt).getTime())
        )
          denied();
        signal.throwIfAborted();
        return { podUid, podName, jobUid, jobName, launchLabel, templateHash, startedAt };
      } catch (error) {
        if (parent?.aborted) throw new StorageAccessError(403, 'access_revoked');
        if (error instanceof StorageAccessError) throw error;
        throw new StorageAccessError(503, 'identity_unavailable');
      }
    },
  };
}
