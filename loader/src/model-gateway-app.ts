/** Platform-owned model gateway. Only bounded, scrubbed JSON error fields leave upstream failures. */
import {
  createServer,
  Agent as HttpAgent,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { once } from 'node:events';
import { TLSSocket } from 'node:tls';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  renderAttemptHeaders,
  resolveModelDestination,
  SESSION_HEADER,
  SESSION_PLACEHOLDER,
  slotIdentity,
  validSessionId,
  type ModelSlot,
  type ModelSlotName,
  type SlotIdentity,
  type SlotRead,
} from './model.js';
import { modelEndpointUrl } from './model-url.js';
import type { CaptureInput, ExchangeCapture } from './model-exchange-capture.js';
import { SlotStorageUnavailableError } from './model-bao.js';
import { readModelErrorExcerpt } from './model-error-excerpt.js';
import type { LoaderLogger } from './logger.js';
import {
  badResponse,
  GatewayError,
  TaskAuthorizationError,
  MAX_BODY,
  parseSafe,
  record,
  serializeSafe,
  SafeEventStream,
  validateResponse,
} from './model-gateway-response.js';

export const GATEWAY_LIMITS = {
  connect: 5_000,
  firstByte: 45_000,
  overall: 110_000,
  idle: 30_000,
} as const;
/**
 * A `/status` answer may re-read the failing slots' versions, bounded and no
 * more often than this (ADR-013 D6). The answer itself never waits past `bound`.
 */
export const STATUS_RECHECK = { bound: 1_000, cache: 5_000 } as const;
interface Timeouts {
  connect?: number;
  firstByte?: number;
  overall?: number;
  idle?: number;
}
export interface GatewayOptions {
  slots: {
    read(slot: ModelSlotName): Promise<SlotRead>;
    /** The slot's identity read afresh, for the stale-outage re-check. */
    identity(slot: ModelSlotName): Promise<SlotIdentity>;
    invalidate(slot: ModelSlotName): void;
    keys(): readonly string[];
  };
  logger: LoaderLogger;
  capture?: ExchangeCapture;
  timeouts?: Timeouts;
  /** The stale-outage re-check's bounds; tests narrow them. */
  recheck?: { bound?: number; cache?: number };
  timers?: { set: typeof setTimeout; clear: typeof clearTimeout };
  resolveHost?: (hostname: string) => Promise<string[]>;
  tlsCa?: string | Buffer;
}
/** The header names the gateway owns: a slot's own header may never set one. */
const GATEWAY_HEADERS = ['host', 'content-type', 'accept', 'authorization', 'content-length'];
/** Drop every casing of one header name: two casings would arrive upstream twice. */
function dropHeader(headers: Record<string, string>, name: string): void {
  for (const key of Object.keys(headers))
    if (key.toLowerCase() === name) Reflect.deleteProperty(headers, key);
}
/** Set one of the gateway's own headers over the slot's, whatever casing it used. */
function setOwnHeader(headers: Record<string, string>, name: string, value: string): void {
  dropHeader(headers, name);
  headers[name] = value;
}
interface SlotHealth {
  lastErrorCode: string | null;
  lastErrorAt: string | null;
}
/** A slot changed when its version moved, appeared or vanished. */
function sameIdentity(before: SlotIdentity, after: SlotIdentity): boolean {
  if (before === 'absent' || after === 'absent') return before === after;
  return before.version === after.version;
}
interface Health {
  state: 'unknown' | 'ok' | 'down';
  outageSince: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  primary: SlotHealth;
  reserve: SlotHealth;
}
function safeError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  if (error instanceof SlotStorageUnavailableError) return new GatewayError('storage_unavailable');
  return new GatewayError('unreachable');
}
/** Preserve a received rejection's status when its body read hits the deadline.
 * The cause stays timeout, but replacing this error with signal.reason would
 * erase the actual upstream 5xx needed for diagnosis and route attribution.
 */
