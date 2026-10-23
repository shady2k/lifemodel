/** Narrow Kubernetes API stores for the PKI-owned platform resources. */
import { readFile } from 'node:fs/promises';
import { Agent, request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import type { TlsSecretStore, CaConfigMapStore, PkiStatusStore } from './pki.js';
interface ApiOptions {
  apiServer?: string;
  namespace?: string;
  tokenFile?: string;
  caFile?: string;
  request?: (
    url: URL,
    method: string,
    token: string,
    body?: string,
    ca?: Buffer
  ) => Promise<{ status: number; body: string }>;
  timeoutMs?: number;
}
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
// One bounded keep-alive pool for this helper, shared across fixed-name reads.
// Idle sockets expire; error guards remain attached through reuse and teardown.
const apiAgent = new Agent({
  keepAlive: true,
  maxSockets: 4,
  maxTotalSockets: 4,
  maxFreeSockets: 2,
  timeout: 10_000,
});
apiAgent.on('error', () => undefined);
const guardedSockets = new WeakSet<Socket>();
function guardSocket(socket: Socket): void {
  if (guardedSockets.has(socket)) return;
  guardedSockets.add(socket);
  socket.on('error', () => undefined);
}
const MAX_API_RESPONSE_BYTES = 1024 * 1024;

function createApi(options: ApiOptions, resource: string, name: string) {
  const host =
    options.apiServer ??
    `https://${process.env['KUBERNETES_SERVICE_HOST'] ?? 'kubernetes.default.svc'}:${process.env['KUBERNETES_SERVICE_PORT_HTTPS'] ?? '443'}`;
  const namespace = options.namespace ?? 'lifemodel-system';
  const url = new URL(
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/${resource}/${name}`,
    host
  );
  const timeout = options.timeoutMs ?? 10000;
  const call =
    options.request ??
    ((url, method, token, body, ca) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        let settled = false;
        const fail = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error('Kubernetes API transport failed'));
          req.destroy();
        };
        const req = httpsRequest(
          url,
          {
            method,
            ca,
            agent: apiAgent,
            headers: {
              authorization: `Bearer ${token}`,
              ...(body === undefined
                ? {}
                : {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body),
                  }),
            },
          },
          (res) => {
            // Before flowing bytes, and retained until the response is gone.
            res.on('error', fail);
            res.on('aborted', fail);
            let response = '';
            let bytes = 0;
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              bytes += Buffer.byteLength(chunk);
              if (bytes > MAX_API_RESPONSE_BYTES) {
                fail();
                res.destroy();
                return;
              }
              response += chunk;
            });
            res.on('end', () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve({ status: res.statusCode ?? 0, body: response });
            });
            res.on('close', () => {
              if (!res.complete) fail();
            });
          }
        );
        req.on('error', fail);
        req.on('socket', guardSocket);
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('Kubernetes API request timed out'));
          req.destroy();
        }, timeout);
        if (body !== undefined) req.write(body);
        req.end();
      }));
  return {
    namespace,
    url,
    send: async (method: string, payload?: unknown) => {
      const token = (await readFile(options.tokenFile ?? `${SA}/token`, 'utf8')).trim();
      if (!token) throw new Error('Kubernetes ServiceAccount token is empty');
      let ca: Buffer | undefined;
      try {
        ca = await readFile(options.caFile ?? `${SA}/ca.crt`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      const body = payload === undefined ? undefined : JSON.stringify(payload);
      // Bound injected transports too: a stalled API must not hold PKI boot.
      if (!options.request) return call(url, method, token, body, ca);
      return new Promise<{ status: number; body: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Kubernetes API request timed out'));
        }, timeout);
        Promise.resolve()
          .then(() => call(url, method, token, body, ca))
          .then(
            (response) => {
              clearTimeout(timer);
              resolve(response);
            },
            () => {
              clearTimeout(timer);
              reject(new Error('Kubernetes API transport failed'));
            }
          );
      });
    },
  };
}
export function createKubernetesTlsStores(options: ApiOptions = {}): {
  secret: TlsSecretStore;
  serviceSecret: TlsSecretStore;
  taskModelSecret: TlsSecretStore;
  configMap: CaConfigMapStore;
  status: PkiStatusStore;
} {
  const sec = createApi(options, 'secrets', 'lifemodel-tls');
  const serviceSec = createApi(options, 'secrets', 'storage-module-tls');
  const taskModelSec = createApi(options, 'secrets', 'model-gateway-task-tls');
  const cm = createApi(options, 'configmaps', 'lifemodel-ca');
  // A0 precreates these public-only replicas and their fixed-name write RBAC.
  // Both application namespaces exist in instance, before A0; PKI readiness
  // must never depend on step A or D, which themselves wait for the loader.
  const coreCm = createApi({ ...options, namespace: 'lifemodel' }, 'configmaps', 'lifemodel-ca');
  const motorCm = createApi(
    { ...options, namespace: 'lifemodel-motor' },
    'configmaps',
    'lifemodel-ca'
  );
  const statusCm = createApi(options, 'configmaps', 'lifemodel-pki-status');
  async function read(resource: ReturnType<typeof createApi>) {
    const r = await resource.send('GET');
    if (r.status === 404) return null;
    if (r.status !== 200)
      throw new Error(`Kubernetes PKI resource read failed (${String(r.status)})`);
    return JSON.parse(r.body) as {
      metadata?: {
        resourceVersion?: string;
        annotations?: Record<string, string>;
        labels?: Record<string, string>;
      };
      data?: Record<string, string>;
    };
  }
  /** One TLS Secret the platform precreated: read, replace, read back. */
  function secretStore(resource: ReturnType<typeof createApi>, name: string): TlsSecretStore {
    return {
      read: async () => {
        const obj = await read(resource);
        if (!obj) return {};
        const d = obj.data ?? {};
        return {
          ...(d['ca.crt'] ? { ca: Buffer.from(d['ca.crt'], 'base64').toString() } : {}),
          ...(d['tls.crt'] ? { cert: Buffer.from(d['tls.crt'], 'base64').toString() } : {}),
          ...(d['tls.key'] ? { key: Buffer.from(d['tls.key'], 'base64').toString() } : {}),
        };
      },
      write: async (ca, cert, key) => {
        const old = await read(resource);
        if (!old?.metadata?.resourceVersion)
          throw new Error(`${name} must exist before loader startup`);
        const r = await resource.send('PUT', {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: {
            name,
            namespace: resource.namespace,
            resourceVersion: old.metadata.resourceVersion,
            ...(old.metadata.annotations ? { annotations: old.metadata.annotations } : {}),
            ...(old.metadata.labels ? { labels: old.metadata.labels } : {}),
          },
          type: 'kubernetes.io/tls',
          data: {
            'ca.crt': Buffer.from(ca).toString('base64'),
            'tls.crt': Buffer.from(cert).toString('base64'),
            'tls.key': Buffer.from(key).toString('base64'),
          },
        });
        if (r.status !== 200)
          throw new Error(`Kubernetes TLS Secret update failed (${String(r.status)})`);
        const check = await read(resource);
        if (check?.data?.['tls.crt'] !== Buffer.from(cert).toString('base64'))
          throw new Error('Kubernetes TLS Secret read-back mismatch');
      },
    };
  }
  return {
    secret: secretStore(sec, 'lifemodel-tls'),
    serviceSecret: secretStore(serviceSec, 'storage-module-tls'),
    taskModelSecret: secretStore(taskModelSec, 'model-gateway-task-tls'),
    configMap: {
      read: async () => {
        const obj = await read(cm);
        return obj?.data?.['ca.crt'] ? obj.data['ca.crt'] : null;
      },
      write: async (ca) => {
        for (const resource of [cm, coreCm, motorCm]) {
          const old = await read(resource);
          if (!old?.metadata?.resourceVersion)
            throw new Error('A0 CA ConfigMap must exist before loader startup');
          const r = await resource.send('PUT', {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: {
              name: 'lifemodel-ca',
              namespace: resource.namespace,
              resourceVersion: old.metadata.resourceVersion,
              ...(old.metadata.annotations ? { annotations: old.metadata.annotations } : {}),
              ...(old.metadata.labels ? { labels: old.metadata.labels } : {}),
            },
            data: { 'ca.crt': ca },
          });
          if (r.status !== 200)
            throw new Error(`Kubernetes CA ConfigMap update failed (${String(r.status)})`);
          if ((await read(resource))?.data?.['ca.crt'] !== ca)
            throw new Error('Kubernetes CA ConfigMap read-back mismatch');
        }
      },
    },
    status: {
      write: async (data) => {
        const old = await read(statusCm);
        if (!old?.metadata?.resourceVersion)
          throw new Error('A0 PKI status ConfigMap must exist before loader startup');
        const r = await statusCm.send('PUT', {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: {
            name: 'lifemodel-pki-status',
            namespace: statusCm.namespace,
            resourceVersion: old.metadata.resourceVersion,
            ...(old.metadata.annotations ? { annotations: old.metadata.annotations } : {}),
            ...(old.metadata.labels ? { labels: old.metadata.labels } : {}),
          },
          data: Object.fromEntries(
            Object.entries(data).map(([key, value]) => [
              key,
              typeof value === 'string' ? value : JSON.stringify(value),
            ])
          ),
        });
        if (r.status !== 200)
          throw new Error(`Kubernetes PKI status update failed (${String(r.status)})`);
        const check = await read(statusCm);
        for (const [key, value] of Object.entries(data))
          if (check?.data?.[key] !== (typeof value === 'string' ? value : JSON.stringify(value)))
            throw new Error('Kubernetes PKI status read-back mismatch');
      },
    },
  };
}
