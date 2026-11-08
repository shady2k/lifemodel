/**
 * ADR-016 §5: the log store's PersistentVolume is retained, so a claim that is
 * deleted and recreated leaves the volume `Released` holding the old claim's
 * UID and it never binds again by itself. This pre-flight clears that stale
 * `spec.claimRef`, the one supported way to make a retained volume claimable,
 * and then lets the recreated claim bind.
 *
 * It addresses exactly two named objects - the volume and the store's claim -
 * and never a `Bound` volume, never another volume and never any data.
 */
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import type { LoaderLogger } from './logger.js';

export const LOGS_VOLUME_NAME = 'lifemodel-logs';
export const LOGS_CLAIM_NAMESPACE = 'lifemodel-system';
export const LOGS_CLAIM_NAME = 'logs-store';
const LOGS_VOLUME_PATH = `/api/v1/persistentvolumes/${LOGS_VOLUME_NAME}`;
const LOGS_CLAIM_PATH = `/api/v1/namespaces/${LOGS_CLAIM_NAMESPACE}/persistentvolumeclaims/${LOGS_CLAIM_NAME}`;
const SERVICE_ACCOUNT = '/var/run/secrets/kubernetes.io/serviceaccount';

export interface KubernetesObjectResponse {
  status: number;
  body: string;
}

/** The two verbs the pre-flight needs, on one path it names itself. */
export interface KubernetesObjectApi {
  /** One named object; 404 when it does not exist. */
  get(path: string): Promise<KubernetesObjectResponse>;
  /** A merge patch (`application/merge-patch+json`) on that object. */
  patch(path: string, patch: string): Promise<KubernetesObjectResponse>;
}

export interface KubernetesObjectApiOptions {
  apiServer?: string;
  tokenFile?: string;
  caFile?: string;
  /** Override HTTP for tests; production uses the in-cluster HTTPS endpoint. */
  request?: (
    url: URL,
    method: string,
    token: string,
    body: string | undefined,
    ca: Buffer | undefined,
    contentType: string | undefined
  ) => Promise<KubernetesObjectResponse>;
  timeoutMs?: number;
}

function defaultRequest(timeoutMs: number): NonNullable<KubernetesObjectApiOptions['request']> {
  return (url, method, token, body, ca, contentType) =>
    new Promise<KubernetesObjectResponse>((resolve, reject) => {
      const req = httpsRequest(
        url,
        {
          method,
          ca,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined
              ? {}
              : {
                  'content-type': contentType ?? 'application/json',
                  'content-length': Buffer.byteLength(body),
                }),
          },
        },
        (res) => {
          let response = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            response += chunk;
          });
          res.on('end', () => {
            clearTimeout(timer);
            resolve({ status: res.statusCode ?? 0, body: response });
          });
          res.on('aborted', () => {
            clearTimeout(timer);
            reject(new Error('Kubernetes API response was truncated'));
          });
        }
      );
      const timer = setTimeout(
        () => req.destroy(new Error(`Kubernetes API request exceeded ${String(timeoutMs)} ms`)),
        timeoutMs
      );
      req.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      if (body !== undefined) req.write(body);
      req.end();
    });
}

/** The in-cluster client; it can only read and patch the paths it is handed. */
function createKubernetesObjectApi(options: KubernetesObjectApiOptions = {}): KubernetesObjectApi {
  const host =
    options.apiServer ??
    `https://${process.env['KUBERNETES_SERVICE_HOST'] ?? 'kubernetes.default.svc'}:${process.env['KUBERNETES_SERVICE_PORT_HTTPS'] ?? '443'}`;
  const request = options.request ?? defaultRequest(options.timeoutMs ?? 10_000);
  const send = async (
    path: string,
    method: string,
    body: string | undefined,
    contentType: string | undefined
  ): Promise<KubernetesObjectResponse> => {
    const token = (await readFile(options.tokenFile ?? `${SERVICE_ACCOUNT}/token`, 'utf8')).trim();
    if (token === '') throw new Error('Kubernetes ServiceAccount token is empty');
    let ca: Buffer | undefined;
    try {
      ca = await readFile(options.caFile ?? `${SERVICE_ACCOUNT}/ca.crt`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return request(new URL(path, host), method, token, body, ca, contentType);
  };
  return {
    get: (path) => send(path, 'GET', undefined, undefined),
    patch: (path, patch) => send(path, 'PATCH', patch, 'application/merge-patch+json'),
  };
}

interface PersistentVolume {
  metadata?: { resourceVersion?: string };
  spec?: { claimRef?: { name?: string; namespace?: string; uid?: string } };
  status?: { phase?: string };
}
interface PersistentVolumeClaim {
  metadata?: { uid?: string };
}

export interface LogsVolumeClaimPreflight {
  run(): Promise<void>;
}

export interface LogsVolumeClaimOptions extends KubernetesObjectApiOptions {
  api?: KubernetesObjectApi;
  logger?: LoaderLogger;
}

/**
 * Runs before the loader's durable first-start phases, on every bootstrap
 * attempt: one read of the volume, and a patch only when it is `Released` and
 * the claim it still holds is a previous generation of the store's claim.
 */
export function createLogsVolumeClaimPreflight(
  options: LogsVolumeClaimOptions = {}
): LogsVolumeClaimPreflight {
  const api = options.api ?? createKubernetesObjectApi(options);
  return {
    run: async () => {
      const volumeResponse = await api.get(LOGS_VOLUME_PATH);
      if (volumeResponse.status === 404) return;
      if (volumeResponse.status !== 200)
        throw new Error(
          `Kubernetes PersistentVolume ${LOGS_VOLUME_NAME} read failed (${String(volumeResponse.status)}): ${volumeResponse.body}`
        );
      const volume = JSON.parse(volumeResponse.body) as PersistentVolume;
      if (volume.status?.phase !== 'Released') return;
      const claimRef = volume.spec?.claimRef;
      if (claimRef?.namespace !== LOGS_CLAIM_NAMESPACE || claimRef.name !== LOGS_CLAIM_NAME) return;
      const claimResponse = await api.get(LOGS_CLAIM_PATH);
      if (claimResponse.status !== 200 && claimResponse.status !== 404)
        throw new Error(
          `Kubernetes PersistentVolumeClaim ${LOGS_CLAIM_NAME} read failed (${String(claimResponse.status)}): ${claimResponse.body}`
        );
      if (claimResponse.status === 200) {
        const uid = (JSON.parse(claimResponse.body) as PersistentVolumeClaim).metadata?.uid;
        // The volume already holds the live claim's UID: nothing is stale.
        if (uid !== undefined && uid === claimRef.uid) return;
      }
      // The Kubernetes documented way to make a retained volume claimable
      // again: remove `spec.claimRef` with a merge patch. The read's
      // resourceVersion makes the patch conditional, so a volume that changed -
      // bound, or taken by another claim - since the read is refused instead.
      const patch = {
        ...(volume.metadata?.resourceVersion === undefined
          ? {}
          : { metadata: { resourceVersion: volume.metadata.resourceVersion } }),
        spec: { claimRef: null },
      };
      const patched = await api.patch(LOGS_VOLUME_PATH, JSON.stringify(patch));
      if (patched.status !== 200)
        throw new Error(
          `Kubernetes PersistentVolume ${LOGS_VOLUME_NAME} claimRef patch failed (${String(patched.status)}): ${patched.body}`
        );
      options.logger?.info(
        { volume: LOGS_VOLUME_NAME, claimUid: claimRef.uid },
        'cleared the released log volume claim so the recreated claim can bind'
      );
    },
  };
}
