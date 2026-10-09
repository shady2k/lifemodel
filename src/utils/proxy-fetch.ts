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

import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * The AbortSignal a caller may hand over, structurally. grammY's node shim
 * builds its per-call signal from the `abort-controller` POLYFILL, so a
 * signal reaching this transport is not necessarily
 * `instanceof globalThis.AbortSignal` - Node's own fetch refuses such an
 * object before any request is made. Anything with the abort interface is
 * accepted and, when not native, BRIDGED into a native controller (see
 * `bridgeSignal`).
 */
interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

function isAbortSignalLike(value: unknown): value is AbortSignalLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AbortSignalLike>;
  return (
    typeof candidate.aborted === 'boolean' &&
    typeof candidate.addEventListener === 'function' &&
    typeof candidate.removeEventListener === 'function'
  );
}

function isNativeAbortSignal(signal: AbortSignalLike): boolean {
  return typeof AbortSignal === 'function' && signal instanceof AbortSignal;
}

/** The abort reason a signal carries, when it carries one. */
function abortReasonOf(signal: AbortSignalLike): unknown {
  return (signal as { reason?: unknown }).reason;
}

/** The caller's signal, structurally, or null. */
function signalOf(init: RequestInit | undefined): AbortSignalLike | null {
  const signal = init?.signal;
  return isAbortSignalLike(signal) ? signal : null;
}

interface SignalBridge {
  signal: AbortSignal;
  /** Detaches the bridge listener; call it when the work settles. */
  dispose(): void;
}

/**
 * Bridge a structurally-compatible signal into a native controller, so the
 * native branches of Node's fetch accept it: abort and abort REASON travel
 * across, and `dispose` removes the listener so the caller's signal does not
 * outlive the request with a dangling callback.
 */
function bridgeSignal(signal: AbortSignalLike): SignalBridge {
  const controller = new AbortController();
  const abort = (): void => {
    signal.removeEventListener('abort', abort);
    controller.abort(abortReasonOf(signal));
  };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort);
  return {
    signal: controller.signal,
    dispose(): void {
      signal.removeEventListener('abort', abort);
    },
  };
}

/**
 * A Response whose body settlement disposes the given hook. Used when a
 * bridge stands behind a native response: the bridge listener must live
 * until the body is consumed (an abort DURING response consumption must
 * still cancel the read), not just until the headers arrived.
 */
