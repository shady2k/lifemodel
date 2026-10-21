/**
 * Copies the CNPG-generated application login into the two namespaces that use
 * it: the core, and the storage module (the interim login the owner chose for
 * it, lifemodel-653.7.8, until lifemodel-2t5 leases it an identity).
 */
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import type { PlatformPhase } from './platform-bootstrap.js';

export interface KubernetesPostgresSecretOptions {
  apiServer?: string;
  tokenFile?: string;
  caFile?: string;
  timeoutMs?: number;
  request?: (
    url: URL,
    method: string,
    token: string,
    body: string | undefined,
    ca: Buffer | undefined
  ) => Promise<{ status: number; body: string }>;
}

const SOURCE_NAMESPACE = 'lifemodel-state';
const SOURCE_NAME = 'lifemodel-app';
const TARGETS = [
  { namespace: 'lifemodel', name: 'lifemodel-db-credentials' },
  { namespace: 'lifemodel-system', name: 'storage-module-db-credentials' },
] as const;
const SERVICE_ACCOUNT = '/var/run/secrets/kubernetes.io/serviceaccount';

/**
 * A fixed-name API client: it reads the one CNPG Secret and writes only the two
 * platform-created Secrets named above. The module's copy is a Secret in its
 * own namespace that only its pod reads, so the module never sees the core
 * namespace and no other workload sees a database login.
 */
export function createKubernetesPostgresSecretPhase(
  options: KubernetesPostgresSecretOptions = {}
): PlatformPhase {
  const host =
    options.apiServer ??
    `https://${process.env['KUBERNETES_SERVICE_HOST'] ?? 'kubernetes.default.svc'}:${process.env['KUBERNETES_SERVICE_PORT_HTTPS'] ?? '443'}`;
  const tokenFile = options.tokenFile ?? `${SERVICE_ACCOUNT}/token`;
  const caFile = options.caFile ?? `${SERVICE_ACCOUNT}/ca.crt`;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const customRequest = options.request;
  const call =
    options.request ??
    ((url, method, token, body, ca) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
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
                    'content-type': 'application/json',
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
          () =>
            req.destroy(
              new Error(`Kubernetes API request timed out after ${String(timeoutMs)} ms`)
            ),
          timeoutMs
        );
        req.on('error', (error) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
        if (body !== undefined) req.write(body);
        req.end();
      }));
  async function send(url: URL, method: string, body?: unknown) {
    const token = (await readFile(tokenFile, 'utf8')).trim();
    if (!token) throw new Error('Kubernetes ServiceAccount token is empty');
    let ca: Buffer | undefined;
    try {
      ca = await readFile(caFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const requestBody = body === undefined ? undefined : JSON.stringify(body);
    if (!customRequest) return call(url, method, token, requestBody, ca);
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Kubernetes API request timed out after ${String(timeoutMs)} ms`));
      }, timeoutMs);
      let result: Promise<{ status: number; body: string }>;
      try {
        result = customRequest(url, method, token, requestBody, ca);
      } catch (error) {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      result.then(
        (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      );
    });
  }
  const sourceUrl = new URL(`/api/v1/namespaces/${SOURCE_NAMESPACE}/secrets/${SOURCE_NAME}`, host);
  return {
    name: 'cnpg-copy-core-credentials',
    run: async () => {
      const source = await send(sourceUrl, 'GET');
      if (source.status !== 200)
        throw new Error(
          `CNPG application Secret read failed (${String(source.status)})`
        );
      const credentials = (JSON.parse(source.body) as { data?: Record<string, string> }).data;
      const username = credentials?.['username'];
      const password = credentials?.['password'];
      if (
        !username ||
        !password ||
        !Buffer.from(username, 'base64').toString() ||
        !Buffer.from(password, 'base64').toString()
      )
        throw new Error('CNPG application Secret lifemodel-app has no username/password');
      /** One target: create it when it is absent, else replace its two keys. */
      async function copy(target: (typeof TARGETS)[number]): Promise<void> {
        const targetUrl = new URL(
          `/api/v1/namespaces/${target.namespace}/secrets/${target.name}`,
          host
        );
        const collection = new URL(`/api/v1/namespaces/${target.namespace}/secrets`, host);
        const body = {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: {
            name: target.name,
            namespace: target.namespace,
            annotations: { 'kustomize.toolkit.fluxcd.io/prune': 'disabled' },
          },
          type: 'Opaque',
          data: { username, password },
        };
        const verify = async (): Promise<void> => {
          const response = await send(targetUrl, 'GET');
          const copied =
            response.status === 200
              ? (JSON.parse(response.body) as { data?: Record<string, string> }).data
              : undefined;
          if (
            response.status !== 200 ||
            copied === undefined ||
            copied['username'] !== username ||
            copied['password'] !== password
          )
            throw new Error(
              `${target.name} read-back did not match CNPG credentials (${String(response.status)})`
            );
        };
        let current = await send(targetUrl, 'GET');
        if (current.status === 404) {
          current = await send(collection, 'POST', body);
          if (current.status === 201) return verify();
          if (current.status !== 409)
            throw new Error(`${target.name} create failed (${String(current.status)})`);
          current = await send(targetUrl, 'GET');
          if (current.status !== 200)
            throw new Error(
              `${target.name} read after conflict failed (${String(current.status)})`
            );
        }
        if (current.status !== 200)
          throw new Error(`${target.name} read failed (${String(current.status)})`);
        const resourceVersion = (
          JSON.parse(current.body) as { metadata?: { resourceVersion?: string } }
        ).metadata?.resourceVersion;
        if (!resourceVersion) throw new Error(`${target.name} has no resourceVersion`);
        const result = await send(targetUrl, 'PUT', {
          ...body,
          metadata: { ...body.metadata, resourceVersion },
        });
        if (result.status !== 200)
          throw new Error(`${target.name} update failed (${String(result.status)})`);
        await verify();
      }
      for (const target of TARGETS) await copy(target);
    },
  };
}
