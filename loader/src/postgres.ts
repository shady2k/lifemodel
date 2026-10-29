/**
 * Copies the CNPG-generated application login into the two namespaces that use
 * it: the core, storage module and task model gateway (the interim owner
 * login until lifemodel-2t5 leases modules their own identities).
 */
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Agent, request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import type { PlatformPhase } from './platform-bootstrap.js';

export interface KubernetesPostgresSecretOptions {
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

const SOURCE_NAMESPACE = 'lifemodel-state';
const SOURCE_NAME = 'lifemodel-app';
const TARGETS = [
  { namespace: 'lifemodel', name: 'lifemodel-db-credentials' },
  { namespace: 'lifemodel-system', name: 'storage-module-db-credentials' },
  { namespace: 'lifemodel-system', name: 'model-gateway-db-credentials' },
  { namespace: 'lifemodel-system', name: 'model-capture-db-credentials' },
] as const;
const SERVICE_ACCOUNT = '/var/run/secrets/kubernetes.io/serviceaccount';
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

/**
 * A fixed-name API client: it reads the one CNPG Secret and writes only the
 * three platform-created Secrets named above. Each module mounts only its own
 * copy, never the core namespace. Gateway startup/readiness does not await this
 * phase: its optional directory mount refreshes when C supplies the login.
 */
export function createKubernetesPostgresSecretPhase(
  options: KubernetesPostgresSecretOptions = {}
): PlatformPhase {
  return createCredentialPhase(options, false);
}

/** Runs after the legacy credential phases, including on already-onboarded instances. */
export function createKubernetesCaptureSecretPhase(
  options: KubernetesPostgresSecretOptions = {}
): PlatformPhase {
  return createCredentialPhase(options, true);
}

function createCredentialPhase(
  options: KubernetesPostgresSecretOptions,
  captureOnly: boolean
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
        }, timeoutMs);
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
      } catch {
        clearTimeout(timer);
        reject(new Error('Kubernetes API transport failed'));
        return;
      }
      result.then(
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
  }
  let pendingCapturePassword: string | undefined;
  const sourceUrl = new URL(`/api/v1/namespaces/${SOURCE_NAMESPACE}/secrets/${SOURCE_NAME}`, host);
  return {
    name: captureOnly ? 'model-capture-credentials' : 'cnpg-copy-core-credentials',
    run: async () => {
      /** One target: create it when it is absent, else replace its two keys. */
      async function copy(
        target: (typeof TARGETS)[number],
        username: string,
        password: string
      ): Promise<void> {
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
            copied?.['username'] !== username ||
            copied?.['password'] !== password
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
      if (!captureOnly) {
        const source = await send(sourceUrl, 'GET');
        if (source.status !== 200)
          throw new Error(`CNPG application Secret read failed (${String(source.status)})`);
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
        for (const target of TARGETS.slice(0, 3)) await copy(target, username, password);
        return;
      }
      // CNPG owns the narrow capture LOGIN. Its durable random password lives
      // in state; retries and loader restarts reuse it rather than rotate it.
      const captureName = 'lifemodel-capture-credentials';
      const captureUrl = new URL(
        `/api/v1/namespaces/${SOURCE_NAMESPACE}/secrets/${captureName}`,
        host
      );
      let capture = await send(captureUrl, 'GET');
      if (capture.status === 404) {
        pendingCapturePassword ??=
          options.randomPassword?.() ?? randomBytes(32).toString('base64url');
        if (!pendingCapturePassword) throw new Error('capture password unavailable');
        capture = await send(
          new URL(`/api/v1/namespaces/${SOURCE_NAMESPACE}/secrets`, host),
          'POST',
          {
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: {
              name: captureName,
              namespace: SOURCE_NAMESPACE,
              annotations: { 'kustomize.toolkit.fluxcd.io/prune': 'disabled' },
            },
            type: 'kubernetes.io/basic-auth',
            data: {
              username: Buffer.from('lifemodel_capture_writer').toString('base64'),
              password: Buffer.from(pendingCapturePassword).toString('base64'),
            },
          }
        );
        if (capture.status === 409) capture = await send(captureUrl, 'GET');
      }
      if (capture.status !== 200 && capture.status !== 201)
        throw new Error(`capture credential read/create failed (${String(capture.status)})`);
      const captureData = (JSON.parse(capture.body) as { data?: Record<string, string> }).data;
      const captureUsername = captureData?.['username'];
      const capturePassword = captureData?.['password'];
      if (
        !captureUsername ||
        !capturePassword ||
        Buffer.from(captureUsername, 'base64').toString() !== 'lifemodel_capture_writer' ||
        !Buffer.from(capturePassword, 'base64').toString()
      )
        throw new Error('capture credentials unavailable');
      await copy(TARGETS[3], captureUsername, capturePassword);
    },
  };
}
