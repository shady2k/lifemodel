import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { createLoaderHttp } from '../../loader/src/http.js';
import { createSession, hashPassword } from '../../loader/src/auth.js';
import { createTestClock } from '../../loader/src/clock.js';
import { createRecordingLogger } from '../../loader/src/logger.js';
import type { LoaderState } from '../../loader/src/state.js';

const SERVICE_HOST = 'loader.lifemodel-system.svc.cluster.local';
const servers: Array<ReturnType<typeof createLoaderHttp>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ close }) => close()));
});

async function start(initialAuth: Awaited<ReturnType<typeof hashPassword>> | null) {
  let auth = initialAuth;
  const state: LoaderState = {
    ensureLayout: async () => undefined,
    readAuth: async () => auth,
    writeAuth: async (record) => {
      auth = record;
    },
  };
  const clock = createTestClock();
  const loader = createLoaderHttp({
    state,
    logger: createRecordingLogger([]),
    clock,
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
    expect((await fetch(`${base}/login`, { headers: { host: 'boot.localhost' } })).status).toBe(
      200
    );
    expect(
      (await fetch(`${base}/setup`, { headers: { host: 'boot.localhost' }, redirect: 'manual' }))
        .status
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
      host: 'boot.localhost',
      'x-forwarded-method': 'GET',
      'x-forwarded-host': 'localhost',
      'x-forwarded-uri': '/private',
    });
    expect(browser.status).toBe(303);
    expect(browser.headers.location).toBe(
      'http://boot.localhost/login?next=http%3A%2F%2Flocalhost%2Fprivate'
    );
  });

  it('hands a logged-in session to localhost once, and refuses a replay', async () => {
    const record = await hashPassword('owner password');
    const { base, clock } = await start(record);
    const session = createSession(record, clock.now());
    const ticket = (await import('../../loader/src/auth.js')).createHandoff(record, {
      target: 'localhost',
      session,
      next: '/private?x=1',
      expires: clock.now() + 30_000,
    });
    const path = `/_auth/handoff?ticket=${encodeURIComponent(ticket)}&next=${encodeURIComponent('/private?x=1')}`;
    const first = await request(base, path, { host: 'localhost' });
    expect(first.status).toBe(303);
    expect(first.headers.location).toBe('/private?x=1');
    expect(String(first.headers['set-cookie'])).not.toMatch(/domain=/i);
    const replay = await request(base, path, { host: 'localhost' });
    expect(replay.status).toBe(303);
    expect(replay.headers.location).toBe('http://boot.localhost/login');
    expect(replay.headers['set-cookie']).toBeUndefined();
    const wrongHostTicket = (await import('../../loader/src/auth.js')).createHandoff(record, {
      target: 'localhost',
      session,
      next: '/other',
      expires: clock.now() + 30_000,
    });
    const wrongHostPath = `/_auth/handoff?ticket=${encodeURIComponent(wrongHostTicket)}&next=%2Fother`;
    const wrongHostAccepted = await request(base, wrongHostPath, { host: 'boot.localhost' });
    expect(wrongHostAccepted.headers.location).toBe('http://boot.localhost/login');
    expect(wrongHostAccepted.headers['set-cookie']).toBeUndefined();
  });

  it('rejects expired, tampered, and missing handoff tickets without setting a cookie', async () => {
    const record = await hashPassword('owner password');
    const { base, clock } = await start(record);
    const session = createSession(record, clock.now());
    const { createHandoff } = await import('../../loader/src/auth.js');
    const makeTicket = (expires: number) =>
      createHandoff(record, { target: 'localhost', session, next: '/private', expires });
    const expired = makeTicket(clock.now() + 1);
    clock.advance(2);
    const tampered = `${makeTicket(clock.now() + 30_000)}x`;
    const paths = [
      `/_auth/handoff?ticket=${encodeURIComponent(expired)}&next=%2Fprivate`,
      `/_auth/handoff?ticket=${encodeURIComponent(tampered)}&next=%2Fprivate`,
      '/_auth/handoff?next=%2Fprivate',
    ];
    for (const path of paths) {
      const response = await request(base, path, { host: 'localhost' });
      expect(response.status).toBe(303);
      expect(response.headers.location).toBe('http://boot.localhost/login');
      expect(response.headers['set-cookie']).toBeUndefined();
    }
  });

  it('revokes an app-host session obtained by handoff when logging out', async () => {
    const record = await hashPassword('owner password');
    const { base, clock } = await start(record);
    const session = createSession(record, clock.now());
    const { createHandoff, csrfToken } = await import('../../loader/src/auth.js');
    const ticket = createHandoff(record, {
      target: 'localhost',
      session,
      next: '/',
      expires: clock.now() + 30_000,
    });
    const handoff = await request(
      base,
      `/_auth/handoff?ticket=${encodeURIComponent(ticket)}&next=%2F`,
      { host: 'localhost' }
    );
    const appCookie = String(handoff.headers['set-cookie']).split(';')[0]!;
    expect((await request(base, '/_auth/verify', { cookie: appCookie })).status).toBe(200);
    const csrf = csrfToken(record, session);
    const logout = await request(
      base,
      '/logout',
      {
        host: 'boot.localhost',
        cookie: `lm_session=${session}`,
        origin: 'http://boot.localhost',
        'content-type': 'application/x-www-form-urlencoded',
      },
      'POST',
      `csrf=${encodeURIComponent(csrf)}`
    );
    expect(logout.status).toBe(303);
    expect((await request(base, '/_auth/verify', { cookie: appCookie })).status).toBe(401);
  });

  it('never sets a cookie with a Domain attribute on setup, login, logout, or handoff', async () => {
    const { base, clock, getAuth } = await start(null);
    const formHeaders = {
      host: 'boot.localhost',
      origin: 'http://boot.localhost',
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
    const session = createSession(handoffRecord, clock.now());
    const { createHandoff } = await import('../../loader/src/auth.js');
    const ticket = createHandoff(handoffRecord, {
      target: 'localhost',
      session,
      next: '/',
      expires: clock.now() + 30_000,
    });
    const handoff = await request(
      base,
      `/_auth/handoff?ticket=${encodeURIComponent(ticket)}&next=%2F`,
      { host: 'localhost' }
    );
    expect(String(handoff.headers['set-cookie'])).not.toMatch(/domain=/i);
  });
});
