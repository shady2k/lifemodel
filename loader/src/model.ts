/** Safe model endpoint validation and slot operations (ADR-012 D7, ADR-013 D2). */
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { ClientRequest } from 'node:http';
import { modelEndpointUrl } from './model-url.js';

export type ModelSlotName = 'primary' | 'reserve';
export interface ModelSlot {
  kind: 'openai' | 'ollama';
  baseUrl: string;
  model: string;
  key?: string;
}
export interface ModelSlotView extends Omit<ModelSlot, 'key'> {
  keySet: boolean;
}
export interface ModelSlots {
  read(slot: ModelSlotName): Promise<ModelSlot | null>;
  write(slot: ModelSlotName, value: ModelSlot): Promise<void>;
  clearReserve(): Promise<void>;
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

export interface ModelCheckerOptions {
  resolveHost?: (hostname: string) => Promise<string[]>;
  request?: (
    url: URL,
    address: string,
    body: string,
    key?: string
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
    const url = validateUrl(slot.baseUrl);
    const special = url.origin === OLLAMA;
    const addresses = special
      ? await resolveHost(url.hostname)
      : isIP(url.hostname)
        ? [url.hostname]
        : await resolveHost(url.hostname);
    if (
      addresses.length === 0 ||
      addresses.some((address) =>
        special
          ? isIP(address) !== 4 ||
            !PRIVATE_V4.some((pattern) => pattern.test(address)) ||
            deniedAddress(address)
          : deniedAddress(address) ||
            (url.protocol === 'http:' && !PRIVATE_V4.some((pattern) => pattern.test(address)))
      )
    )
      throw new ModelCheckError('blocked_destination');
    const address = addresses[0];
    if (!address) throw new ModelCheckError('blocked_destination');
    const endpoint = modelEndpointUrl(slot.baseUrl);
    const payload = JSON.stringify({
      model: slot.model,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      max_tokens: 4,
      stream: false,
    });
    const result = options.request
      ? await options.request(endpoint, address, payload, slot.key)
      : await requestBounded(endpoint, address, payload, slot.key);
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
function requestBounded(
  url: URL,
  address: string,
  body: string,
  key?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req: ClientRequest = requestFn(
      url,
      {
        method: 'POST',
        ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
        lookup: (_hostname, _opts, callback) => {
          callback(null, address, isIP(address));
        },
        headers: {
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
    const timer = setTimeout(() => req.destroy(new Error('request timeout exceeded')), TIMEOUT_MS);
    req.on('error', (error) => {
      finish(error);
    });
    req.write(body);
    req.end();
  });
}
export function publicSlot(slot: ModelSlot | null): ModelSlotView | null {
  if (slot === null) return null;
  const { key, ...safe } = slot;
  return { ...safe, keySet: key !== undefined };
}
