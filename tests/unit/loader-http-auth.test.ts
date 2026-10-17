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
    readOnboarding: async () => ({ version: 1, step: 'done', completedAt: 'now' }),
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

describe('real boot-host onboarding redirects', () => {
  it.each([
    '/setup?next=https%3A%2F%2Flifemodel.local%2F',
    '/login?next=https%3A%2F%2Flifemodel.local%2F',
  ])('serves the wizard for unfinished authenticated onboarding at %s', async (path) => {
    const record = await hashPassword('owner password');
    let step = 'model';
    const uiRoot = mkdtempSync(join(tmpdir(), 'loader-ui-'));
    roots.push(uiRoot);
    writeFileSync(join(uiRoot, 'index.html'), '<div id="root"></div>');
    const { base } = await start(record, uiRoot, undefined, undefined, {
      ensureLayout: async () => {},
      readAuth: async () => record,
      writeAuth: async () => {},
      replaceAuth: async () => {},
      readOnboarding: async () => ({ version: 1, step, completedAt: null }),
      reconcilePasswordOnboarding: async () => {},
    });
    const response = await request(base, path, {
      host: 'boot-lifemodel.local',
      cookie: `__Host-lm_session=${createSession(record, Date.now())}`,
    });
    expect(response.status).toBe(200);
    expect(response.headers.location).toBeUndefined();
    expect(response.body).toContain('<div id="root">');
    step = 'done';
  });
});

describe('completed onboarding never serves the wizard', () => {
  it.each(['/', '/setup', '/login?next=%2F'])(
    'keeps completed setup out of the wizard at %s',
    async (path) => {
      const record = await hashPassword('owner password');
      const uiRoot = mkdtempSync(join(tmpdir(), 'loader-ui-completed-'));
      roots.push(uiRoot);
      writeFileSync(join(uiRoot, 'index.html'), '<main>settings shell</main>');
      const { base, clock } = await start(record, uiRoot, undefined, undefined, {
        ensureLayout: async () => {},
        readAuth: async () => record,
        writeAuth: async () => {},
        replaceAuth: async () => {},
        readOnboarding: async () => ({ version: 1, step: 'done', completedAt: 'now' }),
        reconcilePasswordOnboarding: async () => {},
      });
      const response = await request(base, path, {
        host: 'boot-lifemodel.local',
        cookie: `__Host-lm_session=${createSession(record, clock.now())}`,
      });
      if (path === '/') {
        expect(response.status).toBe(200);
        expect(response.body).toContain('settings shell');
      } else {
        expect(response.status).toBe(303);
        expect(String(response.headers.location)).not.toContain('/setup');
      }
      expect(response.body).not.toContain('wizard');
    }
  );
});

