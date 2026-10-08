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
  csrfToken,
  hashPassword,
  isAllowedHost,
  parentDomain,
  parseCookies,
  sameOrigin,
  SESSION_COOKIE_NAME,
  sessionCookie,
  verifyCsrf,
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
    // The loopback literal the command line uses: itself, never `0.0.1`.
    expect(parentDomain('127.0.0.1:7000')).toBe('127.0.0.1');
  });

  it('derives no domain at all from a host it does not answer on', () => {
    // A name out of a request never becomes a cookie's Domain (rework 2,
    // finding 7): only the instance's own hosts are vetted.
    expect(parentDomain('boot.example.com')).toBeNull();
    expect(parentDomain('vault.example.com')).toBeNull();
    expect(parentDomain('example.com')).toBeNull();
    expect(parentDomain('lifemodel.example.com:443')).toBeNull();
    expect(parentDomain('evil.localhost.attacker.test')).toBeNull();
    expect(() => sessionCookie('a.b', 'boot.example.com')).toThrow(/does not answer on/);
    expect(() => clearSessionCookie('example.com')).toThrow(/does not answer on/);
  });

  it('answers on its own hosts, with or without a port, and on nothing else', () => {
    expect(isAllowedHost('localhost')).toBe(true);
    expect(isAllowedHost('boot.localhost:8080')).toBe(true);
    expect(isAllowedHost('BOOT.Localhost')).toBe(true);
    expect(isAllowedHost('vault.localhost')).toBe(true);
    expect(isAllowedHost('127.0.0.1:7000')).toBe(true);
    expect(isAllowedHost('example.com')).toBe(false);
    expect(isAllowedHost('boot.localhost.attacker.test')).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
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

describe('the anti-CSRF token of a form', () => {
  it('is the token of exactly one session, and junk is refused', async () => {
    const record = await hashPassword('right');
    const token = createSession(record, NOW, TTL_MS);
    const other = createSession(record, NOW + 1, TTL_MS);
    const csrf = csrfToken(record, token);

    expect(verifyCsrf(csrf, record, token)).toBe(true);
    expect(verifyCsrf(csrf, record, other)).toBe(false);
    expect(verifyCsrf('', record, token)).toBe(false);
    expect(verifyCsrf(csrf.slice(0, -1), record, token)).toBe(false);
    // Another loader's secret makes no token of this one.
    const foreign = await hashPassword('right');
    expect(verifyCsrf(csrfToken(foreign, token), record, token)).toBe(false);
  });
});

describe('the Origin of a state-changing request', () => {
  it('must name the host the request was sent to', () => {
    expect(sameOrigin('http://boot.localhost:8080', undefined, 'boot.localhost:8080')).toBe(true);
    expect(sameOrigin('http://BOOT.localhost', undefined, 'boot.localhost')).toBe(true);
    // The root host's page is another origin: this is the attack (finding 5).
    expect(sameOrigin('http://localhost:8080', undefined, 'boot.localhost:8080')).toBe(false);
    expect(sameOrigin('https://attacker.test', undefined, 'boot.localhost:8080')).toBe(false);
    expect(sameOrigin(undefined, undefined, 'boot.localhost:8080')).toBe(false);
    expect(sameOrigin('null', undefined, 'boot.localhost:8080')).toBe(false);
  });

  it('falls back to the Referer, and only to its host', () => {
    expect(
      sameOrigin(undefined, 'http://boot.localhost:8080/panic?x=1', 'boot.localhost:8080')
    ).toBe(true);
    expect(sameOrigin(undefined, 'http://localhost:8080/', 'boot.localhost:8080')).toBe(false);
    expect(sameOrigin(undefined, 'not a url', 'boot.localhost:8080')).toBe(false);
    // Origin wins over Referer when both are there.
    expect(
      sameOrigin('http://localhost:8080', 'http://boot.localhost:8080/', 'boot.localhost:8080')
    ).toBe(false);
  });
});
