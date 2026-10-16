/**
 * The loader's login (lifemodel-q4x.2.1, story S2).
 *
 * The password is kept as a slow-KDF digest in a root-only file, never as
 * text and never in a log; host-only Secure cookies are handed off separately
 * between the boot, app and vault hosts.
 */
import { describe, expect, it } from 'vitest';

import {
  clearSessionCookie,
  configureInstanceName,
  createSession,
  csrfToken,
  hashPassword,
  isAllowedHost,
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
  it('is named __Host-lm_session and is Secure, host-only, HttpOnly, Lax and Path=/', async () => {
    const record = await hashPassword('right');
    const token = createSession(record, NOW, TTL_MS);
    const cookie = sessionCookie(token, 'boot-lifemodel.local', TTL_MS);

    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=${token}`);
    expect(cookie.toLowerCase()).not.toContain('domain=');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain(`Max-Age=${TTL_MS / 1000}`);
  });

  it('sets host-only cookies for each allowed host', () => {
    for (const host of [
      'boot-lifemodel.local',
      'lifemodel.local',
      'vault-lifemodel.local',
      '127.0.0.1:7000',
    ])
      expect(sessionCookie('t', host).toLowerCase()).not.toContain('domain=');
  });

  it('answers on its own hosts, with or without a port, and on nothing else', () => {
    expect(isAllowedHost('lifemodel.local')).toBe(true);
    expect(isAllowedHost('boot-lifemodel.local:8080')).toBe(true);
    expect(isAllowedHost('BOOT-LIFEMODEL.local')).toBe(true);
    expect(isAllowedHost('vault-lifemodel.local')).toBe(true);
    expect(isAllowedHost('127.0.0.1:7000')).toBe(true);
    expect(isAllowedHost('example.com')).toBe(false);
    expect(isAllowedHost('boot-lifemodel.local.attacker.test')).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
    configureInstanceName('home');
    expect(isAllowedHost('boot-home.local')).toBe(true);
    expect(isAllowedHost('boot-lifemodel.local')).toBe(false);
    configureInstanceName('lifemodel');
  });

  it('clears the cookie the same way it was set', () => {
    const cleared = clearSessionCookie('boot-lifemodel.local');

    expect(cleared).toContain('__Host-lm_session=;');
    expect(cleared.toLowerCase()).not.toContain('domain=');
    expect(cleared).toContain('Path=/');
    expect(cleared).toContain('HttpOnly');
    expect(cleared).toContain('Secure');
    expect(cleared).toContain('SameSite=Lax');
    expect(cleared).toContain('Max-Age=0');
  });
});

describe('the Cookie request header', () => {
  it('reads the named cookie among the others and tolerates an absent header', () => {
    expect(parseCookies('a=1; __Host-lm_session=abc.def; b=2')).toEqual({
      a: '1',
      '__Host-lm_session': 'abc.def',
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
  it('requires exact configured HTTPS origin and never uses Referer', () => {
    expect(sameOrigin('https://boot-lifemodel.local', undefined, 'boot-lifemodel.local')).toBe(
      true
    );
    for (const origin of [
      'https:boot-lifemodel.local',
      'https:///boot-lifemodel.local',
      ' https://boot-lifemodel.local ',
      'https://boot-lifemodel.local/path',
      'https://user@boot-lifemodel.local',
      'http://boot-lifemodel.local',
      'https://lifemodel.local',
      'https://boot-lifemodel.local:444',
      'null',
      'not a url',
      undefined,
    ])
      expect(sameOrigin(origin, 'https://boot-lifemodel.local/page', 'boot-lifemodel.local')).toBe(
        false
      );
    expect(sameOrigin('https://BOOT-LIFEMODEL.local:443', undefined, 'boot-lifemodel.local')).toBe(
      true
    );
  });
});
