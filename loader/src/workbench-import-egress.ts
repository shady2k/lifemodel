/**
 * A phase-scoped, additive public-HTTPS permit for workbench OCI import.
 * Kubernetes NetworkPolicy has no DNS hostname allowlist. The importer must
 * separately confine requests and redirects to its fixed origin host allowlist.
 * A killed process can leave this grant enabled until startup disables it.
 */
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';

export interface WorkbenchImportEgress {
  enable(): Promise<void>;
  disable(): Promise<void>;
}
interface ApiResponse {
  status: number;
  body: string;
}
interface EgressOptions {
  apiServer?: string;
  tokenFile?: string;
  caFile?: string;
  /** Test seams use the same deadline, response cap and safe errors. */
  readProjection?: (path: string, signal: AbortSignal) => Promise<Buffer>;
  request?: (
    url: URL,
    method: 'GET' | 'PUT',
    token: string,
    body: string | undefined,
    ca: Buffer,
    signal: AbortSignal
  ) => Promise<ApiResponse>;
}
type ErrorCode =
  | 'egress_config'
  | 'egress_timeout'
  | 'egress_unavailable'
  | 'egress_missing'
  | 'egress_denied'
  | 'egress_conflict'
  | 'egress_invalid_policy'
  | 'egress_response_too_large';
// Deliberately private: callers get only a stable code, never a URL, response,
// token, file path or nested transport cause.
class EgressError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(code);
    this.code = code;
  }
}
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const NAMESPACE = 'lifemodel-system';
const NAME = 'workbench-import-origin-egress';
const PATH = `/apis/networking.k8s.io/v1/namespaces/${NAMESPACE}/networkpolicies/${NAME}`;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;
// Includes the platform's pod/service CIDRs (10.42/16, 10.43/16), RFC1918,
// shared address space, loopback, metadata/link-local and non-public ranges.
const NON_PUBLIC_IPV4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new EgressError('egress_invalid_policy');
  return value as JsonObject;
}

function send(
  url: URL,
  method: 'GET' | 'PUT',
  token: string,
  body: string | undefined,
  ca: Buffer,
  signal: AbortSignal
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (code: ErrorCode = 'egress_unavailable'): void => {
      if (settled) return;
      settled = true;
      reject(new EgressError(code));
      req.destroy();
    };
    const req = httpsRequest(
      url,
      {
        method,
        ca,
        signal,
        // Each method is short-lived. Do not leave credentials or idle sockets
        // in a pool that would require a third public lifecycle method.
        agent: false,
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
        res.on('error', () => {
          fail();
        });
        res.on('aborted', () => {
          fail();
        });
        res.on('close', () => {
          if (!res.complete) fail();
        });
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            fail('egress_response_too_large');
            res.destroy();
          } else chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    req.on('error', () => {
      fail();
    });
    // Retain a guard through destruction, including late TLS socket errors.
    req.on('socket', (socket) => socket.on('error', () => undefined));
    req.end(body);
  });
}

export function createWorkbenchImportEgress(options: EgressOptions = {}): WorkbenchImportEgress {
  let url: URL;
  try {
    const base = new URL(
      options.apiServer ??
        `https://${process.env['KUBERNETES_SERVICE_HOST'] ?? 'kubernetes.default.svc'}:${process.env['KUBERNETES_SERVICE_PORT_HTTPS'] ?? '443'}`
    );
    if (
      base.protocol !== 'https:' ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== '/'
    )
      throw new Error();
    url = new URL(PATH, base);
  } catch {
    throw new EgressError('egress_config');
  }
  const readProjection = options.readProjection ?? ((path, signal) => readFile(path, { signal }));
  const request = options.request ?? send;

  async function change(enabled: boolean): Promise<void> {
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new EgressError('egress_timeout'));
        controller.abort();
      }, TIMEOUT_MS);
    });
    async function call(method: 'GET' | 'PUT', payload?: unknown): Promise<ApiResponse> {
      signal.throwIfAborted();
      // Reread projected credentials at each use, including the PUT after GET.
      const [tokenBytes, ca] = await Promise.all([
        readProjection(options.tokenFile ?? `${SA}/token`, signal),
        readProjection(options.caFile ?? `${SA}/ca.crt`, signal),
      ]);
      signal.throwIfAborted();
      const token = tokenBytes.toString('utf8').trim();
      if (!token || token.length > 16_384 || /\s/.test(token) || !ca.length)
        throw new EgressError('egress_unavailable');
      const body = payload === undefined ? undefined : JSON.stringify(payload);
      const response = await request(url, method, token, body, ca, signal);
      signal.throwIfAborted();
      if (Buffer.byteLength(response.body) > MAX_RESPONSE_BYTES)
        throw new EgressError('egress_response_too_large');
      if (response.status === 404) throw new EgressError('egress_missing');
      if (response.status === 401 || response.status === 403)
        throw new EgressError('egress_denied');
      if (response.status === 409) throw new EgressError('egress_conflict');
      if (response.status !== 200) throw new EgressError('egress_unavailable');
      return response;
    }
    const work = async (): Promise<void> => {
      const previous = await call('GET');
      let policy: JsonObject;
      try {
        policy = object(JSON.parse(previous.body));
      } catch {
        throw new EgressError('egress_invalid_policy');
      }
      const metadata = object(policy['metadata']);
      if (
        policy['apiVersion'] !== 'networking.k8s.io/v1' ||
        policy['kind'] !== 'NetworkPolicy' ||
        metadata['name'] !== NAME ||
        metadata['namespace'] !== NAMESPACE ||
        typeof metadata['resourceVersion'] !== 'string' ||
        !metadata['resourceVersion'] ||
        metadata['deletionTimestamp'] != null
      )
        throw new EgressError('egress_invalid_policy');
      await call('PUT', {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        // Preserve Flux's labels and annotations; keep the resourceVersion
        // supplied by this GET, never create a missing resource or retry a CAS.
        metadata,
        spec: {
          podSelector: { matchLabels: { 'app.kubernetes.io/name': 'loader' } },
          policyTypes: ['Egress'],
          egress: enabled
            ? [
                {
                  to: [{ ipBlock: { cidr: '0.0.0.0/0', except: [...NON_PUBLIC_IPV4] } }],
                  ports: [{ protocol: 'TCP', port: 443 }],
                },
              ]
            : [],
        },
      });
    };
    try {
      await Promise.race([deadline, work()]);
    } catch (error) {
      if (error instanceof EgressError) throw error;
      throw new EgressError('egress_unavailable');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  return { enable: () => change(true), disable: () => change(false) };
}