function responseWithDisposeHook(response: Response, dispose: () => void): Response {
  const body = response.body;
  if (body === null) {
    dispose();
    return response;
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        reader ??= body.getReader();
        const { done, value } = await reader.read();
        if (done) {
          dispose();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        dispose();
        controller.error(error);
      }
    },
    cancel(reason) {
      dispose();
      return reader === null ? body.cancel(reason) : reader.cancel(reason);
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * The native branches: globalThis.fetch, with a structurally-compatible but
 * non-native signal first bridged into a native controller (Node's fetch
 * refuses the polyfill's signal outright).
 */
async function nativeFetch(
  input: Request | string | URL,
  init: RequestInit | undefined,
  signal: AbortSignalLike | null
): Promise<Response> {
  if (signal === null || isNativeAbortSignal(signal)) return globalThis.fetch(input, init);
  const bridge = bridgeSignal(signal);
  const initWithSignal: RequestInit = { ...(init ?? {}), signal: bridge.signal };
  try {
    const response = await globalThis.fetch(input, initWithSignal);
    return responseWithDisposeHook(response, () => {
      bridge.dispose();
    });
  } catch (error) {
    bridge.dispose();
    throw error;
  }
}

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
      if (value !== undefined) out[key.toLowerCase()] = value;
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
    return {
      buffer: Buffer.from(body.buffer, body.byteOffset, body.byteLength),
      contentType: undefined,
    };
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
/**
 * The pinned agents of the forward-proxy hop (kept alive at most for the
 * requests that share them; keepAlive is off, so each hop tears its socket
 * down).
 */
const pinnedHttpAgent = new HttpAgent({ keepAlive: false });
const pinnedHttpsAgent = new HttpsAgent({ keepAlive: false });

function sendThroughProxy(
  target: URL,
  proxy: URL,
  method: string,
  headers: HeaderRecord,
  body: Buffer | undefined,
  signal: AbortSignalLike | null
): Promise<IncomingMessage> {
  const isTlsProxy = proxy.protocol === 'https:';
  const request = isTlsProxy ? httpsRequest : httpRequest;
  // A PINNED agent, not the default one: with NODE_USE_ENV_PROXY=1 the
  // default agent of node:http is itself an env-proxy agent, which would
  // re-route this hop (whose path is already absolute-form) and reject a
  // Host header that names the target, not the proxy. One place decides the
  // hops: this transport, not the agent's environment.
  const agent = isTlsProxy ? pinnedHttpsAgent : pinnedHttpAgent;
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
        path: target.toString(),
        headers: outgoingHeaders,
        agent,
      },
      (res) => {
        resolve(res);
      }
    );
    req.on('error', reject);
    if (signal !== null) {
      // The caller's abort carries over, with its reason when the signal
      // carries one (the polyfill's carries none).
      const reason = abortReasonOf(signal);
      const abort = (): void => {
        const abortError =
          reason instanceof Error
            ? reason
            : Object.assign(new Error('The request through the proxy was aborted'), {
                cause: reason,
              });
        req.destroy(abortError);
      };
      signal.addEventListener('abort', abort, { once: true });
      // once:true removes the listener when abort fires; when the work
      // settles without an abort, the response stream's end or close (and
      // the request's own close) removes it, so nothing dangles.
      const settle = (): void => {
        signal.removeEventListener('abort', abort);
      };
      req.on('close', settle);
      req.on('error', settle);
      req.on('response', (incoming: IncomingMessage) => {
        incoming.on('end', settle);
        incoming.on('close', settle);
      });
      if (signal.aborted) {
        abort();
      }
    }
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

function webResponseFrom(res: IncomingMessage): Response {
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
          // The stream may already be closed when the underlying response is
          // disposed (a redirect's intermediate body is canceled) - NOTHING
          // may throw out of these callbacks, so the controller is guarded.
          const guard = (work: () => void): void => {
            try {
              work();
            } catch {
              // The controller is already closed or errored: nothing left to do.
            }
          };
          res.on('data', (chunk: Buffer) => {
            guard(() => { controller.enqueue(new Uint8Array(chunk)); });
          });
          res.on('end', () => { guard(() => { controller.close(); }); });
          res.on('close', () => { guard(() => { controller.close(); }); });
          res.on('error', (error) => { guard(() => { controller.error(error); }); });
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
  // Any proxy in the environment routes the call through `proxiedRequest`,
  // which re-evaluates the route on every hop and so follows a redirect
  // across the http/https protocol boundary correctly. Without a proxy the
  // call passes through untouched.
  if (input instanceof Request) {
    const target = new URL(input.url);
    const proxy = proxyFor(target);
    if (proxy === null) {
      const signal = signalOf(init) ?? (isAbortSignalLike(input.signal) ? input.signal : null);
      return nativeFetch(input, init, signal);
    }
    const fromInit = signalOf(init);
    return proxiedRequest({
      target,
      method: (init?.method ?? input.method).toUpperCase(),
      headers: headerRecordOf({ headers: input.headers, ...init }),
      body: init?.body ?? (input.body === null ? null : await input.arrayBuffer()),
      signal: fromInit ?? (isAbortSignalLike(input.signal) ? input.signal : null),
    });
  }
  const target = new URL(input instanceof URL ? input.toString() : input);
  const proxy = proxyFor(target);
  if (proxy === null) {
    return nativeFetch(input, init, signalOf(init));
  }
  return proxiedRequest({
    target,
    method: (init?.method ?? 'GET').toUpperCase(),
    headers: headerRecordOf(init),
    body: init?.body,
    signal: signalOf(init),
  });
};

async function proxiedRequest(args: {
  target: URL;
  method: string;
  headers: HeaderRecord;
  body: unknown;
  signal: AbortSignalLike | null;
}): Promise<Response> {
  // One hop at a time, with the ROUTE RE-EVALUATED on every hop: a redirect
  // may cross protocols (an http:// endpoint answering 307/308 with an
  // https:// location), and the vault's forward path only serves absolute-
  // form http:// requests - an https hop must switch to the native
  // CONNECT/MITM path (or go direct when no proxy covers it), and the other
  // way round.
  let { target } = args;
  let method = args.method;
  let body: unknown = args.body;
  let headers = args.headers;
  const signal = args.signal;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (hop === MAX_REDIRECTS) {
      throw new Error(
        `Too many redirects through the proxy: more than ${String(MAX_REDIRECTS)} hops`
      );
    }
    const proxy = proxyFor(target);
    const response =
      proxy === null || target.protocol === 'https:'
        ? await nativeHop(target, method, headers, body, signal)
        : await forwardProxyHop(target, proxy, method, headers, body, signal);
    const next = redirectOf(response, target, method, body, headers);
    if (next === null) return response;
    // The intermediate response is never handed to the caller: close its
    // body so no socket leaks behind the redirect.
    await response.body?.cancel().catch(() => undefined);
    target = next.target;
    method = next.method;
    body = next.body;
    headers = next.headers;
  }
  throw new Error('unreachable');
}

/** One hop through Node's own fetch: the CONNECT/MITM tunnel, or direct. */
async function nativeHop(
  target: URL,
  method: string,
  headers: HeaderRecord,
  body: unknown,
  signal: AbortSignalLike | null
): Promise<Response> {
  const serialized = await serializeBody(body);
  const outgoing: HeaderRecord = { ...headers };
  if (serialized.contentType !== undefined && outgoing['content-type'] === undefined) {
    outgoing['content-type'] = serialized.contentType;
  }
  const init: RequestInit = {
    method,
    headers: outgoing,
    body: serialized.buffer ? new Uint8Array(serialized.buffer) : null,
    redirect: 'manual',
  };
  return nativeFetch(target, init, signal);
}

/** One hop through the forward proxy: an absolute-form request TO the proxy. */
async function forwardProxyHop(
  target: URL,
  proxy: URL,
  method: string,
  headers: HeaderRecord,
  body: unknown,
  signal: AbortSignalLike | null
): Promise<Response> {
  const serialized = await serializeBody(body);
  const outgoing: HeaderRecord = { ...headers };
  if (serialized.contentType !== undefined && outgoing['content-type'] === undefined) {
    outgoing['content-type'] = serialized.contentType;
  }
  delete outgoing['content-length'];
  const res = await sendThroughProxy(target, proxy, method, outgoing, serialized.buffer, signal);
  return webResponseFrom(res);
}

/** The next hop a redirect asks for, or null when this response is final. */
function redirectOf(
  response: Response,
  target: URL,
  method: string,
  body: unknown,
  headers: HeaderRecord
): { target: URL; method: string; body: unknown; headers: HeaderRecord } | null {
  const location = response.headers.get('location');
  if (location === null) return null;
  const nextTarget = new URL(location, target);
  if (response.status === 301 || response.status === 302 || response.status === 303) {
    // A GET redirect carries no request body and none of its headers.
    return { target: nextTarget, method: 'GET', body: undefined, headers: {} };
  }
  if (response.status === 307 || response.status === 308) {
    // Same method, body and headers - only the address changed.
    return { target: nextTarget, method, body, headers };
  }
  return null;
}
