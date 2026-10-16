/** Narrow Kubernetes API stores for the PKI-owned A0 resources. */
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import type { TlsSecretStore, CaConfigMapStore } from './pki.js';
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
  configMap: CaConfigMapStore;
} {
  const sec = createApi(options, 'secrets', 'lifemodel-tls');
  const cm = createApi(options, 'configmaps', 'lifemodel-ca');
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
  return {
    secret: {
      read: async () => {
        const obj = await read(sec);
        if (!obj) return {};
        const d = obj.data ?? {};
        return {
          ...(d['ca.crt'] ? { ca: Buffer.from(d['ca.crt'], 'base64').toString() } : {}),
          ...(d['tls.crt'] ? { cert: Buffer.from(d['tls.crt'], 'base64').toString() } : {}),
          ...(d['tls.key'] ? { key: Buffer.from(d['tls.key'], 'base64').toString() } : {}),
        };
      },
      write: async (ca, cert, key) => {
        const old = await read(sec);
        if (!old?.metadata?.resourceVersion)
          throw new Error('A0 TLS Secret must exist before loader startup');
        const r = await sec.send('PUT', {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: {
            name: 'lifemodel-tls',
            namespace: sec.namespace,
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
        const check = await read(sec);
        if (check?.data?.['tls.crt'] !== Buffer.from(cert).toString('base64'))
          throw new Error('Kubernetes TLS Secret read-back mismatch');
      },
    },
    configMap: {
      read: async () => {
        const obj = await read(cm);
        return obj?.data?.['ca.crt'] ? obj.data['ca.crt'] : null;
      },
      write: async (ca) => {
        const old = await read(cm);
        if (!old?.metadata?.resourceVersion)
          throw new Error('A0 CA ConfigMap must exist before loader startup');
        const r = await cm.send('PUT', {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: {
            name: 'lifemodel-ca',
            namespace: cm.namespace,
            resourceVersion: old.metadata.resourceVersion,
            ...(old.metadata.annotations ? { annotations: old.metadata.annotations } : {}),
            ...(old.metadata.labels ? { labels: old.metadata.labels } : {}),
          },
          data: { 'ca.crt': ca },
        });
        if (r.status !== 200)
          throw new Error(`Kubernetes CA ConfigMap update failed (${String(r.status)})`);
        if ((await read(cm))?.data?.['ca.crt'] !== ca)
          throw new Error('Kubernetes CA ConfigMap read-back mismatch');
      },
    },
  };
}
