/**
 * The product's own outbound HTTP through the environment's proxy - in ONE
 * place, for the model provider and the Telegram channel alike
 * (lifemodel-q4x.3.2 review finding 3).
 *
 * Node's fetch honours the proxy environment (HTTPS_PROXY/HTTP_PROXY with
 * NODE_USE_ENV_PROXY=1) by TUNNELLING every target through CONNECT, including
 * plain `http://` ones, whose tunnel body is plaintext. A TLS-expecting
 * CONNECT handler (Agent Vault 0.40.0's) refuses that, so an OpenAI-compatible
 * endpoint on a plain-HTTP address could never serve lifemodel: native Node
 * fetch failed with `UND_ERR_SOCKET` while curl, which sends an absolute-form
 * request TO the proxy for an http target, reached the same endpoint and got
 * the key injected.
 *
 * This module gives the product's own clients curl's path:
 *
 * - an `http://` target with a configured proxy: an absolute-form request to
 *   the proxy over node:http, with `Proxy-Authorization` from the proxy's own
 *   credential - the vault's forward-proxy path, which answers the upstream
 *   itself and injects keys on the way;
 * - an `https://` target with a configured proxy: Node's own fetch, which
 *   tunnels CONNECT and validates the re-signed certificate against
 *   NODE_EXTRA_CA_CERTS - the MITM path, unchanged;
 * - no proxy for the target (unset, or NO_PROXY): Node's own fetch, direct.
 *
 * It does NO other work - no tool-schema repair, no body rewriting, no
 * retries: those belong to the wrappers that call it.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomBytes } from 'node:crypto';

/** How many redirect hops a proxied request may follow (undici's own bound). */
const MAX_REDIRECTS = 5;

/** One header record the node request builders accept directly. */
type HeaderRecord = Record<string, string>;

function proxyEnvironment(protocol: string): string | null {
  if (protocol === 'https:') {
    return process.env['HTTPS_PROXY'] ?? process.env['https_proxy'] ?? null;
  }
  if (protocol === 'http:') {
    return process.env['HTTP_PROXY'] ?? process.env['http_proxy'] ?? null;
  }
  return null;
}

/**
 * Whether NO_PROXY excludes this target. An entry may name a host (`lo`-style
 * bare or a domain suffix) or `host:port`; `*` excludes everything.
 */
function excludedByNoProxy(target: URL): boolean {
  const list = process.env['NO_PROXY'] ?? process.env['no_proxy'] ?? '';
  if (list.trim() === '*') return true;
  const host = target.hostname.toLowerCase();
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  for (const rawEntry of list.split(',')) {
    const entry = rawEntry.trim().toLowerCase();
    if (entry === '') continue;
    let entryPort: string | null = null;
    let bare = entry;
    const colon = entry.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(entry.slice(colon + 1))) {
      entryPort = entry.slice(colon + 1);
      bare = entry.slice(0, colon);
    }
    if (entryPort !== null && entryPort !== port) continue;
    if (host === bare) return true;
    if (host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/** The proxy a target must leave through, or null when it leaves directly. */
function proxyFor(target: URL): URL | null {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
  if (excludedByNoProxy(target)) return null;
  const value = proxyEnvironment(target.protocol);
  if (value === null || value.trim() === '') return null;
  try {
    return new URL(value);
  } catch {
    // A malformed proxy value is not silently ignored: the caller asked to
    // route through it, and "no proxy" would mean a direct attempt the kernel
    // rule refuses - explain instead.
    throw new TypeError(`The proxy environment carries a malformed URL: ${value}`);
  }
}

function headerRecordOf(init: RequestInit | undefined): HeaderRecord {
  const out: HeaderRecord = {};
  const headers = init?.headers;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      out[key.toLowerCase()] = value;
    }
  } else if (headers !== undefined) {
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) out[key.toLowerCase()] = String(value);
    }
  }
  return out;
}

interface SerializedBody {
  buffer: Buffer | undefined;
  contentType: string | undefined;
}

/**
 * The body a node request can send. The callers of this fetch send strings
 * (JSON payloads), URLSearchParams, binary bodies and FormData (grammy's file
 * uploads); a ReadableStream body has no caller and is refused with its name.
 */
