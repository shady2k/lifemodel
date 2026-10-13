/** Durable, restart-safe platform first-start phase records (ADR-010 R7-02). */
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';

export interface PlatformPhaseRecord { phase: string; status: 'running' | 'complete' | 'failed' }
export interface PlatformPhaseStore { read(): Promise<PlatformPhaseRecord | null>; write(record: PlatformPhaseRecord): Promise<void> }
export interface PlatformPhase { name: string; run(): Promise<void> }

/** Runs named idempotent actions; completion is durable before a later action starts. */
export function createPlatformPhaseRunner(store: PlatformPhaseStore): (phases: PlatformPhase[]) => Promise<void> {
  return async (phases) => {
    const names = new Set<string>();
    for (const phase of phases) {
      if (!/^[a-z][a-z0-9-]*$/.test(phase.name) || names.has(phase.name)) throw new Error(`invalid or repeated platform phase: ${phase.name}`);
      names.add(phase.name);
    }
    for (const phase of phases) {
      const current = await store.read();
      const currentIndex = current === null ? -1 : phases.findIndex(({ name }) => name === current.phase);
      if (current !== null && currentIndex < 0) throw new Error(`recorded platform phase is not in this phase plan: ${current.phase}`);
      const phaseIndex = phases.findIndex(({ name }) => name === phase.name);
      if (currentIndex > phaseIndex || (currentIndex === phaseIndex && current?.status === 'complete')) continue;
      await store.write({ phase: phase.name, status: 'running' });
      const before = await store.read();
      if (before?.phase !== phase.name || before.status !== 'running') throw new Error(`platform phase ${phase.name} was not durably recorded before its action`);
      try {
        await phase.run();
      } catch (error) {
        await store.write({ phase: phase.name, status: 'failed' });
        throw error;
      }
      await store.write({ phase: phase.name, status: 'complete' });
      const after = await store.read();
      if (after?.phase !== phase.name || after.status !== 'complete') throw new Error(`platform phase ${phase.name} was not durably recorded after its action`);
    }
  };
}

interface Secret { metadata?: Record<string, unknown> & { resourceVersion?: string }; data?: { phase?: string } }
export interface KubernetesSecretStoreOptions {
  apiServer?: string; namespace?: string; tokenFile?: string; caFile?: string;
  /** Override HTTP for tests; production uses the in-cluster HTTPS endpoint. */
  request?: (url: URL, method: string, token: string, body: string | undefined, ca: Buffer | undefined) => Promise<{ status: number; body: string }>;
  timeoutMs?: number;
}

const SECRET_NAME = 'loader-bootstrap-state';
const SERVICE_ACCOUNT = '/var/run/secrets/kubernetes.io/serviceaccount';

/** Kubernetes API client restricted in code to this one named Secret. */
export function createKubernetesPhaseStore(options: KubernetesSecretStoreOptions = {}): PlatformPhaseStore {
  const host = options.apiServer ?? `https://${process.env['KUBERNETES_SERVICE_HOST'] ?? 'kubernetes.default.svc'}:${process.env['KUBERNETES_SERVICE_PORT_HTTPS'] ?? '443'}`;
  const namespace = options.namespace ?? 'lifemodel-system';
  const tokenFile = options.tokenFile ?? `${SERVICE_ACCOUNT}/token`;
  const caFile = options.caFile ?? `${SERVICE_ACCOUNT}/ca.crt`;
  const url = new URL(`/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${SECRET_NAME}`, host);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const call = options.request ?? ((target, method, token, body, ca) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpsRequest(target, { method, ca, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }) } }, (res) => {
      let response = ''; res.setEncoding('utf8'); res.on('data', (chunk: string) => { response += chunk; }); res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode ?? 0, body: response }); }); res.on('aborted', () => { clearTimeout(timer); reject(new Error('Kubernetes API response was truncated')); });
    });
    const timer = setTimeout(() => req.destroy(new Error(`Kubernetes API request exceeded ${timeoutMs} ms`)), timeoutMs);
    req.on('error', (error) => { clearTimeout(timer); reject(error); }); if (body !== undefined) req.write(body); req.end();
  }));
  async function readRecord(): Promise<PlatformPhaseRecord | null> {
    const response = await send('GET');
    if (response.status === 404) return null;
    if (response.status !== 200) throw new Error(`Kubernetes Secret read failed (${response.status}): ${response.body}`);
    const secret = JSON.parse(response.body) as Secret;
    const encoded = secret.data?.phase; if (encoded === undefined) return null;
    const record = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as PlatformPhaseRecord;
    if (typeof record.phase !== 'string' || (record.status !== 'running' && record.status !== 'complete' && record.status !== 'failed')) throw new Error('Kubernetes phase Secret has an invalid record');
    return record;
  }
  async function send(method: string, payload?: unknown): Promise<{ status: number; body: string }> {
    const token = (await readFile(tokenFile, 'utf8')).trim();
    if (token === '') throw new Error('Kubernetes ServiceAccount token is empty');
    let ca: Buffer | undefined; try { ca = await readFile(caFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return call(url, method, token, payload === undefined ? undefined : JSON.stringify(payload), ca);
  }
  return {
    read: readRecord,
    write: async (record) => {
      const current = await send('GET');
      if (current.status !== 200) throw new Error(`Kubernetes phase Secret must be platform-created before loader startup (${current.status}): ${current.body}`);
      const old = JSON.parse(current.body) as Secret;
      if (old.metadata?.resourceVersion === undefined) throw new Error('Kubernetes phase Secret has no resourceVersion');
      const payload = { apiVersion: 'v1', kind: 'Secret', metadata: { ...old.metadata, name: SECRET_NAME, namespace, resourceVersion: old.metadata.resourceVersion }, type: 'Opaque', data: { phase: Buffer.from(JSON.stringify(record)).toString('base64') } };
      const response = await send('PUT', payload);
      if (response.status !== 200) throw new Error(`Kubernetes Secret write failed (${response.status}): ${response.body}`);
      const verified = await readRecord();
      if (verified?.phase !== record.phase || verified.status !== record.status) throw new Error('Kubernetes phase Secret read-back did not match the write');
    },
  };
}
