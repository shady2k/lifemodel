/**
 * The loader's password and its one login (lifemodel-q4x.2.1, story S2).
 *
 * What lives here is deliberately small: a digest of the owner's password
 * (scrypt from node:crypto - a slow KDF, so a stolen root-only file is still
 * expensive to open), and a signed session token. The token carries its own
 * expiry and nothing else, so the loader needs no session store and a restart
 * of the loader does not log the owner out.
 *
 * The password itself is never stored, never returned and never logged; only
 * the caller's "refused" or "accepted" verdict is.
 */
import { createHmac, randomBytes, scrypt as scryptKdf, timingSafeEqual } from 'node:crypto';

import { LoaderFatalError } from './errors.js';

/** The name of the one session cookie every host of the instance shares. */
export const SESSION_COOKIE_NAME = 'lm_session';

/** How long a login lasts: a local instance the owner opens from his own machine. */
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The scrypt parameters (N=2^15 costs ~100 ms per attempt on the target box). */
export interface ScryptCost {
  N: number;
  r: number;
  p: number;
  keylen: number;
}

const COST: ScryptCost = { N: 32768, r: 8, p: 1, keylen: 32 };

/** What the loader keeps about the owner's password, in its root-only directory. */
export interface PasswordRecord {
  version: 1;
  algorithm: 'scrypt';
  /** base64 salt, 16 bytes */
  salt: string;
  /** base64 scrypt digest */
  hash: string;
  cost: ScryptCost;
  /** base64 secret every session token is signed with */
  sessionSecret: string;
  createdAt: string;
}

function scryptDigest(password: string, salt: Buffer, cost: ScryptCost): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptKdf(
      password,
      salt,
      cost.keylen,
      { N: cost.N, r: cost.r, p: cost.p, maxmem: 256 * 1024 * 1024 },
      (error, derived) => {
        if (error) reject(error);
        else resolve(derived);
      }
    );
  });
}

/** Hash the owner's password into the record the loader stores. */
export async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = randomBytes(16);
  const digest = await scryptDigest(password, salt, COST);
  return {
    version: 1,
    algorithm: 'scrypt',
    salt: salt.toString('base64'),
    hash: digest.toString('base64'),
    cost: COST,
    sessionSecret: randomBytes(32).toString('base64'),
    createdAt: new Date().toISOString(),
  };
}

function equalDigests(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Is this the owner's password? False for anything else, including a broken record. */
export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
  try {
    const digest = await scryptDigest(password, Buffer.from(record.salt, 'base64'), record.cost);
    return equalDigests(digest, Buffer.from(record.hash, 'base64'));
  } catch {
    return false;
  }
}

function sign(secretBase64: string, payload: string): Buffer {
  return createHmac('sha256', Buffer.from(secretBase64, 'base64')).update(payload).digest();
}

/** A session token: its own expiry, and a signature only this loader can make. */
export function createSession(
  record: PasswordRecord,
  nowMs: number,
  ttlMs: number = DEFAULT_SESSION_TTL_MS
): string {
  const expiresAt = String(nowMs + ttlMs);
  const signature = sign(record.sessionSecret, expiresAt).toString('base64url');
  return `${expiresAt}.${signature}`;
}

/** Does this token carry a signature of this loader's secret and an expiry still ahead? */
export function verifySession(token: string, record: PasswordRecord, nowMs: number): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [expiresAt, signature] = parts;
  if (expiresAt === undefined || signature === undefined) return false;
  const expires = Number(expiresAt);
  if (!Number.isFinite(expires) || expires <= nowMs) return false;
  let presented: Buffer;
  try {
    presented = Buffer.from(signature, 'base64url');
  } catch {
    return false;
  }
  return equalDigests(presented, sign(record.sessionSecret, expiresAt));
}

/**
 * The hosts the loader answers on, and the only ones a cookie may ever be
 * scoped to (rework 2, finding 7). The loader listens on the container's
 * loopback and the only names that reach it are the instance's own: the root
 * host, `boot.` (the loader) and `vault.` (Agent Vault), all under `localhost`
 * today. `127.0.0.1` is the loopback literal `docker exec <c> lifemodel ...`
 * talks to; no browser ever uses it, and no cookie is ever set on it.
 *
 * A configured domain is not part of this stage: it comes with the
 * outside-access idea (lifemodel-sd2), and it will be a configured, vetted
 * value - never a name taken from a request.
 */
export const ALLOWED_HOSTS = [
  'localhost',
  'boot.localhost',
  'vault.localhost',
  '127.0.0.1',
] as const;

/** The name part of a Host header (or of any `host:port` string), lowercased. */
export function hostName(host: string): string {
  return (host.split(':')[0] ?? host).trim().toLowerCase();
}

/** Is this a Host the loader answers on at all? */
export function isAllowedHost(host: string | undefined): boolean {
  return host !== undefined && (ALLOWED_HOSTS as readonly string[]).includes(hostName(host));
}

/**
 * The host every host of the instance shares, or null for a Host the loader
 * does not answer on. `boot.localhost` and `vault.localhost` are both covered
 * by a cookie on `localhost`, which is why the front door's one label is taken
 * off here - but only for a host that is vetted first: a name out of a request
 * never becomes a cookie's Domain.
 */
