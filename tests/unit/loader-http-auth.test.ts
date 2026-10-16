import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { createLoaderHttp } from '../../loader/src/http.js';
import { loadConfig } from '../../loader/src/config.js';
import { createSession, hashPassword, verifySession } from '../../loader/src/auth.js';
import { createTestClock } from '../../loader/src/clock.js';
import { createRecordingLogger } from '../../loader/src/logger.js';
import type { LoaderState } from '../../loader/src/state.js';

const SERVICE_HOST = 'loader.lifemodel-system.svc.cluster.local';
const servers: Array<ReturnType<typeof createLoaderHttp>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ close }) => close()));
});

async function start(initialAuth: Awaited<ReturnType<typeof hashPassword>> | null) {
  let auth = initialAuth === null ? null : structuredClone(initialAuth);
  const state: LoaderState = {
    ensureLayout: async () => undefined,
    readAuth: async () => (auth === null ? null : structuredClone(auth)),
    writeAuth: async (record) => {
      auth = structuredClone(record);
    },
    replaceAuth: async (record) => {
      auth = structuredClone(record);
    },
  };
  const clock = createTestClock();
  const loader = createLoaderHttp({
    state,
    logger: createRecordingLogger([]),
    clock,
    config: loadConfig({ LIFEMODEL_NAME: 'lifemodel' }),
    pki: {
      bootstrap: async () => {},
      report: async () => ({
        identity: 'present',
        ca: 'present-matching',
        leaf: 'valid',
        sans: [],
        fingerprint: 'x',
      }),
      caPem: async () => 'CA',
    },
  });
  servers.push(loader);
  await new Promise<void>((resolve) => loader.server.listen(0, '127.0.0.1', resolve));
  const address = loader.server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  return { base: `http://127.0.0.1:${address.port}`, clock, getAuth: () => auth };
}

async function request(
  base: string,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
  body?: string
) {
  const url = new URL(path, base);
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>(
    (resolve, reject) => {
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          headers: { host: SERVICE_HOST, ...headers },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
        }
      );
      req.on('error', reject);
      req.end(body);
    }
  );
}

