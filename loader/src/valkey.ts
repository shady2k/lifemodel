/** Generates one durable Valkey password and copies it to the core namespace. */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import type { PlatformPhase } from './platform-bootstrap.js';

export interface KubernetesValkeySecretOptions {
  apiServer?: string;
  tokenFile?: string;
  caFile?: string;
  timeoutMs?: number;
  randomPassword?: () => string;
  request?: (
    url: URL,
    method: string,
    token: string,
    body: string | undefined,
    ca: Buffer | undefined
  ) => Promise<{ status: number; body: string }>;
}

export const SOURCE_NAMESPACE = 'lifemodel-state';
export const SECRET_NAME = 'lifemodel-valkey-credentials';
export const TARGET_NAMESPACE = 'lifemodel';
const SERVICE_ACCOUNT = '/var/run/secrets/kubernetes.io/serviceaccount';

/** Idempotently creates the password in state and mirrors it to the core namespace. */
export function createKubernetesValkeySecretPhase(
  options: KubernetesValkeySecretOptions = {}
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
  const secretUrl = (namespace: string) =>
    new URL(`/api/v1/namespaces/${namespace}/secrets/${SECRET_NAME}`, host);
  const collectionUrl = (namespace: string) =>
    new URL(`/api/v1/namespaces/${namespace}/secrets`, host);
  const sourceUrl = secretUrl(SOURCE_NAMESPACE);
  const targetUrl = secretUrl(TARGET_NAMESPACE);
  const password = options.randomPassword ?? (() => randomBytes(32).toString('base64url'));
  let pendingSourcePassword: string | undefined;
  return {
    name: 'valkey-password',
    run: async () => {
      let source = await send(sourceUrl, 'GET');
      if (source.status === 404) {
        pendingSourcePassword ??= password();
        const generated = pendingSourcePassword;
        if (!generated) throw new Error('generated Valkey password is empty');
        const body = {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: {
            name: SECRET_NAME,
            namespace: SOURCE_NAMESPACE,
            annotations: { 'kustomize.toolkit.fluxcd.io/prune': 'disabled' },
          },
          type: 'Opaque',
          data: { password: Buffer.from(generated).toString('base64') },
        };
        source = await send(collectionUrl(SOURCE_NAMESPACE), 'POST', body);
        if (source.status === 409) source = await send(sourceUrl, 'GET');
        else if (source.status !== 201)
          throw new Error(
            `Valkey password Secret create failed (${String(source.status)}): ${source.body}`
          );
      }
      if (source.status !== 200 && source.status !== 201)
        throw new Error(
          `Valkey password Secret read failed (${String(source.status)}): ${source.body}`
        );
      const encodedPassword = (JSON.parse(source.body) as { data?: Record<string, string> }).data?.[
        'password'
      ];
      if (!encodedPassword || !Buffer.from(encodedPassword, 'base64').toString())
        throw new Error('Valkey password Secret has no password');
      const targetBody = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: SECRET_NAME,
          namespace: TARGET_NAMESPACE,
          annotations: { 'kustomize.toolkit.fluxcd.io/prune': 'disabled' },
        },
        type: 'Opaque',
        data: { password: encodedPassword },
      };
      let target = await send(targetUrl, 'GET');
      if (target.status === 404) {
        target = await send(collectionUrl(TARGET_NAMESPACE), 'POST', targetBody);
        if (target.status === 201) return verify();
        if (target.status !== 409)
          throw new Error(
            `core Valkey Secret create failed (${String(target.status)}): ${target.body}`
          );
        target = await send(targetUrl, 'GET');
      }
      if (target.status !== 200)
        throw new Error(
          `core Valkey Secret read failed (${String(target.status)}): ${target.body}`
        );
      const resourceVersion = (
        JSON.parse(target.body) as { metadata?: { resourceVersion?: string } }
      ).metadata?.resourceVersion;
      if (!resourceVersion) throw new Error('core Valkey Secret has no resourceVersion');
      const result = await send(targetUrl, 'PUT', {
        ...targetBody,
        metadata: { ...targetBody.metadata, resourceVersion },
      });
      if (result.status !== 200)
        throw new Error(
          `core Valkey Secret update failed (${String(result.status)}): ${result.body}`
        );
      await verify();
      async function verify() {
        const response = await send(targetUrl, 'GET');
        const actual =
          response.status === 200
            ? (JSON.parse(response.body) as { data?: Record<string, string> }).data?.['password']
            : undefined;
        if (actual !== encodedPassword)
          throw new Error('core Valkey Secret read-back did not match platform password');
      }
    },
  };
}