export function parentDomain(host: string): string | null {
  if (!isAllowedHost(host)) return null;
  const name = hostName(host);
  for (const label of ['boot.', 'vault.']) {
    if (name.startsWith(label)) return name.slice(label.length);
  }
  return name;
}

/** The hosts a browser reaches: the pinned ones, the CLI's loopback literal excluded. */
function isBrowserHost(name: string): boolean {
  return name !== '127.0.0.1' && (ALLOWED_HOSTS as readonly string[]).includes(name);
}

/** The port of a `host:port` string, or '' when it names none (or names nonsense). */
function hostPort(host: string): string {
  const port = host.split(':')[1];
  return port !== undefined && /^\d{1,5}$/.test(port) ? port : '';
}

/**
 * Where a browser without a session is sent (rework 3): the loader's login on
 * the boot host of the same instance and port, carrying where it was going.
 * Built from the pinned names only - the forwarded host is VETTED first and
 * only its port is taken from it - so no request can make the loader send a
 * browser to a name of its choosing. Null for a host the loader does not
 * answer on (the caller then answers 401).
 */
export function loginLocation(forwardedHost: string, forwardedUri: string): string | null {
  const name = hostName(forwardedHost);
  if (!isBrowserHost(name)) return null;
  const domain = parentDomain(forwardedHost);
  if (domain === null) return null;
  const port = hostPort(forwardedHost);
  const authority = (host: string): string => (port === '' ? host : `${host}:${port}`);
  const path = forwardedUri.startsWith('/') && !forwardedUri.startsWith('//') ? forwardedUri : '/';
  const next = `http://${authority(name)}${path}`;
  return `http://${authority(`boot.${domain}`)}/login?next=${encodeURIComponent(next)}`;
}

/**
 * The `next` of a login, or null when it is not an address of this instance.
 * Only an http(s) URL on a pinned browser host AND on the port the login was
 * reached on is followed, so the login page is never an open redirect to
 * somewhere else, not even another local service.
 */
export function vettedNext(next: string | undefined, requestHost: string): string | null {
  if (next === undefined || next === '') return null;
  let url: URL;
  try {
    url = new URL(next);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (!isBrowserHost(url.hostname.toLowerCase())) return null;
  // The same port as the login itself: cookies are not scoped by port, so a
  // `next` on another local port would hand the fresh session to whatever
  // listens there (rework 3, review round 3 finding 3).
  if (url.port !== hostPort(requestHost)) return null;
  return url.href;
}

/** The cookie domain of a vetted host; an unvetted one is a programming error. */
function cookieDomain(host: string): string {
  const domain = parentDomain(host);
  if (domain === null) {
    throw new LoaderFatalError(
      `the loader does not answer on ${host}: its session cookie is only ever set on ${ALLOWED_HOSTS.join(', ')}`
    );
  }
  return domain;
}

/** The Set-Cookie header of a fresh login. */
export function sessionCookie(
  token: string,
  host: string,
  ttlMs: number = DEFAULT_SESSION_TTL_MS
): string {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    `Domain=${cookieDomain(host)}`,
    `Max-Age=${String(Math.floor(ttlMs / 1000))}`,
    'HttpOnly',
    'SameSite=Lax',
  ].join('; ');
}

/** The Set-Cookie header of a logout: the same cookie, emptied. */
export function clearSessionCookie(host: string): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    `Domain=${cookieDomain(host)}`,
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
  ].join('; ');
}

/**
 * The anti-CSRF token of the loader's own forms (rework 2, finding 5).
 *
 * A session cookie is an ambient credential: a browser sends it on a form
 * posted from ANY page of the instance's parent site, and lifemodel - which
 * controls the root host - can serve such a page. So a state-changing form
 * carries this token as well, and it is bound to the session it acts with: it
 * is a signature with the loader's own secret over the session token, so only
 * the loader can make it and only for the session that is logged in.
 */
export function csrfToken(record: PasswordRecord, sessionToken: string): string {
  return sign(record.sessionSecret, `csrf:${sessionToken}`).toString('base64url');
}

/** Is this the token of exactly this session? Timing-safe, and false for junk. */
export function verifyCsrf(
  presented: string,
  record: PasswordRecord,
  sessionToken: string
): boolean {
  const expected = Buffer.from(csrfToken(record, sessionToken));
  const given = Buffer.from(presented);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The host an Origin or Referer header names, or null when it names none. */
function originHost(source: string | undefined): string | null {
  if (source === undefined || source === '') return null;
  try {
    return new URL(source).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Did this request come from a page ON THE HOST IT WAS SENT TO?
 *
 * The browser's `Origin` (a form post always carries one; `Referer` is the
 * fallback) is compared with the request's own Host header, so a form served by
 * the root host - or by any other page on the parent site - cannot drive the
 * loader's own routes. A request that names neither is refused: the loader's
 * forms always come with one.
 */
export function sameOrigin(
  origin: string | undefined,
  referer: string | undefined,
  host: string | undefined
): boolean {
  if (host === undefined || host === '') return false;
  const named = originHost(origin) ?? originHost(referer);
  return named !== null && named === host.trim().toLowerCase();
}

/** The cookies of one request header, by name. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies[name] = value;
  }
  return cookies;
}
