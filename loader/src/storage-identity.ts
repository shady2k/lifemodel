/** Fresh Kubernetes proof, never a JWT decode or a positive liveness cache. */
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { StorageAccessError } from './storage-access-error.js';

export const STORAGE_AUDIENCES = {
  task: ['lifemodel-task-storage'],
  control: ['lifemodel-core-storage-control'],
  read: ['lifemodel-core-storage-read', 'lifemodel-web-storage-read'],
} as const;
export type StorageAudience = readonly string[];
export interface StorageIdentity {
  role: 'task' | 'core' | 'web';
  podUid: string;
  jobUid?: string;
}
export interface KubernetesStorageIdentity {
  verify(token: string, audiences: StorageAudience, signal?: AbortSignal): Promise<StorageIdentity>;
}
interface IdentityOptions {
  apiServer?: string;
  tokenFile?: string;
  caFile?: string;
  timeoutMs?: number;
}
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new StorageAccessError(403, 'identity_denied');
  return value as RecordValue;
}
function one(value: unknown): string {
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'string' || !value[0])
    throw new StorageAccessError(403, 'identity_denied');
  return value[0];
}
const NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
export function createKubernetesStorageIdentity(
  options: IdentityOptions = {}
): KubernetesStorageIdentity {
  const base = new URL(
    options.apiServer ??
      `https://${process.env['KUBERNETES_SERVICE_HOST'] ?? 'kubernetes.default.svc'}:${process.env['KUBERNETES_SERVICE_PORT_HTTPS'] ?? '443'}`
  );
  if (base.protocol !== 'https:') throw new StorageAccessError(500, 'identity_config');
  async function call(path: string, payload: unknown, signal: AbortSignal): Promise<RecordValue> {
    signal.throwIfAborted();
    // The module's own API token is reread too; there is no credential fallback.
    const [token, ca] = await Promise.all([
      readFile(options.tokenFile ?? `${SA}/token`, 'utf8'),
      readFile(options.caFile ?? `${SA}/ca.crt`),
    ]);
    if (!token.trim()) throw new StorageAccessError(503, 'identity_unavailable');
    const body = payload === undefined ? undefined : JSON.stringify(payload);
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
          agent: false,
          headers: {
            authorization: `Bearer ${token.trim()}`,
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
          },
        },
        (res) => {
          // Permanent listeners cover errors emitted separately from the promise.
          res.on('error', fail);
          res.on('aborted', fail);
          if (res.statusCode !== 200 && res.statusCode !== 201) {
            res.resume();
            reject(new StorageAccessError(403, 'identity_denied'));
            return;
          }
          let size = 0;
          const parts: Buffer[] = [];
          res.on('data', (part: Buffer) => {
            size += part.length;
            if (size > 256 * 1024) {
              req.destroy();
              fail();
            } else parts.push(part);
          });
          res.on('end', () => {
            try {
              resolve(record(JSON.parse(Buffer.concat(parts).toString('utf8'))));
            } catch {
              fail();
            }
          });
        }
      );
      req.on('socket', (socket) => {
        socket.on('error', () => undefined);
      });
      req.on('error', fail);
      req.end(body);
    });
  }
  return {
    verify: async (token, audiences, parent) => {
      const signal = AbortSignal.any([
        AbortSignal.timeout(options.timeoutMs ?? 5_000),
        ...(parent ? [parent] : []),
      ]);
      try {
        if (!token || token.length > 16_384 || /\s/.test(token))
          throw new StorageAccessError(403, 'identity_denied');
        const review = record(
          (
            await call(
              '/apis/authentication.k8s.io/v1/tokenreviews',
              {
                apiVersion: 'authentication.k8s.io/v1',
                kind: 'TokenReview',
                spec: { token, audiences },
              },
              signal
            )
          )['status']
        );
        if (review['authenticated'] !== true || !Array.isArray(review['audiences']))
          throw new StorageAccessError(403, 'identity_denied');
        const user = record(review['user']);
        const accounts = [
          {
            role: 'task',
            namespace: 'lifemodel-motor',
            account: 'task',
            audience: STORAGE_AUDIENCES.task[0],
          },
          {
            role: 'core',
            namespace: 'lifemodel',
            account: 'core',
            audience: STORAGE_AUDIENCES.control[0],
          },
          {
            role: 'core',
            namespace: 'lifemodel',
            account: 'core',
            audience: STORAGE_AUDIENCES.read[0],
          },
          {
            role: 'web',
            namespace: 'lifemodel',
            account: 'web',
            audience: STORAGE_AUDIENCES.read[1],
          },
        ] as const;
        const account = accounts.find(
          (candidate) =>
            audiences.includes(candidate.audience) &&
            (review['audiences'] as unknown[]).includes(candidate.audience) &&
            user['username'] === `system:serviceaccount:${candidate.namespace}:${candidate.account}`
        );
        if (!account || typeof user['uid'] !== 'string' || !user['uid'])
          throw new StorageAccessError(403, 'identity_denied');
        const extra = record(user['extra']);
        const podName = one(extra['authentication.kubernetes.io/pod-name']);
        const podUid = one(extra['authentication.kubernetes.io/pod-uid']);
        if (!NAME.test(podName)) throw new StorageAccessError(403, 'identity_denied');
        const pod = await call(
          `/api/v1/namespaces/${account.namespace}/pods/${encodeURIComponent(podName)}`,
          undefined,
          signal
        );
        const metadata = record(pod['metadata']);
        if (
          metadata['name'] !== podName ||
          metadata['namespace'] !== account.namespace ||
          metadata['uid'] !== podUid ||
          metadata['deletionTimestamp'] != null ||
          record(pod['spec'])['serviceAccountName'] !== account.account
        )
          throw new StorageAccessError(403, 'identity_denied');
        if (account.role !== 'task') return { role: account.role, podUid };
        const owners = metadata['ownerReferences'];
        if (!Array.isArray(owners)) throw new StorageAccessError(403, 'identity_denied');
        const controllers = owners.map(record).filter((owner) => owner['controller'] === true);
        const controller = controllers[0];
        if (
          controllers.length !== 1 ||
          controller?.['kind'] !== 'Job' ||
          controller['apiVersion'] !== 'batch/v1' ||
          typeof controller['name'] !== 'string' ||
          !NAME.test(controller['name'])
        )
          throw new StorageAccessError(403, 'identity_denied');
        const job = record(
          (
            await call(
              `/apis/batch/v1/namespaces/${account.namespace}/jobs/${encodeURIComponent(controller['name'])}`,
              undefined,
              signal
            )
          )['metadata']
        );
        if (
          job['uid'] !== controller['uid'] ||
          typeof job['uid'] !== 'string' ||
          !job['uid'] ||
          job['namespace'] !== account.namespace ||
          job['name'] !== controller['name'] ||
          job['deletionTimestamp'] != null
        )
          throw new StorageAccessError(403, 'identity_denied');
        return { role: 'task', podUid, jobUid: job['uid'] };
      } catch (error) {
        if (parent?.aborted) throw new StorageAccessError(403, 'access_revoked');
        if (error instanceof StorageAccessError) throw error;
        throw new StorageAccessError(503, 'identity_unavailable');
      }
    },
  };
}