describe('loader ForwardAuth verification host', () => {
  it('accepts a valid session only on the exact verification route at its Service host', async () => {
    const record = await hashPassword('owner password');
    const { base } = await start(record);
    const cookie = `lm_session=${createSession(record, Date.now())}`;

    const response = await request(base, '/_auth/verify', { cookie });
    expect(response.status).toBe(200);

    for (const path of ['/login', '/setup', '/anything']) {
      expect((await request(base, path)).status, path).toBe(400);
    }
    expect((await request(base, '/_auth/verify')).status).toBe(401);
    expect(
      (
        await fetch(`${base}/login`, {
          headers: { host: 'boot-lifemodel.local', origin: 'https://boot-lifemodel.local' },
        })
      ).status
    ).toBe(200);
    expect(
      (
        await fetch(`${base}/setup`, {
          headers: { host: 'boot-lifemodel.local', origin: 'https://boot-lifemodel.local' },
          redirect: 'manual',
        })
      ).status
    ).toBe(303);
    expect((await request(base, '/_auth/verify/extra', { cookie })).status).toBe(400);
  });

  it('requires a session and never redirects to an unvetted forwarded host', async () => {
    const record = await hashPassword('owner password');
    const { base } = await start(record);

    const denied = await request(base, '/_auth/verify', {
      'x-forwarded-method': 'GET',
      'x-forwarded-host': 'attacker.example',
      'x-forwarded-uri': '/private',
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.location).toBeUndefined();

    const browser = await request(base, '/_auth/verify', {
      host: SERVICE_HOST,
      'x-forwarded-method': 'GET',
      'x-forwarded-host': 'lifemodel.local',
      'x-forwarded-uri': '/private',
    });
    expect(browser.status).toBe(303);
    expect(browser.headers.location).toBe(
      'https://boot-lifemodel.local/login?next=https%3A%2F%2Flifemodel.local%2Fprivate'
    );
  });

  it('transfers login through a one-time code and requires the returned cookie to verify', async () => {
    const record = await hashPassword('owner password');
    const { base, clock } = await start(record);
    const login = await request(
      base,
      '/login?next=https%3A%2F%2Flifemodel.local%2Fprivate%3Fx%3D1%23frag',
      {
        host: 'boot-lifemodel.local',
        origin: 'https://boot-lifemodel.local',
        'content-type': 'application/x-www-form-urlencoded',
      },
      'POST',
      'password=owner%20password&next=https%3A%2F%2Flifemodel.local%2Fprivate%3Fx%3D1%23frag'
    );
    expect(login.status).toBe(303);
    const location = String(login.headers.location);
    expect(location).toContain('/_auth/handoff?code=');
    expect(location).toContain('next=%2Fprivate%3Fx%3D1');
    expect(location).not.toContain('session');
    const path = new URL(location).pathname + new URL(location).search;
    const redeemed = await request(base, path, { host: 'lifemodel.local' });
    expect(redeemed.headers.location).toBe('/private?x=1');
    const cookie = String(redeemed.headers['set-cookie'] ?? '');
    expect(cookie).not.toBe('');
    expect(cookie).not.toMatch(/domain=/i);
    const token = cookie.split(';')[0]!.slice('lm_session='.length);
    expect(verifySession(token, record, clock.now())).toBe(true);
    expect((await request(base, '/_auth/verify', { host: SERVICE_HOST, cookie })).status).toBe(200);
    const replay = await request(base, path, { host: 'lifemodel.local' });
    expect(replay.headers['set-cookie']).toBeUndefined();
    expect(replay.headers.location).toBe('https://boot-lifemodel.local/login');
  });

  it('authenticated GET /login and setup both issue handoff redirects', async () => {
    const { base } = await start(null);
    const headers = {
      host: 'boot-lifemodel.local',
      origin: 'https://boot-lifemodel.local',
      'content-type': 'application/x-www-form-urlencoded',
    };
    const setup = await request(
      base,
      '/setup',
      headers,
      'POST',
      'password=owner%20password&next=https%3A%2F%2Flifemodel.local%2Fhome'
    );
    const setupLocation = String(setup.headers.location);
    expect(setupLocation).toContain('/_auth/handoff?code=');
    const login = await request(base, '/login?next=https%3A%2F%2Flifemodel.local%2Fagain', {
      host: 'boot-lifemodel.local',
      cookie: String(setup.headers['set-cookie']).split(';')[0]!,
    });
    expect(String(login.headers.location)).toContain('/_auth/handoff?code=');
  });

  it('rejects expired, unknown and altered handoff codes without setting a cookie', async () => {
    const { base, clock } = await start(null);
    const setup = await request(
      base,
      '/setup',
      {
        host: 'boot-lifemodel.local',
        origin: 'https://boot-lifemodel.local',
        'content-type': 'application/x-www-form-urlencoded',
      },
      'POST',
      'password=p&next=https%3A%2F%2Flifemodel.local%2Fx'
    );
    const handoffUrl = new URL(String(setup.headers.location));
    const handoffPath = handoffUrl.pathname + handoffUrl.search;
    const altered = handoffPath.replace('next=%2Fx', 'next=%2Fother');
    const unknown = '/_auth/handoff?code=unknown&next=%2Fx';
    for (const path of [altered, unknown]) {
      const response = await request(base, path, { host: 'lifemodel.local' });
      expect(response.headers.location).toBe('https://boot-lifemodel.local/login');
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    const sessionCookie = String(setup.headers['set-cookie']).split(';')[0]!;
    const another = await request(base, '/login?next=https%3A%2F%2Flifemodel.local%2Fx', {
      host: 'boot-lifemodel.local',
      cookie: sessionCookie,
    });
    const expiring = new URL(String(another.headers.location), 'https://boot-lifemodel.local');
    clock.advance(60_001);
    const expired = await request(base, expiring.pathname + expiring.search, {
      host: 'lifemodel.local',
    });
    expect(expired.headers.location).toBe('https://boot-lifemodel.local/login');
    expect(expired.headers['set-cookie']).toBeUndefined();
  });

  it('revokes an app-host session obtained by handoff when logging out', async () => {
    const record = await hashPassword('owner password');
    const { base, clock } = await start(record);
    const session = createSession(record, clock.now());
    const { csrfToken } = await import('../../loader/src/auth.js');
    const login = await request(base, '/login?next=https%3A%2F%2Flifemodel.local%2F', {
      host: 'boot-lifemodel.local',
      cookie: `lm_session=${session}`,
    });
    const loginUrl = new URL(String(login.headers.location));
    const handoff = await request(base, loginUrl.pathname + loginUrl.search, {
      host: 'lifemodel.local',
    });
    const appCookie = String(handoff.headers['set-cookie']).split(';')[0]!;
    expect(
      (await request(base, '/_auth/verify', { host: SERVICE_HOST, cookie: appCookie })).status
    ).toBe(200);
    const csrf = csrfToken(record, session);
    const logout = await request(
      base,
      '/logout',
      {
        host: 'boot-lifemodel.local',
        cookie: `lm_session=${session}`,
        origin: 'https://boot-lifemodel.local',
        'content-type': 'application/x-www-form-urlencoded',
      },
      'POST',
      `csrf=${encodeURIComponent(csrf)}`
    );
    expect(logout.status).toBe(303);
    expect(
      (await request(base, '/_auth/verify', { host: SERVICE_HOST, cookie: appCookie })).status
    ).toBe(401);
  });

  it('refuses a pending handoff code after its issuing session is revoked by logout', async () => {
    const record = await hashPassword('owner password');
    const { base, clock } = await start(record);
    const session = createSession(record, clock.now());
    const login = await request(base, '/login?next=https%3A%2F%2Flifemodel.local%2Fprivate', {
      host: 'boot-lifemodel.local',
      cookie: `lm_session=${session}`,
    });
    const handoffUrl = new URL(String(login.headers.location), 'https://boot-lifemodel.local');
    const csrf = (await import('../../loader/src/auth.js')).csrfToken(record, session);
    const logout = await request(
      base,
      '/logout',
      {
        host: 'boot-lifemodel.local',
        cookie: `lm_session=${session}`,
        origin: 'https://boot-lifemodel.local',
        'content-type': 'application/x-www-form-urlencoded',
      },
      'POST',
      `csrf=${encodeURIComponent(csrf)}`
    );
    expect(logout.status).toBe(303);
    const redemption = await request(base, handoffUrl.pathname + handoffUrl.search, {
      host: 'lifemodel.local',
    });
    expect(redemption.headers.location).toBe('https://boot-lifemodel.local/login');
    expect(redemption.headers['set-cookie']).toBeUndefined();
  });

  it('serializes simultaneous logouts: one succeeds and the stale session is refused', async () => {
    const record = await hashPassword('owner password');
    const { base, clock, getAuth } = await start(record);
    const token = createSession(record, clock.now());
    const csrfTokenForSession = (await import('../../loader/src/auth.js')).csrfToken;
    const csrf = csrfTokenForSession(record, token);
    const headers = {
      host: 'boot-lifemodel.local',
      cookie: `lm_session=${token}`,
      origin: 'https://boot-lifemodel.local',
      'content-type': 'application/x-www-form-urlencoded',
    };
    const results = await Promise.all([
      request(base, '/logout', headers, 'POST', `csrf=${encodeURIComponent(csrf)}`),
      request(base, '/logout', headers, 'POST', `csrf=${encodeURIComponent(csrf)}`),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([303, 401]);
    const after = getAuth();
    expect(after).not.toBeNull();
    expect(
      (await request(base, '/_auth/verify', { host: SERVICE_HOST, cookie: `lm_session=${token}` }))
        .status
    ).toBe(401);
  });

  it('never sets a cookie with a Domain attribute on setup, login, logout, or handoff', async () => {
    const { base, clock, getAuth } = await start(null);
    const formHeaders = {
      host: 'boot-lifemodel.local',
      origin: 'https://boot-lifemodel.local',
      'content-type': 'application/x-www-form-urlencoded',
    };
    const setup = await request(base, '/setup', formHeaders, 'POST', 'password=owner%20password');
    expect(setup.status).toBe(303);
    expect(String(setup.headers['set-cookie'])).not.toMatch(/domain=/i);

    const login = await request(base, '/login', formHeaders, 'POST', 'password=owner%20password');
    expect(login.status).toBe(303);
    expect(String(login.headers['set-cookie'])).not.toMatch(/domain=/i);

    const authRecord = getAuth();
    if (authRecord === null) throw new Error('setup did not save auth');
    const token = createSession(authRecord, clock.now());
    const csrf = (await import('../../loader/src/auth.js')).csrfToken(authRecord, token);
    const logout = await request(
      base,
      '/logout',
      { ...formHeaders, cookie: `lm_session=${token}` },
      'POST',
      `csrf=${encodeURIComponent(csrf)}`
    );
    expect(logout.status).toBe(303);
    expect(String(logout.headers['set-cookie'])).not.toMatch(/domain=/i);

    const handoffRecord = authRecord;
    const handoffLogin = await request(base, '/login?next=https%3A%2F%2Flifemodel.local%2F', {
      host: 'boot-lifemodel.local',
      cookie: `lm_session=${createSession(handoffRecord, clock.now())}`,
    });
    const handoffUrl = new URL(
      String(handoffLogin.headers.location),
      'https://boot-lifemodel.local'
    );
    const handoff = await request(base, handoffUrl.pathname + handoffUrl.search, {
      host: 'lifemodel.local',
    });
    expect(String(handoff.headers['set-cookie'])).not.toMatch(/domain=/i);
  });
});
