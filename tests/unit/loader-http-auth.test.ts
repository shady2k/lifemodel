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

async function start(auth: Awaited<ReturnType<typeof hashPassword>> | null) {
  const state: LoaderState = {
    ensureLayout: async () => undefined,
    readAuth: async () => auth,
    writeAuth: async () => undefined,
  };
  const loader = createLoaderHttp({
    state,
    logger: createRecordingLogger([]),
    clock: createTestClock(),
  });
  servers.push(loader);
  await new Promise<void>((resolve) => loader.server.listen(0, '127.0.0.1', resolve));
  const address = loader.server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

async function request(base: string, path: string, headers: Record<string, string> = {}) {
  const url = new URL(path, base);
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>(
    (resolve, reject) => {
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          headers: { host: SERVICE_HOST, ...headers },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
        }
      );
      req.on('error', reject);
      req.end();
    }
  );
}

describe('loader ForwardAuth verification host', () => {
  it('accepts a valid session only on the exact verification route at its Service host', async () => {
    const record = await hashPassword('owner password');
    const base = await start(record);
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
    const base = await start(record);

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
});
