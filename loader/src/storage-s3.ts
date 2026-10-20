/**
 * SeaweedFS S3 access for the platform storage module (ADR-015 S-D1, S-D7).
 *
 * The module holds the Seaweed S3 service credentials and nothing else does.
 * This file signs one request with AWS Signature Version 4 and classifies the
 * answer, so the module can answer "is the store reachable and does it accept
 * these credentials?" without ever repeating a key, a body or a header value.
 * No S3 client library: the module speaks the one request shape it needs.
 */
import { createHash, createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface S3Credentials {
  accessKey: string;
  secretKey: string;
}

/** The SigV4 constants of a static Seaweed identity; Seaweed ignores the region. */
export const S3_SIGNING = {
  region: 'us-east-1',
  service: 's3',
  algorithm: 'AWS4-HMAC-SHA256',
} as const;

const UNRESERVED = /^[A-Za-z0-9._~-]*$/;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}
/** RFC 3986 percent-encoding, the only encoding SigV4 canonicalises against. */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}
/**
 * A path that already is its canonical form. The module builds every path it
 * signs from an opaque bucket and object identifier, so a path that needs
 * encoding is a caller error, never something to sign half-correctly.
 */
function canonicalPath(url: URL): string {
  const path = url.pathname === '' ? '/' : url.pathname;
  for (const segment of path.split('/'))
    if (!UNRESERVED.test(segment))
      throw new Error('a signed S3 path must be canonical: encode it before signing');
  return path;
}
function canonicalQuery(url: URL): string {
  const pairs = [...url.searchParams.entries()].map(
    ([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const
  );
  pairs.sort((left, right) =>
    left[0] === right[0] ? left[1].localeCompare(right[1]) : left[0].localeCompare(right[0])
  );
  return pairs.map(([name, value]) => `${name}=${value}`).join('&');
}
function amzDate(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}
export interface S3SignInput {
  method: string;
  url: URL;
  credentials: S3Credentials;
  now: Date;
  /** Headers to sign besides host, x-amz-content-sha256 and x-amz-date. */
  headers?: Record<string, string>;
  /** The body digest; an empty body hashes to the empty-string digest. */
  payloadHash?: string;
}
/**
 * The header set that makes the request valid: the SigV4 headers plus the
 * Authorization header itself. `host` is carried as the URL's authority.
 */
export function signS3Request(input: S3SignInput): Record<string, string> {
  const payloadHash = input.payloadHash ?? sha256Hex('');
  const stamp = amzDate(input.now);
  const headers: Record<string, string> = {
    ...(input.headers ?? {}),
    host: input.url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': stamp,
  };
  const signed: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers))
    signed[name.toLowerCase()] = value.trim().replace(/\s+/g, ' ');
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((name) => `${name}:${signed[name] ?? ''}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(input.url),
    canonicalQuery(input.url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${stamp.slice(0, 8)}/${S3_SIGNING.region}/${S3_SIGNING.service}/aws4_request`;
  const stringToSign = [S3_SIGNING.algorithm, stamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(
    hmac(
      hmac(hmac(`AWS4${input.credentials.secretKey}`, stamp.slice(0, 8)), S3_SIGNING.region),
      S3_SIGNING.service
    ),
    'aws4_request'
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  const { host: _host, ...sent } = headers;
  return {
    ...sent,
    authorization: `${S3_SIGNING.algorithm} Credential=${input.credentials.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** What one authenticated check of the store found. */
export type S3Check = { ok: true } | { ok: false; code: S3CheckFailure; status: number | null };
export type S3CheckFailure = 'unreachable' | 'auth_denied' | 'bucket_missing' | 'unexpected';

export interface S3TransportResult {
  status: number;
}
export interface BucketCheckOptions {
  /** The S3 endpoint the module may reach, e.g. http://seaweedfs.lifemodel-system.svc:8333 */
  endpoint: string;
  bucket: string;
  credentials: S3Credentials;
  now?: () => Date;
  timeoutMs?: number;
  /** The caller's deadline: an aborted check stops its request and reports unreachable. */
  signal?: AbortSignal;
  /** Tests replace the transport; production talks HTTP to the endpoint. */
  transport?: (
    url: URL,
    headers: Record<string, string>,
    timeoutMs: number,
    signal?: AbortSignal
  ) => Promise<S3TransportResult>;
}
const DEFAULT_TIMEOUT_MS = 5_000;

function classify(status: number): S3Check {
  if (status === 200) return { ok: true };
  // 401 and 403 are both "these credentials are not accepted"; SeaweedFS
  // answers AccessDenied (403) for a missing or wrong signature.
  if (status === 401 || status === 403) return { ok: false, code: 'auth_denied', status };
  // The listing target is the bucket itself: a 404 is the bucket, not an object.
  if (status === 404) return { ok: false, code: 'bucket_missing', status };
  return { ok: false, code: 'unexpected', status };
}
function transportTo(
  url: URL,
  headers: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<S3TransportResult> {
  return new Promise<S3TransportResult>((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    let settled = false;
    const finish = (result: S3TransportResult | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const req = send(
      url,
      { method: 'GET', headers, agent: false, ...(signal ? { signal } : {}) },
      (res) => {
        // The answer's status is the whole result: never read, parse or keep the body.
        res.resume();
        res.on('error', () => {
          finish({ status: res.statusCode ?? 0 });
        });
        res.on('end', () => {
          finish({ status: res.statusCode ?? 0 });
        });
        res.on('close', () => {
          finish({ status: res.statusCode ?? 0 });
        });
      }
    );
    const timer = setTimeout(() => {
      req.destroy(new Error('storage check timed out'));
    }, timeoutMs);
    signal?.addEventListener(
      'abort',
      () => {
        req.destroy(new Error('storage check aborted'));
      },
      { once: true }
    );
    req.on('error', (error) => {
      finish(error instanceof Error ? error : new Error('storage check failed'));
    });
    req.end();
  });
}
/**
 * One authenticated listing of the module's own bucket. 200 means the store is
 * up and accepts the service credentials; every other answer keeps its own
 * reason, so a refused credential never reads as an empty store.
 */
export async function checkS3Bucket(options: BucketCheckOptions): Promise<S3Check> {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:')
    throw new Error('the storage endpoint must be an http or https URL');
  const url = new URL(`/${encodeRfc3986(options.bucket)}`, endpoint);
  url.searchParams.set('list-type', '2');
  url.searchParams.set('max-keys', '1');
  const headers = signS3Request({
    method: 'GET',
    url,
    credentials: options.credentials,
    now: (options.now ?? (() => new Date()))(),
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (options.signal?.aborted) return { ok: false, code: 'unreachable', status: null };
  try {
    const result = await (options.transport ?? transportTo)(
      url,
      headers,
      timeoutMs,
      options.signal
    );
    return classify(result.status);
  } catch {
    return { ok: false, code: 'unreachable', status: null };
  }
}
