/**
 * The read-only projection of the platform settings for consumers: one
 * ConfigMap in the application namespace that only the loader's service
 * account may write (ADR-014 D6; the core reads it, never writes it).
 *
 * One fixed-name API client: GET, create once, then update with the read
 * resourceVersion, every write verified by reading back. A failure throws to
 * the store, which records, shows and retries it - never fatal.
 */
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';

import type { SettingsProjection, SettingsProjectionContent } from './store.js';

export interface KubernetesSettingsProjectionOptions {
  apiServer?: string;
  tokenFile?: string;
  caFile?: string;
  timeoutMs?: number;
  namespace?: string;
  name?: string;
  /** Override HTTP for tests; production uses the in-cluster HTTPS endpoint. */
  request?: (
    url: URL,
    method: string,
    token: string,
    body: string | undefined,
    ca: Buffer | undefined
  ) => Promise<{ status: number; body: string }>;
}

const SERVICE_ACCOUNT = '/var/run/secrets/kubernetes.io/serviceaccount';
const DOCUMENT_VERSION = 1;

/** The wire form of the projection document (ConfigMap data is strings). */
export function settingsProjectionData(content: SettingsProjectionContent): string {
  return JSON.stringify({
    version: DOCUMENT_VERSION,
    revision: content.revision,
    values: content.values,
  });
}

export function createKubernetesSettingsProjection(
  options: KubernetesSettingsProjectionOptions = {}
): SettingsProjection {
  const host =
    options.apiServer ??
    `https://${process.env['KUBERNETES_SERVICE_HOST'] ?? 'kubernetes.default.svc'}:${process.env['KUBERNETES_SERVICE_PORT_HTTPS'] ?? '443'}`;
  const tokenFile = options.tokenFile ?? `${SERVICE_ACCOUNT}/token`;
  const caFile = options.caFile ?? `${SERVICE_ACCOUNT}/ca.crt`;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const namespace = options.namespace ?? 'lifemodel';
  const name = options.name ?? 'lifemodel-platform-settings';
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
  async function send(
    url: URL,
    method: string,
    body?: unknown
  ): Promise<{ status: number; body: string }> {
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
  const objectUrl = new URL(`/api/v1/namespaces/${namespace}/configmaps/${name}`, host);
  const collectionUrl = new URL(`/api/v1/namespaces/${namespace}/configmaps`, host);
  function configMap(resourceVersion?: string): unknown {
    return {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name,
        namespace,
        annotations: { 'kustomize.toolkit.fluxcd.io/prune': 'disabled' },
        ...(resourceVersion === undefined ? {} : { resourceVersion }),
      },
      data: { 'settings.json': settingsProjectionData(content) },
    };
  }
  let content: SettingsProjectionContent = { revision: 0, values: {} };
  async function verify(): Promise<void> {
    const response = await send(objectUrl, 'GET');
    if (response.status !== 200)
      throw new Error(`platform settings ConfigMap read-back failed (${String(response.status)})`);
    const data = (JSON.parse(response.body) as { data?: Record<string, string> }).data;
    if (data?.['settings.json'] !== settingsProjectionData(content))
      throw new Error('platform settings ConfigMap read-back did not match the write');
  }
  return {
    project: async (next) => {
      content = { revision: next.revision, values: { ...next.values } };
      const current = await send(objectUrl, 'GET');
      if (current.status === 404) {
        const created = await send(collectionUrl, 'POST', configMap());
        if (created.status !== 201)
          throw new Error(`platform settings ConfigMap create failed (${String(created.status)})`);
        await verify();
        return;
      }
      if (current.status !== 200)
        throw new Error(`platform settings ConfigMap read failed (${String(current.status)})`);
      const resourceVersion = (
        JSON.parse(current.body) as { metadata?: { resourceVersion?: string } }
      ).metadata?.resourceVersion;
      if (!resourceVersion) throw new Error('platform settings ConfigMap has no resourceVersion');
      const updated = await send(objectUrl, 'PUT', configMap(resourceVersion));
      if (updated.status !== 200)
        throw new Error(`platform settings ConfigMap update failed (${String(updated.status)})`);
      await verify();
    },
  };
}
