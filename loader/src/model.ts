/** Safe model endpoint validation and slot operations (ADR-012 D7, ADR-013 D2). */
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { ClientRequest } from 'node:http';
import { modelEndpointUrl } from './model-url.js';

export type ModelSlotName = 'primary' | 'reserve';
/** One additional header the slot sends upstream, in the owner's own order. */
export interface ModelSlotHeader {
  name: string;
  value: string;
}
export interface ModelSlot {
  kind: 'openai' | 'ollama';
  baseUrl: string;
  model: string;
  key?: string;
  headers?: ModelSlotHeader[];
}
export interface ModelSlotView extends Omit<ModelSlot, 'key' | 'headers'> {
  keySet: boolean;
  /** The stored header names only: a header value never leaves the slot store. */
  headerNames: string[];
}
/** The slot's own KV v2 identity: the version that holds it, or its absence. */
export type SlotIdentity = { version: number } | 'absent';
/**
 * One read of a slot: the value with the KV version it came from, or its
 * absence. The version is the read's own `metadata.version` (ADR-013 D6).
 */
export type SlotRead = { state: 'present'; slot: ModelSlot; version: number } | { state: 'absent' };
/** The identity a later read is compared against. */
export function slotIdentity(read: SlotRead): SlotIdentity {
  return read.state === 'present' ? { version: read.version } : 'absent';
}
/**
 * The shortest static part — the value with every `{session}` removed — that
 * D4's response inspectors treat as credential material (ADR-013, the
 * custom-headers amendment). A shorter value (`1`, `true`, a version, a bare
 * `{session}`) collides with ordinary replies, so it is not matched: the guard
 * is a heuristic against echo, not proof of secrecy.
 */
export const MIN_HEADER_SECRET_BYTES = 16;
export interface ModelSlots {
  read(slot: ModelSlotName): Promise<ModelSlot | null>;
  write(slot: ModelSlotName, value: ModelSlot): Promise<void>;
  clearReserve(): Promise<void>;
}
/** At most this many additional headers on a slot. */
export const MAX_SLOT_HEADERS = 16;
/** The longest accepted header name, in characters. */
export const MAX_SLOT_HEADER_NAME = 64;
/** The longest accepted header value, in bytes. */
export const MAX_SLOT_HEADER_VALUE = 1024;
/** An RFC 9110 token: the only shape a header name may have. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/**
 * Names the gateway sets itself, and the hop-by-hop and cookie headers a
 * request must never carry from a slot: a custom header can never replace
 * `host`, `content-type`, `accept`, `authorization` or `content-length`.
 */
const RESERVED_HEADERS = new Set([
  'host',
  'authorization',
  'proxy-authorization',
  'content-length',
  'content-type',
  'accept',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'expect',
  'cookie',
]);
export type SlotHeaderErrorCode =
  | 'header_shape_invalid'
  | 'header_name_invalid'
  | 'header_name_reserved'
  | 'header_value_invalid'
  | 'header_duplicate'
  | 'header_too_many';
/** A refused header list, named by the rule it broke. */
export class SlotHeaderError extends Error {
  constructor(readonly code: SlotHeaderErrorCode) {
    super(code);
    this.name = 'SlotHeaderError';
  }
}
/**
 * The header list a slot may carry, or the rule it breaks (ADR-013, the
 * custom-headers amendment). Enforced where the slot is saved and again where
 * the gateway reads it: a slot that breaks a rule is refused, never trimmed.
 */
export function validateSlotHeaders(input: unknown): ModelSlotHeader[] {
  if (!Array.isArray(input)) throw new SlotHeaderError('header_shape_invalid');
  if (input.length > MAX_SLOT_HEADERS) throw new SlotHeaderError('header_too_many');
  const seen = new Set<string>();
  const headers: ModelSlotHeader[] = [];
  for (const item of input) {
    if (typeof item !== 'object' || item === null || Array.isArray(item))
      throw new SlotHeaderError('header_shape_invalid');
    const entry = item as Record<string, unknown>;
    if (
      Object.keys(entry).some((field) => field !== 'name' && field !== 'value') ||
      typeof entry['name'] !== 'string' ||
      typeof entry['value'] !== 'string'
    )
      throw new SlotHeaderError('header_shape_invalid');
    const name = entry['name'];
    const value = entry['value'];
    if (name.length > MAX_SLOT_HEADER_NAME || !HEADER_NAME.test(name))
      throw new SlotHeaderError('header_name_invalid');
    const lower = name.toLowerCase();
    if (RESERVED_HEADERS.has(lower) || lower.startsWith('proxy-'))
      throw new SlotHeaderError('header_name_reserved');
    if (seen.has(lower)) throw new SlotHeaderError('header_duplicate');
    if (/[\r\n\0]/.test(value) || Buffer.byteLength(value, 'utf8') > MAX_SLOT_HEADER_VALUE)
      throw new SlotHeaderError('header_value_invalid');
    seen.add(lower);
    headers.push({ name, value });
  }
  return headers;
}
/** The request header the core names its session in (ADR-013 amendment). */
export const SESSION_HEADER = 'x-lifemodel-session';
/** The placeholder a slot value may carry in place of the session id. */
export const SESSION_PLACEHOLDER = '{session}';
/** The session id the loader's own model check sends in place of a caller's. */
export const CHECK_SESSION_ID = 'lifemodel-model-check';
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** The caller's session id, or nothing when the header is missing or malformed. */
export function validSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && SESSION_ID.test(value) ? value : undefined;
}
/** A header value with every `{session}` filled from the caller's session id. */
export function renderHeaderValue(value: string, sessionId: string): string {
  return value.split(SESSION_PLACEHOLDER).join(sessionId);
}
/**
 * One render of the slot's own headers, each `{session}` filled from this
 * session id, in the owner's order: the map sent upstream and the rendered
 * values that answer may never echo (ADR-013, the custom-headers amendment). A
 * caller sets its own host, content type, accept, authorization and content
 * length over the map, so a value can never replace one of those.
 *
 * The map has no prototype, so every accepted token is an own property: a token
 * named `__proto__` would otherwise reach Object.prototype's legacy setter
 * instead of the wire.
 */
