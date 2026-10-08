/**
 * The loader's login (lifemodel-q4x.2.1, story S2).
 *
 * The password is kept as a slow-KDF digest in a root-only file, never as
 * text and never in a log; one session cookie on the parent domain opens
 * boot.<host>, <host> and vault.<host>.
 */
import { describe, expect, it } from 'vitest';

import {
  clearSessionCookie,
  createSession,
  hashPassword,
  parentDomain,
  parseCookies,
  SESSION_COOKIE_NAME,
  sessionCookie,
  verifyPassword,
  verifySession,
} from '../../loader/src/auth.js';

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

describe('the loader password', () => {
  it('accepts the password it hashed and refuses every other one', async () => {
    const record = await hashPassword('correct horse battery staple');

    expect(await verifyPassword('correct horse battery staple', record)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', record)).toBe(false);
    expect(await verifyPassword('', record)).toBe(false);
  });

  it('keeps the password out of the record and salts each hash', async () => {
    const first = await hashPassword('same password');
    const second = await hashPassword('same password');

    expect(JSON.stringify(first)).not.toContain('same password');
    expect(first.hash).not.toBe(second.hash);
    expect(first.salt).not.toBe(second.salt);
    expect(first.algorithm).toBe('scrypt');
    expect(first.cost.N).toBeGreaterThanOrEqual(16384);
  });

  it('refuses a record whose digest was edited', async () => {
    const record = await hashPassword('right');
    const edited = { ...record, hash: record.hash.slice(0, 4) + 'AAAA' + record.hash.slice(8) };

    expect(await verifyPassword('right', edited)).toBe(false);
  });
});

describe('the loader session', () => {
  it('accepts the token it signed and refuses an edited or expired one', async () => {
    const record = await hashPassword('right');
    const token = createSession(record, NOW, TTL_MS);

    expect(verifySession(token, record, NOW)).toBe(true);
    expect(verifySession(token, record, NOW + TTL_MS - 1)).toBe(true);
    expect(verifySession(`${token}x`, record, NOW)).toBe(false);
    expect(verifySession(token, record, NOW + TTL_MS + 1)).toBe(false);
    expect(verifySession('', record, NOW)).toBe(false);
    expect(verifySession('not-a-token', record, NOW)).toBe(false);
  });

  it('refuses a token signed with another loader secret', async () => {
    const mine = await hashPassword('right');
    const other = await hashPassword('right');
    const token = createSession(other, NOW, TTL_MS);

    expect(verifySession(token, mine, NOW)).toBe(false);
  });
});

describe('the session cookie', () => {
  it('is named lm_session and carries the parent domain, HttpOnly, Lax and Path=/', async () => {
    const record = await hashPassword('right');
    const token = createSession(record, NOW, TTL_MS);
    const cookie = sessionCookie(token, 'boot.localhost', TTL_MS);

    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=${token}`);
    expect(cookie).toContain('Domain=localhost');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain(`Max-Age=${TTL_MS / 1000}`);
  });

  it('takes the cookie domain from the host the owner logged in on', () => {
    expect(parentDomain('boot.localhost')).toBe('localhost');
    expect(parentDomain('boot.localhost:8080')).toBe('localhost');
    expect(parentDomain('localhost')).toBe('localhost');
    expect(parentDomain('vault.localhost')).toBe('localhost');
    expect(parentDomain('boot.example.com')).toBe('example.com');
    expect(parentDomain('vault.example.com')).toBe('example.com');
    expect(parentDomain('example.com')).toBe('example.com');
    expect(parentDomain('lifemodel.example.com:443')).toBe('lifemodel.example.com');
  });

  it('clears the cookie the same way it was set', () => {
    const cleared = clearSessionCookie('boot.localhost');

    expect(cleared).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(cleared).toContain('Domain=localhost');
    expect(cleared).toContain('Max-Age=0');
  });
});

describe('the Cookie request header', () => {
  it('reads the named cookie among the others and tolerates an absent header', () => {
    expect(parseCookies('a=1; lm_session=abc.def; b=2')).toEqual({
      a: '1',
      lm_session: 'abc.def',
      b: '2',
    });
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
  });
});