describe('completed boot-host onboarding redirects', () => {
  it('hands a completed boot session to its vetted app destination', async () => {
    const record = await hashPassword('owner password');
    const uiRoot = mkdtempSync(join(tmpdir(), 'loader-ui-done-'));
    roots.push(uiRoot);
    writeFileSync(join(uiRoot, 'index.html'), '<div id="root"></div>');
    const { base } = await start(record, uiRoot, undefined, undefined, {
      ensureLayout: async () => {},
      readAuth: async () => record,
      writeAuth: async () => {},
      replaceAuth: async () => {},
      readOnboarding: async () => ({ version: 1, step: 'done', completedAt: 'now' }),
      reconcilePasswordOnboarding: async () => {},
    });
    const cookie = `__Host-lm_session=${createSession(record, Date.now())}`;
    const response = await request(base, '/login?next=https%3A%2F%2Flifemodel.local%2Fchat', {
      host: 'boot-lifemodel.local',
      cookie,
    });
    expect(response.status).toBe(303);
    expect(response.headers.location).toMatch(/^https:\/\/lifemodel\.local\/_auth\/handoff\?code=/);
    expect(String(response.headers.location)).toContain('next=%2Fchat');
  });
});

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

  it.each(['/api/setup', '/api/login'] as const)(
    'does not issue a handoff from %s while onboarding is unfinished',
    async (path) => {
      const record = path === '/api/login' ? await hashPassword('owner password') : null;
      const { base } = await start(record, undefined, undefined, undefined, {
        ensureLayout: async () => {},
        readAuth: async () => record,
        writeAuth: async () => {},
        replaceAuth: async () => {},
        savePasswordOnboarding: async () => {},
        readOnboarding: async () => ({ version: 1, step: 'model', completedAt: null }),
      });
      const result = await request(
        base,
        path,
        {
          host: 'boot-lifemodel.local',
          origin: 'https://boot-lifemodel.local',
          'content-type': 'application/json',
        },
        'POST',
        JSON.stringify({
          password: path === '/api/setup' ? 'secure owner password' : 'owner password',
          next: 'https://lifemodel.local/private',
        })
      );
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ ok: true });
      if (path === '/api/login') {
        const token = String(result.headers['set-cookie']).split(';')[0]!;
        expect((await request(base, '/_auth/verify', { cookie: token })).status).toBe(200);
      }
    }
  );

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

  it('does not issue a handoff before onboarding is complete during first-visit setup', async () => {
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
    expect(JSON.parse(String(setup.body))).toEqual({ ok: true });
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

describe('loader password change', () => {
  it('refuses a wrong current password and atomically rotates sessions on success', async () => {
    const record = await hashPassword('owner password');
    const { base, clock, getAuth } = await start(record);
    const oldSession = createSession(record, clock.now());
    const csrf = (await import('../../loader/src/auth.js')).csrfToken(record, oldSession);
    const headers = {
      host: 'boot-lifemodel.local',
      cookie: `__Host-lm_session=${oldSession}`,
      origin: 'https://boot-lifemodel.local',
      'content-type': 'application/json',
      'x-csrf-token': csrf,
    };
    const wrong = await request(
      base,
      '/api/password',
      headers,
      'POST',
      JSON.stringify({
        currentPassword: 'wrong password',
        newPassword: 'a brand new secure password',
      })
    );
    expect(wrong.status).toBe(401);
    expect(getAuth()?.sessionSecret).toBe(record.sessionSecret);
    const changed = await request(
      base,
      '/api/password',
      headers,
      'POST',
      JSON.stringify({
        currentPassword: 'owner password',
        newPassword: 'a brand new secure password',
      })
    );
    expect(changed.status).toBe(200);
    const cookie = String(changed.headers['set-cookie']).split(';')[0]!;
    const freshToken = cookie.slice('__Host-lm_session='.length);
    expect(cookie).toContain('__Host-lm_session=');
    expect(verifySession(freshToken, getAuth()!, clock.now())).toBe(true);
    expect(
      (await request(base, '/_auth/verify', { cookie: `__Host-lm_session=${oldSession}` })).status
    ).toBe(401);
    expect((await request(base, '/_auth/verify', { cookie })).status).toBe(200);
    expect(
      await (
        await import('../../loader/src/auth.js')
      ).verifyPassword('a brand new secure password', getAuth()!)
    ).toBe(true);
  });

  it('persists a password rotation through the real loader file system', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loader-auth-durable-'));
    roots.push(root);
    const config = loadConfig({ LIFEMODEL_NAME: 'lifemodel', LIFEMODEL_VOLUME_ROOT: root });
    const fs = createNodeFileSystem();
    const logger = createRecordingLogger([]);
    const state = createLoaderState({ fs, config, logger });
    await state.ensureLayout();
    const record = await hashPassword('owner password');
    await state.writeAuth(record);
    const clock = createTestClock();
    const loader = createLoaderHttp({
      state,
      logger,
      clock,
      config,
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
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${address.port}`;
    const oldToken = createSession(record, clock.now());
    const csrf = (await import('../../loader/src/auth.js')).csrfToken(record, oldToken);
    const response = await request(
      base,
      '/api/password',
      {
        host: 'boot-lifemodel.local',
        cookie: `__Host-lm_session=${oldToken}`,
        origin: 'https://boot-lifemodel.local',
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      'POST',
      JSON.stringify({ currentPassword: 'owner password', newPassword: 'durable new password' })
    );
    expect(response.status).toBe(200);
    const persisted = await state.readAuth();
    expect(persisted).not.toBeNull();
    expect(persisted?.sessionSecret).not.toBe(record.sessionSecret);
    expect(
      await (
        await import('../../loader/src/auth.js')
      ).verifyPassword('durable new password', persisted!)
    ).toBe(true);
    expect(verifySession(oldToken, persisted!, clock.now())).toBe(false);
    const reloaded = await createLoaderState({
      fs: createNodeFileSystem(),
      config,
      logger,
    }).readAuth();
    expect(reloaded?.sessionSecret).toBe(persisted?.sessionSecret);
    expect(
      verifySession(
        String(response.headers['set-cookie']).split(';')[0]!.split('=')[1]!,
        reloaded!,
        clock.now()
      )
    ).toBe(true);
  });

  it('applies the write admission rules and validates exact password JSON shape', async () => {
    const record = await hashPassword('owner password');
    const { base, clock } = await start(record);
    const token = createSession(record, clock.now());
    const csrf = (await import('../../loader/src/auth.js')).csrfToken(record, token);
    const valid = { currentPassword: 'owner password', newPassword: 'a brand new secure password' };
    const baseHeaders = {
      host: 'boot-lifemodel.local',
      cookie: `__Host-lm_session=${token}`,
      'x-csrf-token': csrf,
    };
    for (const origin of [undefined, 'null', 'https://boot-other.local']) {
      const result = await request(
        base,
        '/api/password',
        {
          ...baseHeaders,
          'content-type': 'application/json',
          ...(origin === undefined ? {} : { origin }),
        },
        'POST',
        JSON.stringify(valid)
      );
      expect(result.status).toBe(403);
    }
    expect(
      (
        await request(
          base,
          '/api/password',
          { ...baseHeaders, origin: 'https://boot-lifemodel.local', 'content-type': 'text/plain' },
          'POST',
          JSON.stringify(valid)
        )
      ).status
    ).toBe(415);
    expect(
      (
        await request(
          base,
          '/api/password',
          {
            host: baseHeaders.host,
            cookie: baseHeaders.cookie,
            origin: 'https://boot-lifemodel.local',
            'content-type': 'application/json',
          },
          'POST',
          JSON.stringify(valid)
        )
      ).status
    ).toBe(403);
    for (const body of [
      'null',
      '[]',
      '"x"',
      '{}',
      JSON.stringify({ ...valid, extra: true }),
      JSON.stringify({ currentPassword: 'owner password', newPassword: 'short' }),
    ]) {
      const result = await request(
        base,
        '/api/password',
        {
          ...baseHeaders,
          origin: 'https://boot-lifemodel.local',
          'content-type': 'application/json',
          'x-csrf-token': csrf,
        },
        'POST',
        body
      );
      expect(result.status).toBe(400);
    }
    expect(
      (
        await request(
          base,
          '/api/password',
          {
            ...baseHeaders,
            origin: 'https://boot-lifemodel.local',
            'content-type': 'application/json',
            'x-csrf-token': csrf,
          },
          'POST',
          ' '.repeat(8193)
        )
      ).status
    ).toBe(413);
    expect(
      (await request(base, '/api/password', { host: 'boot-lifemodel.local' }, 'GET')).status
    ).toBe(405);
    expect((await request(base, '/api/not-real', { host: 'boot-lifemodel.local' })).status).toBe(
      404
    );
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
    const onboardingBeforeReserve = getOnboardingSaves();
    expect(kept.status).toBe(200);
    expect(saved?.key).toBe('reserve-key');
    expect(getOnboardingSaves()).toBe(onboardingBeforeReserve);
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
  it('maps Bao failures behind model GET, PUT, and DELETE to safe 503 responses', async () => {
    const record = await hashPassword('owner password');
    const slots: ModelSlots = {
      read: async () => {
        throw new Error('sealed/unreachable Bao');
      },
      write: async () => {
        throw new Error('sealed/unreachable Bao');
      },
      clearReserve: async () => {
        throw new Error('sealed/unreachable Bao');
      },
    };
    const { base, clock } = await start(record, undefined, slots, async () => {});
    const cookie = `__Host-lm_session=${createSession(record, clock.now())}`;
    const csrf = JSON.parse(
      (await request(base, '/api/state', { host: 'boot-lifemodel.local', cookie })).body
    ).csrfToken as string;
    const read = await request(base, '/api/model', {
      host: 'boot-lifemodel.local',
      cookie,
      origin: 'https://boot-lifemodel.local',
    });
    expect(read.status).toBe(503);
    expect(read.body).toBe('{"error":"storage_unavailable"}');
    const headers = {
      host: 'boot-lifemodel.local',
      cookie,
      origin: 'https://boot-lifemodel.local',
      'content-type': 'application/json',
      'x-csrf-token': csrf,
    };
    const put = await request(
      base,
      '/api/model/primary',
      headers,
      'PUT',
      JSON.stringify({ kind: 'openai', baseUrl: 'https://models.example/v1', model: 'm' })
    );
    expect(put.status).toBe(503);
    expect(put.body).toBe('{"error":"storage_unavailable"}');
    const del = await request(base, '/api/model/reserve', headers, 'DELETE', '{}');
    expect(del.status).toBe(503);
    expect(del.body).toBe('{"error":"storage_unavailable"}');
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
  it('acknowledges the device only from the device step and records completion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loader-device-'));
    roots.push(root);
    const config = loadConfig({ LIFEMODEL_NAME: 'lifemodel', LIFEMODEL_VOLUME: root });
    const realState = createLoaderState({
      fs: createNodeFileSystem(),
      config: { ...config, volumeRoot: root, loaderDir: join(root, 'loader') },
      logger: createRecordingLogger([]),
    });
    await realState.ensureLayout();
    const record = await hashPassword('owner password');
    await realState.writeAuth(record);
    const { base, clock } = await start(record, undefined, undefined, undefined, realState);
    const cookie = `__Host-lm_session=${createSession(record, clock.now())}`;
    const anonymousState = await request(base, '/api/state', { host: 'boot-lifemodel.local' });
    expect(JSON.parse(anonymousState.body)).toEqual({ setupNeeded: false, loggedIn: false });
    const headers = {
      host: 'boot-lifemodel.local',
      cookie,
      origin: 'https://boot-lifemodel.local',
      'content-type': 'application/json',
    };
    const csrf = JSON.parse(
      (await request(base, '/api/state', { host: headers.host, cookie })).body
    ).csrfToken as string;
    const route = '/api/onboarding/device';
    const csrfHeaders = { ...headers, 'x-csrf-token': csrf };
    expect(
      (
        await request(
          base,
          route,
          { host: headers.host, origin: headers.origin, 'content-type': 'application/json' },
          'POST',
          '{}'
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
      const badHeaders: Record<string, string> = { ...csrfHeaders };
      for (const [key, value] of Object.entries(change)) {
        if (value === undefined) delete badHeaders[key];
        else badHeaders[key] = value;
      }
      const rejected = await request(base, route, badHeaders, 'POST', '{}');
      const expected =
        ('origin' in change && change.origin === undefined) ||
        change.origin === 'null' ||
        change.origin === 'https://sibling.local' ||
        'x-csrf-token' in change
          ? 403
          : 415;
      expect(rejected.status).toBe(expected);
    }
    expect((await request(base, route, csrfHeaders, 'PUT', '{}')).status).toBe(405);
    expect((await request(base, route, csrfHeaders, 'POST', '{}')).status).toBe(409);
    expect((await realState.readOnboarding?.())?.step).toBe('model');
    expect((await request(base, route, csrfHeaders, 'POST', 'null')).status).toBe(400);
    await realState.savePasswordOnboarding?.();
    for (const step of ['password', 'model'] as const) {
      writeFileSync(
        join(root, 'loader', 'onboarding.json'),
        JSON.stringify({ version: 1, step, completedAt: null })
      );
      expect((await request(base, route, csrfHeaders, 'POST', '{}')).status).toBe(409);
    }
    await realState.saveModelOnboarding?.();
    expect((await realState.readOnboarding?.())?.step).toBe('device');
    for (const body of ['null', '[]', '1', '"text"', '{"unexpected":true}']) {
      expect((await request(base, route, csrfHeaders, 'POST', body)).status).toBe(400);
    }
    expect((await request(base, route, csrfHeaders, 'POST', ' '.repeat(8193))).status).toBe(413);
    const accepted = await request(base, route, csrfHeaders, 'POST', '{}');
    expect(accepted.status).toBe(200);
    expect((await realState.readOnboarding?.())?.step).toBe('done');
    expect((await realState.readOnboarding?.())?.completedAt).toBeTruthy();
    expect((await request(base, route, csrfHeaders, 'POST', '{}')).status).toBe(409);
    writeFileSync(
      join(root, 'loader', 'onboarding.json'),
      JSON.stringify({ version: 1, step: 'done', completedAt: 'earlier' })
    );
    expect((await request(base, route, csrfHeaders, 'POST', '{}')).status).toBe(409);
  });
});
