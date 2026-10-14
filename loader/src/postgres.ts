/** Copies the CNPG-generated application login into the core namespace. */
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import type { PlatformPhase } from './platform-bootstrap.js';

export interface KubernetesPostgresSecretOptions {
  apiServer?: string;
  tokenFile?: string;
  caFile?: string;
  request?: (url: URL, method: string, token: string, body: string | undefined, ca: Buffer | undefined) => Promise<{ status: number; body: string }>;
}

const SOURCE_NAMESPACE = 'lifemodel-state';
const SOURCE_NAME = 'lifemodel-app';
const TARGET_NAMESPACE = 'lifemodel';
const TARGET_NAME = 'lifemodel-db-credentials';
const SERVICE_ACCOUNT = '/var/run/secrets/kubernetes.io/serviceaccount';

/** A fixed-name API client; it reads one CNPG Secret and writes one core Secret only. */
export function createKubernetesPostgresSecretPhase(options: KubernetesPostgresSecretOptions = {}): PlatformPhase {
  const host = options.apiServer ?? `https://${process.env['KUBERNETES_SERVICE_HOST'] ?? 'kubernetes.default.svc'}:${process.env['KUBERNETES_SERVICE_PORT_HTTPS'] ?? '443'}`;
  const tokenFile = options.tokenFile ?? `${SERVICE_ACCOUNT}/token`;
  const caFile = options.caFile ?? `${SERVICE_ACCOUNT}/ca.crt`;
  const call = options.request ?? ((url, method, token, body, ca) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpsRequest(url, { method, ca, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }) } }, (res) => {
      let response = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { response += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: response }));
      res.on('aborted', () => reject(new Error('Kubernetes API response was truncated')));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  }));
  async function send(url: URL, method: string, body?: unknown) {
    const token = (await readFile(tokenFile, 'utf8')).trim();
    if (!token) throw new Error('Kubernetes ServiceAccount token is empty');
    let ca: Buffer | undefined;
    try { ca = await readFile(caFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return call(url, method, token, body === undefined ? undefined : JSON.stringify(body), ca);
  }
  const sourceUrl = new URL(`/api/v1/namespaces/${SOURCE_NAMESPACE}/secrets/${SOURCE_NAME}`, host);
  const targetUrl = new URL(`/api/v1/namespaces/${TARGET_NAMESPACE}/secrets/${TARGET_NAME}`, host);
  const targetCollection = new URL(`/api/v1/namespaces/${TARGET_NAMESPACE}/secrets`, host);
  return {
    name: 'cnpg-copy-core-credentials',
    run: async () => {
      const source = await send(sourceUrl, 'GET');
      if (source.status !== 200) throw new Error(`CNPG application Secret read failed (${String(source.status)}): ${source.body}`);
      const credentials = (JSON.parse(source.body) as { data?: Record<string, string> }).data;
      const username = credentials?.['username'];
      const password = credentials?.['password'];
      if (!username || !password || !Buffer.from(username, 'base64').toString() || !Buffer.from(password, 'base64').toString())
        throw new Error('CNPG application Secret lifemodel-app has no username/password');
      const body = {
        apiVersion: 'v1', kind: 'Secret',
        metadata: { name: TARGET_NAME, namespace: TARGET_NAMESPACE, annotations: { 'kustomize.toolkit.fluxcd.io/prune': 'disabled' } },
        type: 'Opaque', data: { username, password },
      };
      const verify = async (): Promise<void> => {
        const response = await send(targetUrl, 'GET');
        const copied = response.status === 200 ? (JSON.parse(response.body) as { data?: Record<string, string> }).data : undefined;
        if (response.status !== 200 || copied?.['username'] !== username || copied['password'] !== password)
          throw new Error('core database Secret read-back did not match CNPG credentials');
      };
      let target = await send(targetUrl, 'GET');
      if (target.status === 404) {
        target = await send(targetCollection, 'POST', body);
        if (target.status === 201) return verify();
        if (target.status !== 409) throw new Error(`core database Secret create failed (${String(target.status)}): ${target.body}`);
        target = await send(targetUrl, 'GET');
        if (target.status !== 200) throw new Error(`core database Secret read after conflict failed (${String(target.status)}): ${target.body}`);
      }
      if (target.status !== 200) throw new Error(`core database Secret read failed (${String(target.status)}): ${target.body}`);
      const resourceVersion = (JSON.parse(target.body) as { metadata?: { resourceVersion?: string } }).metadata?.resourceVersion;
      if (!resourceVersion) throw new Error('core database Secret has no resourceVersion');
      const result = await send(targetUrl, 'PUT', { ...body, metadata: { ...body.metadata, resourceVersion } });
      if (result.status !== 200) throw new Error(`core database Secret update failed (${String(result.status)}): ${result.body}`);
      await verify();
    },
  };
}
