/** The platform-owned model gateway. No inbound headers or upstream errors are copied. */
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  renderHeaderValue,
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
import { SlotStorageUnavailableError } from './model-bao.js';
import type { LoaderLogger } from './logger.js';
import {
  GatewayError,
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
  timeouts?: Timeouts;
  /** The stale-outage re-check's bounds; tests narrow them. */
  recheck?: { bound?: number; cache?: number };
  timers?: { set: typeof setTimeout; clear: typeof clearTimeout };
  resolveHost?: (hostname: string) => Promise<string[]>;
  tlsCa?: string | Buffer;
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
function ownedError(res: ServerResponse, error: GatewayError, slot?: ModelSlotName): void {
  const body = JSON.stringify({ error: { type: 'gateway_error', code: error.code } });
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
   * order, each with every `{session}` filled from the caller; the gateway's
   * own host, content type, accept, authorization and content length are then
   * set over them, so a custom header can never replace one of those. A value
   * that had to fall back to this process's own id is named in one log line,
   * never with its value (ADR-013, the custom-headers amendment).
   */
  function upstreamHeaders(
    slot: ModelSlot,
    session: { id: string; callerNamed: boolean },
    url: URL,
    payload: Record<string, unknown> | undefined,
    body: string | undefined
  ): Record<string, string> {
    const headers: Record<string, string> = {};
    const fellBack: string[] = [];
    for (const header of slot.headers ?? []) {
      headers[header.name] = renderHeaderValue(header.value, session.id);
      if (!session.callerNamed && header.value.includes(SESSION_PLACEHOLDER))
        fellBack.push(header.name);
    }
    headers['host'] = url.host;
    headers['content-type'] = 'application/json';
    headers['accept'] = payload?.['stream'] === true ? 'text/event-stream' : 'application/json';
    if (slot.key) headers['authorization'] = `Bearer ${slot.key}`;
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
    if (fellBack.length > 0)
      options.logger.warn(
        { headers: fellBack },
        'Model gateway filled the session placeholder with its own process id'
      );
    return headers;
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
  // Concurrent attempts retain their keys independently of cache eviction.
  const activeKeys = new Map<string, number>();
  const inspectedKeys = () => [...options.slots.keys(), ...activeKeys.keys()];
  async function attempt(
    slot: ModelSlot,
    name: ModelSlotName,
    payload: Record<string, unknown> | undefined,
    res: ServerResponse,
    signal: AbortSignal,
    session: { id: string; callerNamed: boolean }
  ): Promise<void> {
    if (slot.key) activeKeys.set(slot.key, (activeKeys.get(slot.key) ?? 0) + 1);
    try {
      await sendAttempt(slot, name, payload, res, signal, session);
    } finally {
      if (slot.key) {
        const remaining = (activeKeys.get(slot.key) ?? 1) - 1;
        if (remaining === 0) activeKeys.delete(slot.key);
        else activeKeys.set(slot.key, remaining);
      }
    }
  }

  async function sendAttempt(
    slot: ModelSlot,
    name: ModelSlotName,
    payload: Record<string, unknown> | undefined,
    res: ServerResponse,
    signal: AbortSignal,
    session: { id: string; callerNamed: boolean }
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
    const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requestFn(url, {
      method: payload ? 'POST' : 'GET',
      hostname: resolved.address,
      agent: false,
      signal: active,
      ...(url.protocol === 'https:'
        ? {
            servername: url.hostname,
            ...(options.tlsCa === undefined ? {} : { ca: options.tlsCa }),
          }
        : {}),
      headers: upstreamHeaders(slot, session, url, payload, body),
    });
    // A permanent safe listener also handles destruction after the response event.
    req.on('error', () => {
      /* Consumed by the response wait or the response iterator. */
    });
    const connectTimer = schedule(timeout, Math.max(1, connectDeadline - Date.now()));
    const byteTimer = schedule(timeout, Math.max(1, startedAt + limits.firstByte - Date.now()));
    req.on('socket', (socket) =>
      socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
        cancel(connectTimer);
      })
    );
    try {
      const responsePromise = once(req, 'response', { signal: active }) as Promise<
        [IncomingMessage]
      >;
      req.end(body);
      const [upstream] = await responsePromise;
      const status = upstream.statusCode ?? 502;
      if (status === 401 || status === 403) options.slots.invalidate(name);
      if (status < 200 || status >= 300)
        throw new GatewayError(
          status >= 400 ? `upstream_${String(status)}` : 'bad_response',
          status >= 400 && status < 500 ? status : 502
        );
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
        throw new GatewayError('bad_response');
      if (!stream) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const value of upstream) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
          size += chunk.length;
          if (size > MAX_BODY) throw new GatewayError('bad_response');
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
          if (Buffer.byteLength(pending) > MAX_BODY) throw new GatewayError('bad_response');
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
        if (pending.trim() || !inspector.done) throw new GatewayError('bad_response');
        active.throwIfAborted();
        res.end();
      }
    } catch (error) {
      if (active.aborted) throw active.reason;
      throw safeError(error);
    } finally {
      cancel(connectTimer);
      cancel(byteTimer);
      cancel(idleTimer);
      // Includes slot switch, malformed responses and success; never leaves a live upstream.
      req.destroy();
    }
  }

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    const named = validSessionId(req.headers[SESSION_HEADER]);
    const session = { id: named ?? processSessionId, callerNamed: named !== undefined };
    const requestStartedAt = new Date().toISOString();
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
    };
    let last = new GatewayError('not_configured');
    let activeSlot: ModelSlotName = 'primary';
    try {
      let payload: Record<string, unknown> | undefined;
      if (req.method === 'POST') {
        try {
          payload = record(JSON.parse(await readBody(req, signal)));
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
      for (const name of slotNames) {
        signal.throwIfAborted();
        activeSlot = name;
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
          await attempt(read.slot, name, payload, res, signal, session);
          failureRevisions[name]++;
          outcomeRevision++;
          health.lastAttemptAt = requestStartedAt;
          health.state = 'ok';
          health.outageSince = null;
          health.lastSuccessAt = new Date().toISOString();
          health.lastErrorCode = null;
          return;
        } catch (error) {
          last = safeError(signal.aborted ? signal.reason : error);
          if (last.code === 'client_disconnected') throw last;
          recordFailure(name, last.code, identity);
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
      const failure = safeError(signal.aborted ? signal.reason : error);
      const callerOutcome = [
        'client_disconnected',
        'invalid_request',
        'request_too_large',
      ].includes(failure.code);
      if (!callerOutcome) {
        outcomeRevision++;
        health.lastAttemptAt = requestStartedAt;
        health.state = 'down';
        health.outageSince ??= new Date().toISOString();
        health.lastErrorCode = failure.code;
        options.logger.warn(
          { code: failure.code, slot: activeSlot },
          'Model gateway request failed'
        );
      }
      if (!req.complete) {
        res.setHeader('connection', 'close');
        res.once('finish', () => {
          req.destroy();
        });
      }
      ownedError(res, failure, activeSlot);
    } finally {
      activeRequests--;
      cancel(timer);
      res.removeListener('close', disconnect);
    }
  }
  const api = createServer((req, res) => {
    void serve(req, res);
  });
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
  return { api, status };
}