export function renderAttemptHeaders(
  slot: ModelSlot,
  sessionId: string
): { headers: Record<string, string>; secrets: string[] } {
  const headers = Object.create(null) as Record<string, string>;
  const secrets: string[] = [];
  for (const header of slot.headers ?? []) {
    const value = renderHeaderValue(header.value, sessionId);
    headers[header.name] = value;
    const staticPart = header.value.split(SESSION_PLACEHOLDER).join('');
    if (Buffer.byteLength(staticPart, 'utf8') >= MIN_HEADER_SECRET_BYTES) secrets.push(value);
  }
  return { headers, secrets };
}
/** The slot's own headers for this session id, without the echo guard's material. */
export function renderSlotHeaders(slot: ModelSlot, sessionId: string): Record<string, string> {
  return renderAttemptHeaders(slot, sessionId).headers;
}
export type ModelErrorCode =
  | 'unreachable'
  | 'tls'
  | 'timeout'
  | 'auth_failed'
  | 'model_not_found'
  | 'bad_response'
  | 'blocked_destination';
export class ModelCheckError extends Error {
  constructor(readonly code: ModelErrorCode) {
    super(code);
  }
}
const MAX_RESPONSE = 64 * 1024;
const TIMEOUT_MS = 15_000;
const OLLAMA = 'http://ollama.ollama.svc.cluster.local:11434';
const PRIVATE_V4 = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2[0-9]|3[01])\./];
const CLUSTER_V4 = [/^10\.42\./, /^10\.43\./];
function deniedAddress(address: string): boolean {
  if (address.includes(':')) return true;
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return true;
  if (
    address.startsWith('127.') ||
    address.startsWith('169.254.') ||
    address === '0.0.0.0' ||
    address.startsWith('224.') ||
    address.startsWith('240.')
  )
    return true;
  if (address.startsWith('100.')) return true;
  return CLUSTER_V4.some((pattern) => pattern.test(address));
}
function validateUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ModelCheckError('blocked_destination');
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !url.hostname
  )
    throw new ModelCheckError('blocked_destination');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname.endsWith('.svc.cluster.local') && url.origin !== OLLAMA)
    throw new ModelCheckError('blocked_destination');
  if (url.origin === OLLAMA) return url;
  if (
    url.protocol === 'http:' &&
    url.origin !== OLLAMA &&
    isIP(hostname) === 4 &&
    !PRIVATE_V4.some((pattern) => pattern.test(hostname))
  )
    throw new ModelCheckError('blocked_destination');
  if (isIP(hostname)) {
    if (deniedAddress(hostname)) throw new ModelCheckError('blocked_destination');
  }
  return url;
}

/** Resolve and validate once; transports must connect to this pinned address. */
export async function resolveModelDestination(
  baseUrl: string,
  deadline: number,
  resolveHost: (hostname: string) => Promise<string[]> = async (hostname) =>
    (await lookup(hostname, { all: true, verbatim: true })).map((item) => item.address)
): Promise<{ url: URL; address: string }> {
  const url = validateUrl(baseUrl);
  const special = url.origin === OLLAMA;
  const addresses = await withDeadline(
    isIP(url.hostname) ? Promise.resolve([url.hostname]) : resolveHost(url.hostname),
    deadline
  );
  if (
    addresses.length === 0 ||
    addresses.some((address) =>
      special
        ? isIP(address) !== 4 ||
          !address.startsWith('10.43.') ||
          address.startsWith('169.254.') ||
          address.startsWith('127.')
        : deniedAddress(address) ||
          (url.protocol === 'http:' && !PRIVATE_V4.some((pattern) => pattern.test(address)))
    )
  )
    throw new ModelCheckError('blocked_destination');
  const address = addresses[0];
  if (!address) throw new ModelCheckError('blocked_destination');
  return { url, address };
}

