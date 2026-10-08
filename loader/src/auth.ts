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

/** The labels the front door puts in front of the instance's own host. */
const APP_PREFIXES = ['boot', 'vault', 'app'];

/**
 * The host every host of the instance shares: `boot.localhost` and
 * `vault.localhost` are both covered by a cookie on `localhost`. The loader's
 * own interface is reached as `boot.<host>`, which is what makes this
 * derivation from the request alone safe.
 */
export function parentDomain(host: string): string {
  const name = host.split(':')[0]?.toLowerCase() ?? host.toLowerCase();
  const labels = name.split('.');
  const first = labels[0];
  if (labels.length > 1 && first !== undefined && APP_PREFIXES.includes(first)) {
    return labels.slice(1).join('.');
  }
  return name;
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
    `Domain=${parentDomain(host)}`,
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
    `Domain=${parentDomain(host)}`,
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
  ].join('; ');
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
