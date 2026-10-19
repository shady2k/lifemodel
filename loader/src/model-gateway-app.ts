/** The platform-owned model gateway. No inbound headers or upstream errors are copied. */
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { once } from 'node:events';
import {
  resolveModelDestination,
  slotIdentity,
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
  let recheckedAt = 0;
  let rechecking: Promise<void> | undefined;

  const failingSlots = (): ModelSlotName[] =>
    slotNames.filter((name) => health[name].lastErrorCode !== null);

  /** A re-check read that does not answer inside the bound answers nothing. */
  function within<T>(promises: Promise<T>[], ms: number): Promise<T[] | undefined> {
    return new Promise<T[] | undefined>((resolve) => {
      const timer = schedule(() => {
        resolve(undefined);
      }, ms);
      void Promise.allSettled(promises).then((results) => {
        cancel(timer);
        resolve(
          results.every((result) => result.status === 'fulfilled')
            ? results.map((result) => (result as PromiseFulfilledResult<T>).value)
            : undefined
        );
      });
    });
  }

  /**
   * A recorded outage is stale when the slot it names changed (ADR-013 D6).
   * Each failing slot's version is read afresh; a slot whose version moved — or
   * that was absent and now exists — has its failure and cached value cleared,
   * and the request level returns to `unknown` once every failing slot changed.
   * A Bao error or a read past the bound changes nothing.
   */
  async function recheckOutage(): Promise<void> {
    if (health.state !== 'down') return;
    const failing = failingSlots();
    if (failing.length === 0) return;
    const recorded = failing.map((name) => identities[name]);
    // A slot whose own read failed holds no version: nothing changed for it.
    if (recorded.some((identity) => identity === undefined)) return;
    const current = await within(
      failing.map((name) => options.slots.identity(name)),
      recheck.bound
    );
    if (current === undefined) return;
    const changed = failing.filter((name, index) => {
      const before = recorded[index];
      const after = current[index];
      if (before === undefined || after === undefined) return false;
      return !sameIdentity(before, after);
    });
    for (const name of changed) {
      health[name] = { lastErrorCode: null, lastErrorAt: null };
      identities[name] = undefined;
      // The cached value predates the change the owner saved.
      options.slots.invalidate(name);
    }
    if (changed.length === failing.length) {
      health.state = 'unknown';
      health.outageSince = null;
      health.lastErrorCode = null;
    }
  }

  /** One read in flight, and no more often than `STATUS_RECHECK.cache`. */
  function recheckIfStale(): Promise<void> {
    if (health.state !== 'down') return Promise.resolve();
    const startedAt = Date.now();
    if (startedAt - recheckedAt < recheck.cache) return Promise.resolve();
    recheckedAt = startedAt;
    rechecking ??= (async () => {
      try {
        await recheckOutage();
      } catch {
        // A re-check that cannot read changes nothing.
      }
    })().finally(() => {
      rechecking = undefined;
    });
    return rechecking;
  }

  async function attempt(
    slot: ModelSlot,
    name: ModelSlotName,
    payload: Record<string, unknown> | undefined,
    res: ServerResponse,
    signal: AbortSignal
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
      headers: {
        host: url.host,
        'content-type': 'application/json',
        accept: payload?.['stream'] === true ? 'text/event-stream' : 'application/json',
        ...(slot.key ? { authorization: `Bearer ${slot.key}` } : {}),
        ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }),
      },
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
          options.slots.keys()
        );
        validateResponse(value, payload === undefined);
        const output = serializeSafe(value, options.slots.keys());
        res.writeHead(200, returnHeaders(upstream, name, false, options.slots.keys()));
        res.end(output);
      } else {
        const inspector = new SafeEventStream(() => options.slots.keys());
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
                res.writeHead(200, returnHeaders(upstream, name, true, options.slots.keys()));
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
    const controller = new AbortController();
    const timer = schedule(() => {
      controller.abort(new GatewayError('timeout'));
    }, limits.overall);
    const disconnect = () => {
      if (!res.writableEnded) controller.abort(new GatewayError('client_disconnected'));
    };
    res.on('close', disconnect);
    const signal = controller.signal;
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
            // The primary's absence ends the request; the reserve's is a slot
            // failure like any other, and keeps the primary's own code visible.
            if (name === 'reserve') {
              recordFailure(name, 'not_configured', identity);
              break;
            }
            throw new GatewayError('not_configured');
          }
          await attempt(read.slot, name, payload, res, signal);
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