export interface ModelCheckerOptions {
  resolveHost?: (hostname: string) => Promise<string[]>;
  tlsCa?: string | Buffer;
  timeoutMs?: number;
  request?: (
    url: URL,
    address: string,
    body: string,
    key?: string,
    headers?: Record<string, string>
  ) => Promise<{ status: number; body: string }>;
}
export function createModelChecker(
  options: ModelCheckerOptions = {}
): (slot: ModelSlot, slotName?: ModelSlotName) => Promise<void> {
  const resolveHost =
    options.resolveHost ??
    (async (hostname: string) =>
      (await lookup(hostname, { all: true, verbatim: true })).map((item) => item.address));
  const active = new Set<ModelSlotName>();
  const check = async (slot: ModelSlot): Promise<void> => {
    const deadline = Date.now() + (options.timeoutMs ?? TIMEOUT_MS);
    const { address } = await resolveModelDestination(slot.baseUrl, deadline, resolveHost);
    const endpoint = modelEndpointUrl(slot.baseUrl);
    const payload = JSON.stringify({
      model: slot.model,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      max_tokens: 4,
      stream: false,
    });
    // The check sends the slot's own headers too, with `{session}` filled from
    // a fixed probe id: the endpoint may need the same header the gateway will
    // send later (ADR-013, the custom-headers amendment).
    const headers = renderSlotHeaders(slot, CHECK_SESSION_ID);
    const result = options.request
      ? await options.request(endpoint, address, payload, slot.key, headers)
      : await requestBounded(
          endpoint,
          address,
          payload,
          slot.key,
          headers,
          deadline,
          options.tlsCa
        );
    if (result.status === 401 || result.status === 403) throw new ModelCheckError('auth_failed');
    if (result.status === 404) throw new ModelCheckError('model_not_found');
    if (result.status < 200 || result.status >= 300) throw new ModelCheckError('bad_response');
    if (Buffer.byteLength(result.body) > MAX_RESPONSE) throw new ModelCheckError('bad_response');
    let decoded: unknown;
    try {
      decoded = JSON.parse(result.body);
    } catch {
      throw new ModelCheckError('bad_response');
    }
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      !Array.isArray((decoded as Record<string, unknown>)['choices'])
    )
      throw new ModelCheckError('bad_response');
  };
  return async (slot, slotName = 'primary') => {
    if (active.has(slotName)) throw new ModelCheckError('unreachable');
    active.add(slotName);
    try {
      await check(slot);
    } catch (error) {
      if (error instanceof ModelCheckError) throw error;
      const message = error instanceof Error ? error.message : '';
      if (/response exceeded bound/i.test(message)) throw new ModelCheckError('bad_response');
      if (/timeout|request timeout/i.test(message)) throw new ModelCheckError('timeout');
      if (/certificate|tls|ssl/i.test(message)) throw new ModelCheckError('tls');
      throw new ModelCheckError('unreachable');
    } finally {
      active.delete(slotName);
    }
  };
}
function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error('request timeout exceeded'));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('request timeout exceeded'));
    }, remaining);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('DNS resolution failed'));
      }
    );
  });
}
function requestBounded(
  url: URL,
  address: string,
  body: string,
  key: string | undefined,
  custom: Record<string, string>,
  deadline: number,
  tlsCa?: string | Buffer
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req: ClientRequest = requestFn(
      url,
      {
        method: 'POST',
        hostname: address,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        ...(url.protocol === 'https:'
          ? { servername: url.hostname, ...(tlsCa === undefined ? {} : { ca: tlsCa }) }
          : {}),
        headers: {
          ...custom,
          host: url.host,
          'content-type': 'application/json',
          accept: 'application/json',
          ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let response = '';
        let size = 0;
        res.on('data', (chunk: Buffer | string) => {
          size += Buffer.byteLength(chunk);
          if (size > MAX_RESPONSE) {
            req.destroy(new Error('response exceeded bound'));
            return;
          }
          response += chunk.toString();
        });
        res.on('end', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve({ status: res.statusCode ?? 0, body: response });
          }
        });
        res.on('aborted', () => {
          finish(new Error('response aborted'));
        });
      }
    );
    const finish = (error: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    };
    const timer = setTimeout(
      () => req.destroy(new Error('request timeout exceeded')),
      Math.max(1, deadline - Date.now())
    );
    req.on('error', (error) => {
      finish(error);
    });
    req.write(body);
    req.end();
  });
}
export function publicSlot(slot: ModelSlot | null): ModelSlotView | null {
  if (slot === null) return null;
  const { key, headers, ...safe } = slot;
  return {
    ...safe,
    keySet: key !== undefined,
    headerNames: (headers ?? []).map((header) => header.name),
  };
}