function requestFailure(error: unknown, signal: AbortSignal): GatewayError {
  return safeError(
    error instanceof GatewayError && error.upstreamStatus !== undefined
      ? error
      : signal.aborted
        ? signal.reason
        : error
  );
}
function ownedError(res: ServerResponse, error: GatewayError, slot?: ModelSlotName): void {
  const body = JSON.stringify({
    error: {
      type: 'gateway_error',
      code: error.code,
      ...(error.errorExcerpt ? { message: error.errorExcerpt } : {}),
    },
  });
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.end(`data: ${body}\n\n`);
    return;
  }
  res.writeHead(error.status, {
    'content-type': 'application/json',
    ...(slot ? { 'x-lifemodel-slot': slot } : {}),
  });
  res.end(body);
}
function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new GatewayError('timeout'));
    };
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}
async function readBody(req: IncomingMessage, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    function cleanup(): void {
      req.pause();
      req.removeListener('data', data);
      req.removeListener('end', end);
      req.removeListener('error', error);
      signal.removeEventListener('abort', abort);
    }
    function error(): void {
      cleanup();
      reject(new GatewayError('invalid_request', 400));
    }
    function abort(): void {
      cleanup();
      reject(new GatewayError('timeout'));
    }
    function data(chunk: Buffer): void {
      size += chunk.length;
      if (size > MAX_BODY) {
        cleanup();
        reject(new GatewayError('request_too_large', 413));
        return;
      }
      chunks.push(chunk);
    }
    function end(): void {
      cleanup();
      try {
        resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        reject(new GatewayError('invalid_request', 400));
      }
    }
    req.on('data', data);
    req.once('end', end);
    req.once('error', error);
    signal.addEventListener('abort', abort, { once: true });
  });
}
function returnHeaders(
  upstream: IncomingMessage,
  slot: ModelSlotName,
  stream: boolean,
  keys: readonly string[]
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': stream ? 'text/event-stream' : 'application/json',
    'x-lifemodel-slot': slot,
  };
  const retry = upstream.headers['retry-after'];
  if (
    typeof retry === 'string' &&
    /^\d{1,6}$/.test(retry) &&
    !keys.some((key) => retry.includes(key))
  )
    headers['retry-after'] = retry;
  return headers;
}
export function createModelGateway(options: GatewayOptions) {
  const httpAgent = new HttpAgent({
    keepAlive: true,
    maxSockets: 16,
    maxTotalSockets: 16,
    maxFreeSockets: 2,
  });
  const httpsAgent = new HttpsAgent({
    keepAlive: true,
    maxSockets: 16,
    maxTotalSockets: 16,
    maxFreeSockets: 2,
  });
  httpAgent.on('error', () => undefined);
  httpsAgent.on('error', () => undefined);
  const sockets = new WeakSet<object>();
  const limits = { ...GATEWAY_LIMITS, ...options.timeouts };
  const recheck = { ...STATUS_RECHECK, ...options.recheck };
  const { set: schedule, clear: cancel } = options.timers ?? {
    set: setTimeout,
    clear: clearTimeout,
  };
  const health: Health = {
    state: 'unknown',
    outageSince: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastErrorCode: null,
    primary: { lastErrorCode: null, lastErrorAt: null },
    reserve: { lastErrorCode: null, lastErrorAt: null },
  };
  /**
   * The identity each slot's recorded failure names: the KV version its read
   * returned, or its absence. Never part of the `/status` body.
   */
  const identities: Record<ModelSlotName, SlotIdentity | undefined> = {
    primary: undefined,
    reserve: undefined,
  };
  const slotNames: readonly ModelSlotName[] = ['primary', 'reserve'];
  const failureRevisions: Record<ModelSlotName, number> = { primary: 0, reserve: 0 };
  let outcomeRevision = 0;
  let activeRequests = 0;
  // Optional absence is a recovery candidate, never a slot failure.
  let reserveAbsent = false;
  let recheckedAt = 0;
  let rechecking: Promise<void> | undefined;

  const failingSlots = (): ModelSlotName[] =>
    slotNames.filter((name) => health[name].lastErrorCode !== null);

  /**
   * The upstream header set: the slot's own headers first, in the owner's
   * order, each already rendered with the caller's session; the gateway's own
   * host, content type, accept, authorization and content length are then set
   * over them, so a custom header can never replace one of those. A value that
   * had to fall back to this process's own id is named once per slot
   * configuration in one log line, never with its value (ADR-013, the
   * custom-headers amendment).
   */
  function upstreamHeaders(
    slot: ModelSlot,
    custom: Record<string, string>,
    session: { id: string; callerNamed: boolean },
    slotName: ModelSlotName,
    target: { host: string; stream: boolean; contentLength: number | undefined }
  ): Record<string, string> {
    const fellBack = session.callerNamed
      ? []
      : (slot.headers ?? [])
          .filter((header) => header.value.includes(SESSION_PLACEHOLDER))
          .map((header) => header.name);
    const own = new Map<string, string>([
      ['host', target.host],
      ['content-type', 'application/json'],
      ['accept', target.stream ? 'text/event-stream' : 'application/json'],
    ]);
    if (slot.key) own.set('authorization', `Bearer ${slot.key}`);
    if (target.contentLength !== undefined) own.set('content-length', String(target.contentLength));
    // A name the gateway sets for this request wins in any casing a slot used;
    // one it does not set (authorization without a key, content-length on a GET)
    // is dropped from the slot's own list, so it cannot become the gateway's.
    for (const name of GATEWAY_HEADERS) {
      const value = own.get(name);
      if (value === undefined) dropHeader(custom, name);
      else setOwnHeader(custom, name, value);
    }
    if (fellBack.length > 0) {
      const signature = `${slotName}:${fellBack.join(',')}`;
      if (!fallbackLogged.has(signature)) {
        fallbackLogged.add(signature);
        options.logger.warn(
          { headers: fellBack },
          'Model gateway filled the session placeholder with its own process id'
        );
      }
    }
    return custom;
  }

  /** Bound each caller's wait, not the lifetime of the shared Bao read batch. */
  function within(promise: Promise<void>): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = schedule(resolve, recheck.bound);
      void promise.finally(() => {
        cancel(timer);
        resolve();
      });
    });
  }

  async function recheckOutage(): Promise<void> {
    if (health.state !== 'down') return;
    const revision = outcomeRevision;
    const deadline = Date.now() + recheck.bound;
    const candidate = reserveAbsent;
    const observed = slotNames.map((name) => ({
      name,
      identity: identities[name],
      revision: failureRevisions[name],
      failing: health[name].lastErrorCode !== null,
    }));
    const current = await Promise.all(
      observed.map(async ({ name, identity, failing }) => {
        // A storage error has no identity. Skip it, not the other slots.
        if (!(failing && identity !== undefined) && !(name === 'reserve' && candidate))
          return undefined;
        return options.slots.identity(name).catch(() => undefined);
      })
    );
    // Late results are discarded, but the single-flight handle lived until now.
    if (Date.now() >= deadline || health.state !== 'down') return;
    let reserveAppeared = false;
    for (const [index, before] of observed.entries()) {
      const after = current[index];
      if (after === undefined || failureRevisions[before.name] !== before.revision) continue;
      if (
        before.failing &&
        before.identity !== undefined &&
        !sameIdentity(before.identity, after)
      ) {
        health[before.name] = { lastErrorCode: null, lastErrorAt: null };
        identities[before.name] = undefined;
        failureRevisions[before.name]++;
        options.slots.invalidate(before.name);
      }
      if (before.name === 'reserve' && candidate && reserveAbsent && after !== 'absent') {
        reserveAppeared = true;
        options.slots.invalidate('reserve');
      }
    }
    const remaining = failingSlots();
    const unidentified = remaining.some((name) => identities[name] === undefined);
    if (
      outcomeRevision === revision &&
      activeRequests === 0 &&
      (remaining.length === 0 || (reserveAppeared && !unidentified))
    ) {
      health.state = 'unknown';
      health.outageSince = null;
      health.lastErrorCode = null;
      outcomeRevision++;
      if (reserveAppeared) reserveAbsent = false;
    }
  }

  /** Retain the actual read handle until Bao settles, even after callers time out. */
  function recheckIfStale(): Promise<void> {
    if (health.state !== 'down') return Promise.resolve();
    if (rechecking !== undefined) return within(rechecking);
    const startedAt = Date.now();
    if (startedAt - recheckedAt < recheck.cache) return Promise.resolve();
    recheckedAt = startedAt;
    rechecking = recheckOutage()
      .catch(() => {
        // A re-check that cannot read changes nothing.
      })
      .finally(() => {
        rechecking = undefined;
      });
    return within(rechecking);
  }

  /**
   * The caller's session, as this request names it: the id it sent, or the one
   * fixed id this process made at start (ADR-013, the custom-headers
   * amendment). A value carrying `{session}` is filled from here.
   */
  const processSessionId = randomUUID();
  // Concurrent attempts retain their keys and their rendered header values
  // independently of cache eviction: an answer still in flight is inspected
  // against what that attempt really sent.
  const activeKeys = new Map<string, number>();
  const activeHeaderSecrets = new Map<string, number>();
  // One warning per slot and placeholder header set, not one per request.
  const fallbackLogged = new Set<string>();
  const inspectedKeys = () => [
    ...options.slots.keys(),
    ...activeKeys.keys(),
    ...activeHeaderSecrets.keys(),
  ];
  function retain(retained: Map<string, number>, secret: string): void {
    retained.set(secret, (retained.get(secret) ?? 0) + 1);
  }
  function release(retained: Map<string, number>, secret: string): void {
    const remaining = (retained.get(secret) ?? 1) - 1;
    if (remaining === 0) retained.delete(secret);
    else retained.set(secret, remaining);
  }
  async function attempt(
    slot: ModelSlot,
    name: ModelSlotName,
    payload: Record<string, unknown> | undefined,
    res: ServerResponse,
    signal: AbortSignal,
    session: { id: string; callerNamed: boolean },
    captureInput: Omit<CaptureInput, 'upstream' | 'slot'>,
    authorizeTask?: (signal: AbortSignal) => Promise<void>
  ): Promise<void> {
    const rendered = renderAttemptHeaders(slot, session.id);
    if (slot.key) retain(activeKeys, slot.key);
    for (const secret of rendered.secrets) retain(activeHeaderSecrets, secret);
    try {
      await sendAttempt(
        slot,
        name,
        payload,
        res,
        signal,
        session,
        rendered.headers,
        captureInput,
        authorizeTask
      );
    } finally {
      if (slot.key) release(activeKeys, slot.key);
      for (const secret of rendered.secrets) release(activeHeaderSecrets, secret);
    }
  }

  async function sendAttempt(
    slot: ModelSlot,
    name: ModelSlotName,
    payload: Record<string, unknown> | undefined,
    res: ServerResponse,
    signal: AbortSignal,
    session: { id: string; callerNamed: boolean },
    custom: Record<string, string>,
    captureInput: Omit<CaptureInput, 'upstream' | 'slot'>,
    authorizeTask?: (signal: AbortSignal) => Promise<void>
  ): Promise<void> {
    const startedAt = Date.now();
    const connectDeadline = startedAt + limits.connect;
    const resolved = await wait(
      resolveModelDestination(slot.baseUrl, connectDeadline, options.resolveHost),
      signal
    ).catch((error: unknown) => {
      if (signal.aborted) throw signal.reason;
      if (error instanceof Error && error.message.includes('timeout'))
        throw new GatewayError('timeout');
      throw new GatewayError('blocked_destination');
    });
    signal.throwIfAborted();
    if (Date.now() >= connectDeadline) throw new GatewayError('timeout');
    const url = modelEndpointUrl(slot.baseUrl, payload ? 'chat/completions' : 'models');
    const body = payload
      ? JSON.stringify({
          ...payload,
          // Per-attempt default: reserve uses its own slot, never a primary
          // default carried over by mutating the caller's payload. Task and
          // core requests share this rule. An explicit client value wins.
          ...(payload['reasoning_effort'] === undefined && slot.reasoningEffort !== undefined
            ? { reasoning_effort: slot.reasoningEffort }
            : {}),
          model:
            name === 'reserve' || payload['model'] === 'default' ? slot.model : payload['model'],
        })
      : undefined;
    const controller = new AbortController();
    const active = AbortSignal.any([signal, controller.signal]);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = () => {
      controller.abort(new GatewayError('timeout'));
    };
    const headers = upstreamHeaders(slot, custom, session, name, {
      host: url.host,
      stream: payload?.['stream'] === true,
      contentLength: body === undefined ? undefined : Buffer.byteLength(body),
    });
    const capture = options.capture?.begin(
      {
        ...captureInput,
        slot: name,
        upstream: { method: payload ? 'POST' : 'GET', url: url.href, headers, body: body ?? '' },
      },
      {
        secrets: [
          slot.key ?? '',
          ...Object.entries(headers)
            .filter(([key]) =>
              (slot.headers ?? []).some((header) => header.name.toLowerCase() === key.toLowerCase())
            )
            .map(([, value]) => value),
        ],
        secretHeaders: (slot.headers ?? []).map((header) => header.name),
      }
    );
    const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requestFn(url, {
      method: payload ? 'POST' : 'GET',
      hostname: resolved.address,
      agent: url.protocol === 'https:' ? httpsAgent : httpAgent,
      signal: active,
      ...(url.protocol === 'https:'
        ? {
            servername: url.hostname,
            ...(options.tlsCa === undefined ? {} : { ca: options.tlsCa }),
          }
        : {}),
      headers,
    });
    // A permanent safe listener also handles destruction after the response event.
    req.on('error', () => {
      // Also fail a socket/authorization wait if transport dies before response intake.
      if (!active.aborted) controller.abort(new GatewayError('unreachable'));
    });
    const connectTimer = schedule(timeout, Math.max(1, connectDeadline - Date.now()));
    const byteTimer = schedule(timeout, Math.max(1, startedAt + limits.firstByte - Date.now()));
    let rejectedStatus: number | undefined;
    let captureError: string | undefined;
    try {
      // request() may wait in the bounded shared agent queue. It sends no HTTP
      // bytes until end(): first obtain a connected (TLS-ready) socket, then
      // refresh task authority after every network wait, including reuse.
      const [socket] = await (once(req, 'socket', { signal: active }) as Promise<[Socket]>);
      if (!sockets.has(socket)) {
        sockets.add(socket);
        socket.on('error', () => undefined);
      }
      if (socket instanceof TLSSocket ? !socket.authorized : socket.connecting)
        await once(socket, url.protocol === 'https:' ? 'secureConnect' : 'connect', {
          signal: active,
        });
      cancel(connectTimer);
      if (authorizeTask) await wait(authorizeTask(active), active);
      active.throwIfAborted();
      const responsePromise = once(req, 'response', { signal: active }) as Promise<
        [IncomingMessage]
      >;
      req.end(body);
      const [upstream] = await responsePromise;
      upstream.on('error', () => undefined);
      const status = upstream.statusCode ?? 502;
      capture?.response(status, upstream.headers);
      upstream.on('data', (chunk: Buffer) => capture?.chunk(chunk));
      if (status === 401 || status === 403) options.slots.invalidate(name);
      if (status < 200 || status >= 300) {
        rejectedStatus = status;
        const excerpt = await wait(
          readModelErrorExcerpt(upstream, inspectedKeys(), body ?? ''),
          active
        );
        throw new GatewayError(
          status >= 400 ? `upstream_${String(status)}` : 'bad_response',
          status >= 400 && status < 500 ? status : 502,
          status >= 400 ? undefined : { check: 'upstream_status', path: '' },
          status,
          excerpt
        );
      }
      let first = true;
      upstream.on('data', () => {
        if (first) {
          first = false;
          cancel(byteTimer);
        }
        cancel(idleTimer);
        idleTimer = schedule(timeout, limits.idle);
      });
      const stream = payload?.['stream'] === true;
      if (stream && !upstream.headers['content-type']?.startsWith('text/event-stream'))
        throw badResponse('stream_content_type', '');
      if (!stream) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const value of upstream) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
          size += chunk.length;
          if (size > MAX_BODY) throw badResponse('body_size', '');
          chunks.push(chunk);
        }
        active.throwIfAborted();
        const value = parseSafe(
          new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
          inspectedKeys()
        );
        validateResponse(value, payload === undefined);
        const output = serializeSafe(value, inspectedKeys());
        res.writeHead(200, returnHeaders(upstream, name, false, inspectedKeys()));
        res.end(output);
      } else {
        const inspector = new SafeEventStream(() => inspectedKeys());
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let pending = '';
        let previousCR = false;
        for await (const value of upstream) {
          active.throwIfAborted();
          const decoded = decoder.decode(value as Uint8Array, { stream: true });
          for (const character of decoded) {
            if (character === '\n' && previousCR) {
              previousCR = false;
              continue;
            }
            pending += character === '\r' ? '\n' : character;
            previousCR = character === '\r';
          }
          if (Buffer.byteLength(pending) > MAX_BODY) throw badResponse('frame_size', '');
          let end: number;
          while ((end = pending.indexOf('\n\n')) !== -1) {
            const frame = pending.slice(0, end);
            pending = pending.slice(end + 2);
            const output = inspector.frame(frame);
            if (output) {
              if (!res.headersSent)
                res.writeHead(200, returnHeaders(upstream, name, true, inspectedKeys()));
              if (!res.write(output)) await once(res, 'drain', { signal: active });
            }
          }
        }
        pending += decoder.decode();
        if (pending.trim() || !inspector.done) throw badResponse('stream_truncated', '');
        active.throwIfAborted();
        res.end();
      }
    } catch (error) {
      const failure = safeError(active.aborted ? active.reason : error);
      captureError = failure.code;
      // Body-read timeout must retain the status already received, not invent
      // a transport-only failure. requestFailure preserves it through failover.
      if (rejectedStatus !== undefined && failure.upstreamStatus === undefined)
        throw new GatewayError(failure.code, failure.status, failure.reason, rejectedStatus);
      throw failure;
    } finally {
      cancel(connectTimer);
      cancel(byteTimer);
      cancel(idleTimer);
      capture?.finish(captureError);
      // Includes slot switch, malformed responses and success; never leaves a live upstream.
      req.destroy();
    }
  }

  async function serve(
    req: IncomingMessage,
    res: ServerResponse,
    trustedTaskId?: string,
    authorizeTask?: (signal: AbortSignal) => Promise<void>,
    taskContext?: { taskId: string; traceId: string }
  ): Promise<void> {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    if (
      !(
        (req.method === 'POST' && req.url === '/v1/chat/completions') ||
        (req.method === 'GET' && req.url === '/v1/models')
      )
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    activeRequests++;
    const controller = new AbortController();
    const timer = schedule(() => {
      controller.abort(new GatewayError('timeout'));
    }, limits.overall);
    const disconnect = () => {
      if (!res.writableEnded) controller.abort(new GatewayError('client_disconnected'));
    };
    res.on('close', disconnect);
    const signal = controller.signal;
    // The caller's session, read from this one inbound header and no other:
    // an id it names only when it is well formed, otherwise this process's own
    // fixed id (ADR-013, the custom-headers amendment).
    const named = trustedTaskId ?? validSessionId(req.headers[SESSION_HEADER]);
    const session = { id: named ?? processSessionId, callerNamed: named !== undefined };
    const requestStartedAt = new Date().toISOString();
    // The slot whose read or attempt a recorded failure came from: a slot read
    // that fails belongs to that slot, not to the last one attempted (ADR-013
    // D4). Optional absence never records a failure and never moves this.
    let failureSlot: ModelSlotName | undefined;
    const recordFailure = (
      name: ModelSlotName,
      code: string,
      identity: SlotIdentity | undefined
    ) => {
      health.lastAttemptAt = requestStartedAt;
      health[name] = { lastErrorCode: code, lastErrorAt: new Date().toISOString() };
      // The identity this failure names, for the change the re-check looks for.
      identities[name] = identity;
      failureRevisions[name]++;
      failureSlot = name;
    };
    let last = new GatewayError('not_configured');
    let loggedFailure: GatewayError | undefined;
    let activeSlot: ModelSlotName = 'primary';
    let inboundBody = '';
    let attemptNumber = 0;
    const callId = validSessionId(req.headers['x-lifemodel-call']) ?? randomUUID();
    try {
      let payload: Record<string, unknown> | undefined;
      if (req.method === 'POST') {
        try {
          inboundBody = await readBody(req, signal);
          payload = record(JSON.parse(inboundBody));
        } catch (error) {
          if (signal.aborted || error instanceof GatewayError) throw error;
          throw new GatewayError('invalid_request', 400);
        }
        if (
          !payload ||
          typeof payload['model'] !== 'string' ||
          !payload['model'] ||
          !Array.isArray(payload['messages'])
        )
          throw new GatewayError('invalid_request', 400);
      }
      if (payload && trustedTaskId !== undefined) {
        // Task model and identity are gateway-owned. Resolve this neutral model
        // to each attempted slot's configuration, including reserve failover.
        payload['model'] = 'default';
        // No caller session/user survives into the ADR-013 slot path.
        for (const key of ['session', 'session_id', 'conversation_id', 'taskId', 'task_id'])
          Reflect.deleteProperty(payload, key);
        payload['user'] = trustedTaskId;
      }
      for (const name of slotNames) {
        signal.throwIfAborted();
        let identity: SlotIdentity | undefined;
        try {
          const read = await wait(options.slots.read(name), signal);
          identity = slotIdentity(read);
          if (read.state === 'absent') {
            if (name === 'reserve') {
              reserveAbsent = true;
              break;
            }
            throw new GatewayError('not_configured');
          }
          if (name === 'reserve') reserveAbsent = false;
          // The failure names the slot that was really attempted, never one
          // whose read only came back absent.
          activeSlot = name;
          await attempt(
            read.slot,
            name,
            payload,
            res,
            signal,
            session,
            {
              callId,
              attempt: ++attemptNumber,
              taskId: trustedTaskId ?? null,
              sessionId: named ?? null,
              inbound: {
                method: req.method ?? '',
                path: req.url ?? '',
                headers: req.headers,
                body: inboundBody,
              },
            },
            authorizeTask
          );
          failureRevisions[name]++;
          outcomeRevision++;
          health.lastAttemptAt = requestStartedAt;
          health.state = 'ok';
          health.outageSince = null;
          health.lastSuccessAt = new Date().toISOString();
          health.lastErrorCode = null;
          return;
        } catch (error) {
          last = requestFailure(error, signal);
          if (last.code === 'client_disconnected' || last instanceof TaskAuthorizationError)
            throw last;
          recordFailure(name, last.code, identity);
          options.logger.warn(
            {
              code: last.code,
              status: last.upstreamStatus ?? last.status,
              modelRoute: name,
              slot: name,
              reason: last.reason,
              errorExcerpt: last.errorExcerpt,
              ...taskContext,
            },
            'Model gateway upstream failed'
          );
          loggedFailure = last;
          if (
            signal.aborted ||
            last.code === 'not_configured' ||
            last.code === 'storage_unavailable' ||
            res.headersSent ||
            (last.status >= 400 && last.status < 500 && last.status !== 429)
          )
            throw last;
        }
      }
      throw last;
    } catch (error) {
      const failure = requestFailure(error, signal);
      const callerOutcome =
        failure instanceof TaskAuthorizationError ||
        ['client_disconnected', 'invalid_request', 'request_too_large'].includes(failure.code);
      if (!callerOutcome) {
        outcomeRevision++;
        health.lastAttemptAt = requestStartedAt;
        health.state = 'down';
        health.outageSince ??= new Date().toISOString();
        health.lastErrorCode = failure.code;
        if (failure !== loggedFailure)
          options.logger.warn(
            {
              code: failure.code,
              status: failure.upstreamStatus ?? failure.status,
              modelRoute: failureSlot ?? activeSlot,
              errorExcerpt: failure.errorExcerpt,
              slot: failureSlot ?? activeSlot,
              reason: failure.reason,
              ...taskContext,
            },
            'Model gateway request failed'
          );
      }
      if (callerOutcome && taskContext)
        options.logger.warn(
          { code: failure.code, status: failure.status, modelRoute: activeSlot, ...taskContext },
          'Task model gateway request refused'
        );
      if (!req.complete) {
        res.setHeader('connection', 'close');
        res.once('finish', () => {
          req.destroy();
        });
      }
      ownedError(res, failure, failureSlot ?? activeSlot);
    } finally {
      activeRequests--;
      cancel(timer);
      res.removeListener('close', disconnect);
    }
  }
  const api = createServer((req, res) => {
    void serve(req, res);
  });
  api.on('connection', (socket) => socket.on('error', () => undefined));
  async function answerStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' || req.url !== '/status') {
      res.writeHead(404);
      res.end();
      return;
    }
    // A stale outage is cleared before the answer, bounded by STATUS_RECHECK.bound.
    await recheckIfStale();
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(health));
  }
  const status = createServer((req, res) => {
    void answerStatus(req, res);
  });
  return {
    api,
    status,
    close: () => {
      httpAgent.destroy();
      httpsAgent.destroy();
    },
    /** Internal trusted call only; never selected by any HTTP header. */
    serveTask: (
      req: IncomingMessage,
      res: ServerResponse,
      taskId: string,
      authorize: (signal: AbortSignal) => Promise<void>,
      taskContext?: { taskId: string; traceId: string }
    ) => serve(req, res, taskId, authorize, taskContext),
  };
}
