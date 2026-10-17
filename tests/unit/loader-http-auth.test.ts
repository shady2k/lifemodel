import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createLoaderHttp } from '../../loader/src/http.js';
import { createNodeFileSystem } from '../../loader/src/fs.js';
import { createLoaderState } from '../../loader/src/state.js';
import { loadConfig } from '../../loader/src/config.js';
import { createSession, hashPassword, verifySession } from '../../loader/src/auth.js';
import { createTestClock } from '../../loader/src/clock.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';
import { ModelCheckError, type ModelSlots, type ModelSlot } from '../../loader/src/model.js';
import type { LoaderState } from '../../loader/src/state.js';

const SERVICE_HOST = 'loader.lifemodel-system.svc.cluster.local';
const servers: Array<ReturnType<typeof createLoaderHttp>> = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ close }) => close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function start(
  initialAuth: Awaited<ReturnType<typeof hashPassword>> | null,
  uiRoot?: string,
  modelSlots?: import('../../loader/src/model.js').ModelSlots,
  modelChecker?: (
    slot: import('../../loader/src/model.js').ModelSlot,
    slotName?: 'primary' | 'reserve'
  ) => Promise<void>,
  customState?: LoaderState
) {
  let auth = initialAuth === null ? null : structuredClone(initialAuth);
  let onboardingSaves = 0;
  const state: LoaderState = customState ?? {
    ensureLayout: async () => undefined,
    readAuth: async () => (auth === null ? null : structuredClone(auth)),
    writeAuth: async (record) => {
      auth = structuredClone(record);
    },
    replaceAuth: async (record) => {
      auth = structuredClone(record);
    },
    saveModelOnboarding: async () => {
      onboardingSaves += 1;
    },
  };
  const clock = createTestClock();
  const recorded: RecordedLine[] = [];
  const loader = createLoaderHttp({
    state,
    logger: createRecordingLogger(recorded),
    clock,
    config: loadConfig({ LIFEMODEL_NAME: 'lifemodel' }),
    ...(uiRoot === undefined ? {} : { uiRoot }),
    ...(modelSlots === undefined ? {} : { modelSlots }),
    ...(modelChecker === undefined ? {} : { modelChecker }),
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
  return {
    base: `http://127.0.0.1:${address.port}`,
    clock,
    getAuth: () => auth,
    recorded,
    getOnboardingSaves: () => onboardingSaves,
  };
}

async function request(
  base: string,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
  body?: string
) {
  const url = new URL(path, base);
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          host: SERVICE_HOST,
          ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }),
          ...Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined)),
        },
      },
      (res) => {
        let responseBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (responseBody += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: responseBody })
        );
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('loader ForwardAuth and JSON authentication API', () => {
  it('accepts a valid session only on the exact service verification route', async () => {
    const record = await hashPassword('owner password');
    const { base } = await start(record);
    const cookie = `__Host-lm_session=${createSession(record, Date.now())}`;
    expect((await request(base, '/_auth/verify', { cookie })).status).toBe(200);
    expect((await request(base, '/_auth/verify/extra', { cookie })).status).toBe(404);
    expect((await request(base, '/_auth/verify')).status).toBe(401);
  });

  it('requires a session and does not redirect to an unvetted forwarded host', async () => {
    const record = await hashPassword('owner password');
    const { base } = await start(record);
    const denied = await request(base, '/_auth/verify', {
      'x-forwarded-method': 'GET',
      'x-forwarded-host': 'attacker.example',
      'x-forwarded-uri': '/private',
    });
    expect(denied.status).toBe(303);
    expect(denied.headers.location).toBe(
      'https://boot-lifemodel.local/login?next=https%3A%2F%2Flifemodel.local%2Fprivate'
    );
  });

  it('refuses a wrong password and issues a verifying host-only cookie for the right password', async () => {
    const record = await hashPassword('owner password');
    const { base, clock } = await start(record);
    const headers = {
      host: 'boot-lifemodel.local',
      origin: 'https://boot-lifemodel.local',
      'content-type': 'application/json',
    };
    expect(
      (await request(base, '/api/login', headers, 'POST', JSON.stringify({ password: 'wrong' })))
        .status
    ).toBe(401);
    const good = await request(
      base,
      '/api/login',
      headers,
      'POST',
      JSON.stringify({ password: 'owner password' })
    );
    expect(good.status).toBe(200);
    const cookie = String(good.headers['set-cookie']);
    expect(cookie).toContain('__Host-lm_session=');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie.toLowerCase()).not.toContain('domain=');
    const token = cookie.split(';')[0]!.slice('__Host-lm_session='.length);
    expect(verifySession(token, record, clock.now())).toBe(true);
    expect((await request(base, '/_auth/verify', { cookie: cookie.split(';')[0]! })).status).toBe(
      200
    );
  });

  it('transfers login through a one-time handoff ticket and the cookie verifies', async () => {
    const record = await hashPassword('owner password');
    const { base, clock } = await start(record);
    const login = await request(
      base,
      '/api/login',
      {
        host: 'boot-lifemodel.local',
        origin: 'https://boot-lifemodel.local',
        'content-type': 'application/json',
      },
      'POST',
      JSON.stringify({
        password: 'owner password',
        next: 'https://lifemodel.local/private?x=1#frag',
      })
    );
    expect(login.status).toBe(200);
    const location = JSON.parse(String(login.body))['redirectTo'] as string;
    expect(location).toContain('/_auth/handoff?code=');
    expect(location).toContain('next=%2Fprivate%3Fx%3D1');
    expect(location).not.toContain('session');
    const path = new URL(location).pathname + new URL(location).search;
    const redeemed = await request(base, path, { host: 'lifemodel.local' });
    expect(redeemed.headers.location).toBe('/private?x=1');
    expect(redeemed.headers['referrer-policy']).toBe('no-referrer');
    const cookie = String(redeemed.headers['set-cookie']);
    expect(cookie).toContain('__Host-lm_session=');
    const token = cookie.split(';')[0]!.slice('__Host-lm_session='.length);
    expect(verifySession(token, record, clock.now())).toBe(true);
    expect((await request(base, '/_auth/verify', { cookie: cookie.split(';')[0]! })).status).toBe(
      200
    );
    expect(
      (await request(base, path, { host: 'lifemodel.local' })).headers['set-cookie']
    ).toBeUndefined();
  });

  it('preserves a vetted app destination through first-visit setup and creates its handoff ticket', async () => {
    const { base } = await start(null);
    const requested = 'https://lifemodel.local/private?from=setup';
    const entry = await request(base, `/?next=${encodeURIComponent(requested)}`, {
      host: 'boot-lifemodel.local',
    });
    expect(entry.status).toBe(303);
    expect(entry.headers.location).toBe(`/setup?next=${encodeURIComponent(requested)}`);
    const setup = await request(
      base,
      '/api/setup',
      {
        host: 'boot-lifemodel.local',
        origin: 'https://boot-lifemodel.local',
        'content-type': 'application/json',
      },
      'POST',
      JSON.stringify({ password: 'secure owner password', next: requested })
    );
    expect(setup.status).toBe(200);
    const redirectTo = JSON.parse(String(setup.body))['redirectTo'] as string;
    expect(redirectTo).toMatch(/^https:\/\/lifemodel\.local\/_auth\/handoff\?code=/);
    expect(redirectTo).toContain(`next=${encodeURIComponent('/private?from=setup')}`);
    const rejected = await request(
      base,
      '/api/setup',
      {
        host: 'boot-lifemodel.local',
        origin: 'https://boot-lifemodel.local',
        'content-type': 'application/json',
      },
      'POST',
      JSON.stringify({ password: 'another secure password', next: 'https://attacker.example/' })
    );
    expect(rejected.status).toBe(400);
  });

  it('creates setup once under concurrent requests and rejects wrong content type and Origin', async () => {
    const { base } = await start(null);
    const headers = {
      host: 'boot-lifemodel.local',
      origin: 'https://boot-lifemodel.local',
      'content-type': 'application/json',
    };
    const [a, b] = await Promise.all([
      request(
        base,
        '/api/setup',
        headers,
        'POST',
        JSON.stringify({ password: 'secure owner password' })
      ),
      request(
        base,
        '/api/setup',
        headers,
        'POST',
        JSON.stringify({ password: 'other secure password' })
      ),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const anonymousAfterSetup = await request(base, '/api/state', {
      host: 'boot-lifemodel.local',
      cookie: '__Host-lm_session=expired.invalid',
    });
    expect(JSON.parse(anonymousAfterSetup.body)).toEqual({ setupNeeded: false, loggedIn: false });
    expect(anonymousAfterSetup.body).not.toContain('csrfToken');
    expect(anonymousAfterSetup.body).not.toContain('onboarding');
    expect(
      (
        await request(
          base,
          '/api/setup',
          { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
          'POST',
          'password=x'
        )
      ).status
    ).toBe(415);
    expect(
      (
        await request(
          base,
          '/api/setup',
          { host: 'boot-lifemodel.local', 'content-type': 'application/json' },
          'POST',
          JSON.stringify({ password: 'secure owner password' })
        )
      ).status
    ).toBe(403);
  });

  it('rejects invalid next destinations and only issues a ticket for the exact app host', async () => {
    const record = await hashPassword('owner password');
    const { base } = await start(record);
    for (const next of [
      'https://evil.example/',
      'https://lifemodel.local\\private',
      '//evil.example/',
      'https://vault-lifemodel.local/',
    ]) {
      const response = await request(
        base,
        '/api/login',
        {
          host: 'boot-lifemodel.local',
          origin: 'https://boot-lifemodel.local',
          'content-type': 'application/json',
        },
        'POST',
        JSON.stringify({ password: 'owner password', next })
      );
      expect(response.status).toBe(400);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    const relative = await request(
      base,
      '/api/login',
      {
        host: 'boot-lifemodel.local',
        origin: 'https://boot-lifemodel.local',
        'content-type': 'application/json',
      },
      'POST',
      JSON.stringify({ password: 'owner password', next: '/settings' })
    );
    expect(relative.status).toBe(200);
    expect(JSON.parse(relative.body).redirectTo).toContain('/settings');
  });

  it('requires a JSON object and rejects invalid or oversized request bodies', async () => {
    const { base } = await start(null);
    const headers = {
      host: 'boot-lifemodel.local',
      origin: 'https://boot-lifemodel.local',
      'content-type': 'application/json',
    };
    for (const body of ['null', '[]', '"x"', '{']) {
      const result = await request(base, '/api/setup', headers, 'POST', body);
      expect(result.status).toBe(400);
      expect(
        await (async () =>
          (await request(base, '/api/state', { host: 'boot-lifemodel.local' })).body)()
      ).toContain('"setupNeeded":true');
    }
    expect((await request(base, '/api/setup', headers, 'POST', ' '.repeat(8193))).status).toBe(413);
    const multibyte = JSON.stringify({ password: 'x'.repeat(8188) + '€' });
    expect(Buffer.byteLength(multibyte, 'utf8')).toBeGreaterThan(8192);
    expect((await request(base, '/api/setup', headers, 'POST', multibyte)).status).toBe(413);
  });

  it('rejects text/plain JSON, a full invalid login Origin matrix, and anonymous CSRF state', async () => {
    const { base } = await start(null);
    const body = JSON.stringify({ password: 'secure owner password' });
    expect(
      (
        await request(
          base,
          '/api/setup',
          {
            host: 'boot-lifemodel.local',
            origin: 'https://boot-lifemodel.local',
            'content-type': 'text/plain',
          },
          'POST',
          body
        )
      ).status
    ).toBe(415);
    const loginRecord = await hashPassword('secure owner password');
    const setupServer = await start(loginRecord);
    for (const origin of [
      undefined,
      'null',
      'malformed',
      'http://boot-lifemodel.local',
      'https://boot-sibling.local',
      'https://boot-lifemodel.local:444',
    ]) {
      const response = await request(
        setupServer.base,
        '/api/login',
        {
          host: 'boot-lifemodel.local',
          'content-type': 'application/json',
          referer: 'https://boot-lifemodel.local/',
          ...(origin === undefined ? {} : { origin }),
        },
        'POST',
        body
      );
      expect(response.status).toBe(403);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(
      JSON.parse((await request(base, '/api/state', { host: 'boot-lifemodel.local' })).body)
    ).toEqual({ setupNeeded: true, loggedIn: false });
    const state = await request(setupServer.base, '/api/state', { host: 'boot-lifemodel.local' });
    expect(JSON.parse(state.body)).toEqual({ setupNeeded: false, loggedIn: false });
    expect(state.body).not.toContain('csrfToken');
    expect(state.body).not.toContain('onboarding');
  });

  it('keeps a valid boot session return destination through login navigation', async () => {
    const record = await hashPassword('owner password');
    const { base, clock } = await start(record);
    const cookie = `__Host-lm_session=${createSession(record, clock.now())}`;
    const response = await request(base, '/login?next=https%3A%2F%2Flifemodel.local%2F', {
      host: 'boot-lifemodel.local',
      cookie,
    });
    expect(response.status).toBe(303);
    expect(response.headers.location).toMatch(/^https:\/\/lifemodel\.local\/_auth\/handoff\?code=/);
  });

  it('logout rotates the secret, clearing every session and pending handoff', async () => {
    const record = await hashPassword('owner password');
    const { base, clock } = await start(record);
    const token = createSession(record, clock.now());
    const csrf = (await import('../../loader/src/auth.js')).csrfToken(record, token);
    const login = await request(
      base,
      '/api/login',
      {
        host: 'boot-lifemodel.local',
        cookie: `__Host-lm_session=${token}`,
        origin: 'https://boot-lifemodel.local',
        'content-type': 'application/json',
      },
      'POST',
      JSON.stringify({ password: 'owner password', next: 'https://lifemodel.local/private' })
    );
    const handoff = new URL(
      String(JSON.parse(String(login.body))['redirectTo']),
      'https://boot-lifemodel.local'
    );
    const out = await request(
      base,
      '/api/logout',
      {
        host: 'boot-lifemodel.local',
        cookie: `__Host-lm_session=${token}`,
        origin: 'https://boot-lifemodel.local',
        'x-csrf-token': csrf,
      },
      'POST'
    );
    expect(out.status).toBe(200);
    expect(String(out.headers['set-cookie'])).toContain('__Host-lm_session=;');
    expect(
      (await request(base, '/_auth/verify', { cookie: `__Host-lm_session=${token}` })).status
    ).toBe(401);
    const redeemed = await request(base, handoff.pathname + handoff.search, {
      host: 'lifemodel.local',
    });
    expect(redeemed.status).toBe(303);
    expect(redeemed.headers.location).toBe('https://boot-lifemodel.local/login');
    expect(redeemed.headers['set-cookie']).toBeUndefined();
  });

  it('admits GET /api/model only with a session and same-origin Fetch Metadata', async () => {
    const record = await hashPassword('owner password');
    const { base, clock } = await start(record);
    const cookie = `__Host-lm_session=${createSession(record, clock.now())}`;
    expect((await request(base, '/api/model', { host: 'boot-lifemodel.local' })).status).toBe(403);
    expect(
      (
        await request(base, '/api/model', {
          host: 'boot-lifemodel.local',
          cookie,
          origin: 'https://boot-lifemodel.local',
        })
      ).status
    ).toBe(503);
    for (const headers of [
      { cookie, origin: 'https://boot-sibling.local' },
      { cookie, origin: 'http://boot-lifemodel.local' },
      { cookie, origin: 'https://boot-lifemodel.local:444' },
      { cookie, origin: 'garbage' },
      { cookie, 'sec-fetch-site': 'same-site' },
    ])
      expect(
        (await request(base, '/api/model', { host: 'boot-lifemodel.local', ...headers })).status
      ).toBe(403);
  });

  it('requires a CSRF token for logout', async () => {
    const record = await hashPassword('owner password');
    const { base, clock } = await start(record);
    const token = createSession(record, clock.now());
    const response = await request(
      base,
      '/api/logout',
      {
        host: 'boot-lifemodel.local',
        cookie: `__Host-lm_session=${token}`,
        origin: 'https://boot-lifemodel.local',
        'content-type': 'application/json',
      },
      'POST'
    );
    expect(response.status).toBe(403);
    expect(
      (await request(base, '/_auth/verify', { cookie: `__Host-lm_session=${token}` })).status
    ).toBe(200);
  });

  it('applies a per-route method matrix and rejects missing, null or sibling Origin on writes', async () => {
    const { base } = await start(null);
    for (const path of ['/login', '/setup'])
      expect((await request(base, path, { host: 'boot-lifemodel.local' }, 'POST')).status).toBe(
        405
      );
    for (const [path, allowed] of [
      ['/api/state', 'GET'],
      ['/api/setup', 'POST'],
      ['/api/login', 'POST'],
      ['/api/logout', 'POST'],
    ] as const) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
        if (method !== allowed)
          expect(
            (await request(base, path, { host: 'boot-lifemodel.local' }, method)).status,
            path + method
          ).toBe(405);
    }
    for (const origin of [
      undefined,
      'null',
      'malformed',
      'http://boot-lifemodel.local',
      'https://boot-sibling.local',
      'https://boot-lifemodel.local:444',
    ]) {
      expect(
        (
          await request(
            base,
            '/api/setup',
            {
              host: 'boot-lifemodel.local',
              'content-type': 'application/json',
              referer: 'https://boot-lifemodel.local/',
              ...(origin === undefined ? {} : { origin }),
            },
            'POST',
            JSON.stringify({ password: 'secure owner password' })
          )
        ).status
      ).toBe(403);
    }
  });
});

describe('loader static UI and JSON API', () => {
  it('serves the built app and anonymous state without core or web dependencies', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'loader-ui-fixture-'));
    roots.push(fixture);
    mkdirSync(join(fixture, 'assets'));
    writeFileSync(join(fixture, 'index.html'), '<!doctype html><main>loader fixture</main>');
    writeFileSync(join(fixture, 'favicon.svg'), '<svg/>');
    writeFileSync(join(fixture, 'assets', 'index-BCR7Kdqf.js'), 'void 0');
    const { base } = await start(null, fixture);
    const shell = await request(base, '/setup', { host: 'boot-lifemodel.local' });
    expect(shell.status).toBe(200);
    expect(shell.headers['content-security-policy']).toBeDefined();
    expect(shell.headers['cache-control']).toBe('no-cache');
    const favicon = await request(base, '/favicon.svg', { host: 'boot-lifemodel.local' });
    expect(favicon.status).toBe(200);
    expect(favicon.headers['content-type']).toContain('image/svg+xml');
    expect(favicon.body).toContain('<svg');
    expect(
      (await request(base, '/assets/index-BCR7Kdqf.js', { host: 'boot-lifemodel.local' })).headers[
        'cache-control'
      ]
    ).toContain('immutable');
    const state = await request(base, '/api/state', { host: 'boot-lifemodel.local' });
    expect(state.status).toBe(200);
    expect(state.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(state.body)).toEqual({ setupNeeded: true, loggedIn: false });
    expect((await request(base, '/api/unknown', { host: 'boot-lifemodel.local' })).status).toBe(
      404
    );
    expect((await request(base, '/', { host: 'unknown.local' })).status).toBe(404);
  });

  it('returns strict method errors and creates a password once under concurrent setup', async () => {
    const { base } = await start(null);
    for (const [path, method] of [
      ['/api/state', 'POST'],
      ['/api/setup', 'GET'],
      ['/api/login', 'DELETE'],
      ['/api/logout', 'PUT'],
    ] as const) {
      expect((await request(base, path, { host: 'boot-lifemodel.local' }, method)).status).toBe(
        405
      );
    }
    const headers = {
      host: 'boot-lifemodel.local',
      origin: 'https://boot-lifemodel.local',
      'content-type': 'application/json',
    };
    const [first, second] = await Promise.all([
      request(
        base,
        '/api/setup',
        headers,
        'POST',
        JSON.stringify({ password: 'secure owner password' })
      ),
      request(
        base,
        '/api/setup',
        headers,
        'POST',
        JSON.stringify({ password: 'another secure password' })
      ),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const winner = first.status === 200 ? first : second;
    const cookie = String(winner.headers['set-cookie'] ?? '');
    expect(cookie).toContain('__Host-lm_session=');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(
      (
        await request(base, '/api/state', {
          host: 'boot-lifemodel.local',
          cookie: cookie.split(';')[0]!,
        })
      ).status
    ).toBe(200);
  });

  it('rejects non-JSON login content type before checking credentials', async () => {
    const record = await hashPassword('owner password');
    const { base } = await start(record);
    const response = await request(
      base,
      '/api/login',
      {
        host: 'boot-lifemodel.local',
        origin: 'https://boot-lifemodel.local',
        'content-type': 'text/plain',
      },
      'POST',
      JSON.stringify({ password: 'owner password' })
    );
    expect(response.status).toBe(415);
  });

  it('rejects form content type and missing Origin for setup', async () => {
    const { base } = await start(null);
    expect(
      (
        await request(
          base,
          '/api/setup',
          {
            host: 'boot-lifemodel.local',
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'https://boot-lifemodel.local',
          },
          'POST',
          'password=secure'
        )
      ).status
    ).toBe(415);
    expect(
      (
        await request(
          base,
          '/api/setup',
          { host: 'boot-lifemodel.local', 'content-type': 'application/json' },
          'POST',
          JSON.stringify({ password: 'secure owner password' })
        )
      ).status
    ).toBe(403);
  });
  it('applies the admission and exact JSON body matrix to every model route', async () => {
    const record = await hashPassword('owner password');
    const saved: Record<string, ModelSlot | null> = { primary: null, reserve: null };
    const slots: ModelSlots = {
      read: async (slot) => saved[slot],
      write: async (slot, value) => {
        saved[slot] = value;
      },
      clearReserve: async () => {
        saved.reserve = null;
      },
    };
    const { base, clock, getOnboardingSaves } = await start(
      record,
      undefined,
      slots,
      async () => {}
    );
    const token = createSession(record, clock.now());
    const cookie = `__Host-lm_session=${token}`;
    const csrf = JSON.parse(
      (await request(base, '/api/state', { host: 'boot-lifemodel.local', cookie })).body
    ).csrfToken as string;
    const good = {
      host: 'boot-lifemodel.local',
      cookie,
      origin: 'https://boot-lifemodel.local',
      'content-type': 'application/json',
      'x-csrf-token': csrf,
    };
    const writes = [
      {
        path: '/api/model/primary',
        method: 'PUT',
        body: JSON.stringify({ kind: 'openai', baseUrl: 'https://models.example/v1', model: 'm' }),
      },
      {
        path: '/api/model/reserve',
        method: 'PUT',
        body: JSON.stringify({ kind: 'openai', baseUrl: 'https://models.example/v1', model: 'm' }),
      },
      { path: '/api/model/reserve', method: 'DELETE', body: '{}' },
    ];
    for (const route of writes) {
      expect(
        (
          await request(
            base,
            route.path,
            {
              host: 'boot-lifemodel.local',
              'content-type': 'application/json',
              origin: 'https://boot-lifemodel.local',
              'x-csrf-token': csrf,
            },
            route.method,
            route.body
          )
        ).status
      ).toBe(401);
      for (const change of [
        { origin: undefined },
        { origin: 'null' },
        { origin: 'https://sibling.local' },
        { 'content-type': 'text/plain' },
        { 'x-csrf-token': undefined },
      ]) {
        const headers: Record<string, string> = { ...good };
        for (const [k, v] of Object.entries(change)) {
          if (v === undefined) delete headers[k];
          else headers[k] = v;
        }
        expect(
          (await request(base, route.path, headers, route.method, route.body)).status
        ).not.toBe(200);
      }
      expect((await request(base, route.path, good, route.method, route.body)).status).toBe(200);
      for (const body of [
        'null',
        '[]',
        '3',
        '"text"',
        '{"kind":3,"baseUrl":"https://models.example","model":"m"}',
      ]) {
        expect((await request(base, route.path, good, route.method, body)).status).toBe(400);
      }
      expect(
        (await request(base, route.path, good, route.method, ' '.repeat(16 * 1024 + 1))).status
      ).toBe(413);
    }
    for (const route of ['/api/model', '/api/model/primary', '/api/model/reserve']) {
      const method = route === '/api/model' ? 'GET' : 'PUT';
      expect(
        (await request(base, route, { host: 'boot-lifemodel.local' }, method, '{}')).status
      ).toBe(route === '/api/model' ? 403 : 401);
    }
    expect((await request(base, '/api/model/other', good, 'PUT', '{}')).status).toBe(404);
    expect((await request(base, '/api/model/primary', good, 'POST', '{}')).status).toBe(405);
    expect((await request(base, '/api/model', good, 'POST')).status).toBe(405);
    expect(
      (
        await request(
          base,
          '/api/model',
          { ...good, origin: 'https://boot-lifemodel.local' },
          'GET'
        )
      ).status
    ).toBe(200);
  });

  it('checks and saves model settings only after an accepted write, and never returns stored keys', async () => {
    const record = await hashPassword('owner password');
    let saved: import('../../loader/src/model.js').ModelSlot | null = null;
    const slots: import('../../loader/src/model.js').ModelSlots = {
      read: async () => (saved === null ? null : structuredClone(saved)),
      write: async (_slot, slot) => {
        saved = structuredClone(slot);
      },
      clearReserve: async () => {
        saved = null;
      },
    };
    const { base, clock, recorded, getOnboardingSaves } = await start(
      record,
      undefined,
      slots,
      async (slot) => {
        if (slot.model === 'bad') throw new ModelCheckError('unreachable');
      }
    );
    const cookie = `__Host-lm_session=${createSession(record, clock.now())}`;
    const csrf = (await request(base, '/api/state', { host: 'boot-lifemodel.local', cookie })).body;
    const csrfToken = JSON.parse(csrf).csrfToken as string;
    const headers = {
      host: 'boot-lifemodel.local',
      cookie,
      origin: 'https://boot-lifemodel.local',
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
    };
    const candidate = {
      kind: 'openai',
      baseUrl: 'https://models.example/v1',
      model: 'good',
      key: 'secret-key',
    };
    const savedResponse = await request(
      base,
      '/api/model/primary',
      headers,
      'PUT',
      JSON.stringify(candidate)
    );
    expect(savedResponse.status).toBe(200);
    expect(savedResponse.body).not.toContain('secret-key');
    const read = await request(base, '/api/model', {
      host: 'boot-lifemodel.local',
      cookie,
      origin: 'https://boot-lifemodel.local',
    });
    expect(read.status).toBe(200);
    expect(read.body).toContain('"keySet":true');
    expect(read.body).not.toContain('secret-key');
    const retained = await request(
      base,
      '/api/model/primary',
      headers,
      'PUT',
      JSON.stringify({ ...candidate, model: 'retained', key: undefined })
    );
    expect(retained.status).toBe(200);
    expect(saved?.key).toBe('secret-key');
    const replaced = await request(
      base,
      '/api/model/primary',
      headers,
      'PUT',
      JSON.stringify({ ...candidate, key: 'new-secret' })
    );
    expect(replaced.status).toBe(200);
    expect(saved?.key).toBe('new-secret');
    const reserveSaved: ModelSlot = {
      kind: 'openai',
      baseUrl: 'https://models.example/v1',
      model: 'reserve',
      key: 'reserve-key',
    };
    saved = reserveSaved;
    const kept = await request(
      base,
      '/api/model/reserve',
      headers,
      'PUT',
      JSON.stringify({ kind: 'openai', baseUrl: 'https://models.example/v1', model: 'kept' })
    );
    expect(kept.status).toBe(200);
    expect(saved?.key).toBe('reserve-key');
    const reserveClear = await request(base, '/api/model/reserve', headers, 'DELETE', '{}');
    expect(reserveClear.status).toBe(200);
    expect(saved).toBeNull();
    saved = {
      kind: 'openai',
      baseUrl: 'https://models.example/v1',
      model: 'good',
      key: 'secret-key',
    };
    const onboardingBeforeFailedCheck = getOnboardingSaves();
    const failed = await request(
      base,
      '/api/model/primary',
      headers,
      'PUT',
      JSON.stringify({ ...candidate, model: 'bad' })
    );
    expect(failed.status).toBe(502);
    expect(saved?.model).toBe('good');
    expect(getOnboardingSaves()).toBe(onboardingBeforeFailedCheck);
    expect(failed.body).not.toContain('secret-key');
    expect(recorded.map((line) => JSON.stringify(line)).join('\n')).not.toContain('secret-key');
    for (const body of ['null', '[]', '3', '"text"', '{\"unexpected\":true}']) {
      const response = await request(base, '/api/model/reserve', headers, 'DELETE', body);
      expect(response.status).toBe(400);
    }
    expect((await request(base, '/api/model/primary', headers, 'POST')).status).toBe(405);
    expect((await request(base, '/api/model/unknown', headers, 'PUT')).status).toBe(404);
    const reserveDelete = await request(base, '/api/model/reserve', headers, 'DELETE', '{}');
    expect(reserveDelete.status).toBe(200);
    for (const invalid of [
      { cookie, origin: 'https://boot-lifemodel.local', 'content-type': 'application/json' },
      { cookie, origin: 'null', 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      {
        cookie,
        origin: 'https://sibling.local',
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      {
        cookie,
        origin: 'https://boot-lifemodel.local',
        'content-type': 'text/plain',
        'x-csrf-token': csrfToken,
      },
    ]) {
      const result = await request(
        base,
        '/api/model/reserve',
        { host: 'boot-lifemodel.local', ...invalid },
        'DELETE',
        '{}'
      );
      expect(result.status).not.toBe(200);
    }
    const acceptedAgain = await request(base, '/api/model/reserve', headers, 'DELETE', '{}');
    expect(acceptedAgain.status).toBe(200);
    for (const invalid of [
      { cookie, 'content-type': 'application/json' },
      { cookie, origin: 'https://boot-lifemodel.local', 'content-type': 'application/json' },
      { cookie, origin: 'null', 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      {
        cookie,
        origin: 'https://sibling.local',
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      {
        cookie,
        origin: 'https://boot-lifemodel.local',
        'content-type': 'text/plain',
        'x-csrf-token': csrfToken,
      },
    ]) {
      expect(
        (
          await request(
            base,
            '/api/model/primary',
            { host: 'boot-lifemodel.local', ...invalid },
            'PUT',
            JSON.stringify(candidate)
          )
        ).status
      ).not.toBe(200);
    }
  });

  it('rejects only the concurrent check for the same slot and advances onboarding only for saved primary', async () => {
    const record = await hashPassword('owner password');
    const saved: Record<string, ModelSlot | null> = { primary: null, reserve: null };
    const slots: ModelSlots = {
      read: async (slot) => saved[slot],
      write: async (slot, value) => {
        saved[slot] = value;
      },
      clearReserve: async () => {
        saved.reserve = null;
      },
    };
    let release!: () => void;
    let checks = 0;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { base, clock, getOnboardingSaves } = await start(
      record,
      undefined,
      slots,
      async (_slot, name) => {
        checks += 1;
        if (name === 'primary' && checks === 1) await held;
      }
    );
    const cookie = `__Host-lm_session=${createSession(record, clock.now())}`;
    const csrf = JSON.parse(
      (await request(base, '/api/state', { host: 'boot-lifemodel.local', cookie })).body
    ).csrfToken as string;
    const headers = {
      host: 'boot-lifemodel.local',
      cookie,
      origin: 'https://boot-lifemodel.local',
      'content-type': 'application/json',
      'x-csrf-token': csrf,
    };
    const candidate = JSON.stringify({
      kind: 'openai',
      baseUrl: 'https://models.example/v1',
      model: 'm',
    });
    const first = request(base, '/api/model/primary', headers, 'PUT', candidate);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await request(base, '/api/model/primary', headers, 'PUT', candidate)).status).toBe(409);
    expect((await request(base, '/api/model/reserve', headers, 'PUT', candidate)).status).toBe(200);
    expect(getOnboardingSaves()).toBe(0);
    release();
    expect((await first).status).toBe(200);
    expect(getOnboardingSaves()).toBe(1);
  });

  it('returns 503 for a Bao write failure without claiming the model was saved', async () => {
    const record = await hashPassword('owner password');
    const slots: ModelSlots = {
      read: async () => null,
      write: async () => {
        throw new Error('sealed/unreachable Bao');
      },
      clearReserve: async () => {},
    };
    const { base, clock, getOnboardingSaves } = await start(
      record,
      undefined,
      slots,
      async () => {}
    );
    const cookie = `__Host-lm_session=${createSession(record, clock.now())}`;
    const csrf = JSON.parse(
      (await request(base, '/api/state', { host: 'boot-lifemodel.local', cookie })).body
    ).csrfToken as string;
    const response = await request(
      base,
      '/api/model/primary',
      {
        host: 'boot-lifemodel.local',
        cookie,
        origin: 'https://boot-lifemodel.local',
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      'PUT',
      JSON.stringify({ kind: 'openai', baseUrl: 'https://models.example/v1', model: 'm' })
    );
    expect(response.status).toBe(503);
    expect(response.body).toBe('{"error":"storage_unavailable"}');
    expect(getOnboardingSaves()).toBe(0);
  });
  it('advances real onboarding through the route only after primary persistence succeeds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loader-model-route-'));
    roots.push(root);
    const config = {
      ...loadConfig({ LIFEMODEL_VOLUME_ROOT: root, LIFEMODEL_NAME: 'lifemodel' }),
      loaderDir: join(root, 'loader'),
    };
    const state = createLoaderState({
      fs: createNodeFileSystem(),
      config,
      logger: createRecordingLogger([]),
    });
    const fs = createNodeFileSystem();
    await state.ensureLayout();
    await fs.writeFileAtomic(
      join(root, 'loader', 'onboarding.json'),
      JSON.stringify({ version: 1, step: 'model', completedAt: null }),
      0o600
    );
    const record = await hashPassword('owner password');
    const slots: ModelSlots = {
      read: async () => null,
      write: async () => {},
      clearReserve: async () => {},
    };
    const routedState: LoaderState = {
      ...state,
      readAuth: async () => record,
      writeAuth: async () => {},
      replaceAuth: async () => {},
    };
    const { base, clock } = await start(record, undefined, slots, async () => {}, routedState);
    const cookie = `__Host-lm_session=${createSession(record, clock.now())}`;
    const csrf = JSON.parse(
      (await request(base, '/api/state', { host: 'boot-lifemodel.local', cookie })).body
    ).csrfToken as string;
    const response = await request(
      base,
      '/api/model/primary',
      {
        host: 'boot-lifemodel.local',
        cookie,
        origin: 'https://boot-lifemodel.local',
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      'PUT',
      JSON.stringify({ kind: 'openai', baseUrl: 'https://models.example/v1', model: 'm' })
    );
    expect(response.status).toBe(200);
    expect((await state.readOnboarding?.())?.step).toBe('device');
  });
});