async function serializeBody(body: unknown): Promise<SerializedBody> {
  if (body === null || body === undefined) return { buffer: undefined, contentType: undefined };
  if (typeof body === 'string') {
    return { buffer: Buffer.from(body, 'utf-8'), contentType: undefined };
  }
  if (body instanceof URLSearchParams) {
    return {
      buffer: Buffer.from(body.toString(), 'utf-8'),
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    };
  }
  if (body instanceof ArrayBuffer) {
    return { buffer: Buffer.from(body), contentType: undefined };
  }
  if (ArrayBuffer.isView(body)) {
    return { buffer: Buffer.from(body.buffer, body.byteOffset, body.byteLength), contentType: undefined };
  }
  if (body instanceof FormData) {
    const boundary = `proxy-fetch-${randomBytes(12).toString('hex')}`;
    const parts: Buffer[] = [];
    for (const [name, value] of body.entries()) {
      if (typeof value === 'string') {
        parts.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
          )
        );
      } else {
        const filename = (value.name ?? 'blob').replace(/[\r\n"]/g, '_');
        const type = value.type || 'application/octet-stream';
        parts.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`
          ),
          Buffer.from(await value.arrayBuffer()),
          Buffer.from('\r\n')
        );
      }
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return {
      buffer: Buffer.concat(parts),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }
  throw new TypeError(`The proxy fetch carries a ${describeBodyKind(body)} body it cannot send`);
}

function describeBodyKind(body: unknown): string {
  const kind = typeof body;
  if (kind === 'object' && body !== null) return (body as object).constructor?.name ?? 'object';
  return kind;
}

/**
 * One request TO the proxy, absolute-form, the standard forward-proxy path.
 * Resolves with the raw response to be turned into a web Response.
 */
function sendThroughProxy(
  target: URL,
  proxy: URL,
  method: string,
  headers: HeaderRecord,
  body: Buffer | undefined,
  signal: AbortSignal | null
): Promise<import('node:http').IncomingMessage> {
  const isTlsProxy = proxy.protocol === 'https:';
  const request = isTlsProxy ? httpsRequest : httpRequest;
  const proxyAuthorization =
    proxy.username !== ''
      ? `Basic ${Buffer.from(
          `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
        ).toString('base64')}`
      : undefined;

  const outgoingHeaders: HeaderRecord = {
    ...headers,
    host: target.host,
    ...(proxyAuthorization !== undefined && { 'proxy-authorization': proxyAuthorization }),
    ...(body !== undefined && { 'content-length': String(body.length) }),
  };

  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: proxy.hostname,
        port: proxy.port === '' ? (isTlsProxy ? 443 : 80) : Number(proxy.port),
        method,
        path: `${target.toString()}`,
        headers: outgoingHeaders,
      },
      (res) => resolve(res)
    );
    req.on('error', reject);
    if (signal !== null) {
      const abort = (): void => {
        req.destroy(new Error('The request through the proxy was aborted'));
      };
      if (signal.aborted) {
        abort();
      } else {
        signal.addEventListener('abort', abort, { once: true });
      }
    }
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

function webResponseFrom(res: import('node:http').IncomingMessage): Response {
  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) responseHeaders.append(key, item);
    } else {
      responseHeaders.set(key, value);
    }
  }
  const status = res.statusCode ?? 500;
  // A bodyless status must be constructed without a stream.
  const hasBody = status !== 204 && status !== 304 && status >= 200;
  const stream = hasBody
    ? new ReadableStream<Uint8Array>({
        start(controller) {
          res.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
          res.on('end', () => controller.close());
          res.on('error', (error) => controller.error(error));
        },
        cancel() {
          res.destroy();
        },
      })
    : null;
  return new Response(stream, {
    status,
    statusText: res.statusMessage ?? '',
    headers: responseHeaders,
  });
}

/**
 * The proxy fetch: the same signature `fetch` has, so it stands in for Node's
 * own everywhere the product asks an outside service over HTTP(S).
 */
export const proxyFetch: typeof fetch = async (input, init) => {
  // The direct branches pass the call through untouched; the proxy branch
  // needs a Request object's parts spelled out.
  if (input instanceof Request) {
    const target = new URL(input.url);
    const proxy = proxyFor(target);
    if (proxy === null || target.protocol === 'https:') {
      return globalThis.fetch(input, init);
    }
    return proxiedRequest({
      target,
      proxy,
      method: (init?.method ?? input.method).toUpperCase(),
      headers: headerRecordOf({ headers: input.headers, ...init }),
      body: init?.body ?? (input.body === null ? null : await input.arrayBuffer()),
      signal: init?.signal instanceof AbortSignal ? init.signal : input.signal,
    });
  }
  const target = new URL(input instanceof URL ? input.toString() : String(input));
  const proxy = proxyFor(target);
  if (proxy === null || target.protocol === 'https:') {
    // Direct, or the MITM tunnel through Node's own fetch (which tunnels
    // CONNECT and validates the re-signed certificate against
    // NODE_EXTRA_CA_CERTS).
    return globalThis.fetch(input, init);
  }
  return proxiedRequest({
    target,
    proxy,
    method: (init?.method ?? 'GET').toUpperCase(),
    headers: headerRecordOf(init),
    body: init?.body,
    signal: init?.signal instanceof AbortSignal ? init.signal : null,
  });
};

async function proxiedRequest(args: {
  target: URL;
  proxy: URL;
  method: string;
  headers: HeaderRecord;
  body: unknown;
  signal: AbortSignal | null;
}): Promise<Response> {
  // The forward-proxy path, one hop at a time with redirects followed.
  let { target } = args;
  const { proxy } = args;
  let method = args.method;
  let body: unknown = args.body;
  let headers = args.headers;
  const signal = args.signal;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (hop === MAX_REDIRECTS) {
      throw new Error(`Too many redirects through the proxy: more than ${String(MAX_REDIRECTS)} hops`);
    }
    const serialized = await serializeBody(body);
    const contentType = serialized.contentType;
    const outgoing: HeaderRecord = { ...headers };
    if (contentType !== undefined && outgoing['content-type'] === undefined) {
      outgoing['content-type'] = contentType;
    }
    for (const name of Object.keys(outgoing)) {
      if (name === 'content-length') delete outgoing[name];
    }
    const res = await sendThroughProxy(target, proxy, method, outgoing, serialized.buffer, signal);
    if (
      (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303) &&
      typeof res.headers.location === 'string'
    ) {
      target = new URL(res.headers.location, target);
      method = 'GET';
      body = undefined;
      headers = {}; // a GET redirect carries no request body's headers
      continue;
    }
    if (
      (res.statusCode === 307 || res.statusCode === 308) &&
      typeof res.headers.location === 'string'
    ) {
      target = new URL(res.headers.location, target);
      continue; // same method and body, same headers
    }
    return webResponseFrom(res);
  }
  throw new Error('unreachable');
}
