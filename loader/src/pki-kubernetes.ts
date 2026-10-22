/** Narrow Kubernetes API stores for the PKI-owned platform resources. */
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
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
    ((target, method, token, body, ca) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpsRequest(
          target,
          {
            method,
            ca,
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
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              text += chunk;
            });
            res.on('end', () => {
              resolve({ status: res.statusCode ?? 0, body: text });
            });
            res.on('aborted', () => {
              reject(new Error('Kubernetes API response truncated'));
            });
          }
        );
        const timer = setTimeout(
          () => req.destroy(new Error('Kubernetes API request timed out')),
          timeout
        );
        req.on('close', () => {
          clearTimeout(timer);
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
      }));
  return {
    namespace,
    url,
    send: async (method: string, payload?: unknown) => {
      const token = (await readFile(options.tokenFile ?? `${SA}/token`, 'utf8')).trim();
      let ca: Buffer | undefined;
      try {
        ca = await readFile(options.caFile ?? `${SA}/ca.crt`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      return call(
        url,
        method,
        token,
        payload === undefined ? undefined : JSON.stringify(payload),
        ca
      );
    },
  };
}
export function createKubernetesTlsStores(options: ApiOptions = {}): {
  secret: TlsSecretStore;
  serviceSecret: TlsSecretStore;
  configMap: CaConfigMapStore;
  status: PkiStatusStore;
} {
  const sec = createApi(options, 'secrets', 'lifemodel-tls');
  const serviceSec = createApi(options, 'secrets', 'storage-module-tls');
  const cm = createApi(options, 'configmaps', 'lifemodel-ca');
  // A0 precreates this public-only replica and its fixed-name write RBAC.
  // The application namespace exists before A0; no dependency on step A or D.
  const coreCm = createApi({ ...options, namespace: 'lifemodel' }, 'configmaps', 'lifemodel-ca');
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
    configMap: {
      read: async () => {
        const obj = await read(cm);
        return obj?.data?.['ca.crt'] ? obj.data['ca.crt'] : null;
      },
      write: async (ca) => {
        for (const resource of [cm, coreCm]) {
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
