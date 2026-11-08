/**
 * The loader's route matrix (ADR-016 §4, L11).
 *
 * Every method and path pair the loader answers is named here with the host it
 * answers on and the authentication state it allows. The behaviour tests drive
 * each pair through the real server; one test asserts that the extracted route
 * table declares exactly this matrix.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createLoaderHttp, type LoaderHttp } from '../../loader/src/http.js';
import {
  createSession,
  csrfToken,
  hashPassword,
  type PasswordRecord,
} from '../../loader/src/auth.js';
import { loadConfig } from '../../loader/src/config.js';
import { createTestClock } from '../../loader/src/clock.js';
import { createRecordingLogger } from '../../loader/src/logger.js';
import type { LoaderState } from '../../loader/src/state.js';
import type { ModelSlot, ModelSlots } from '../../loader/src/model.js';
import type { SettingsSectionSnapshot } from '../../loader/src/settings/store.js';
import { ROUTES } from '../../loader/src/route-table.js';
import {
  startLogsStoreFixture,
  type LogsStoreFixture,
} from '../helpers/logs-store-fixture.js';

const BOOT = 'boot-lifemodel.local';
const APP = 'lifemodel.local';
const UNKNOWN = 'unknown.local';
const LOOPBACK = '127.0.0.1';
const SERVICE = 'loader.lifemodel-system.svc.cluster.local';
const LOGS_FROM = Date.parse('2026-11-07T10:00:00.000Z');
const LOGS_TO = Date.parse('2026-11-07T11:00:00.000Z');

type RouteHost = 'boot' | 'app' | 'loopback' | 'service';
type RouteMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'ANY';

interface ExpectedRoute {
  host: RouteHost;
  method: RouteMethod;
  /** The path the route table declares: a literal, `:key` or `*`. */
  path: string;
  /** The path a behaviour probe requests. */
  requestPath: string;
  /** `none`: the route does not require a session. `session`: it does. */
  auth: 'none' | 'session';
  /** A write that needs the CSRF header and the exact Origin. */
  csrf: boolean;
  /** The answer to a method this path does not serve (405 known, 404 unknown). */
  wrongMethod: 404 | 405;
  /** The answer with no session at all. */
  anonymous: readonly number[];
  /** The answer with a session, a valid Origin and (for a write) a CSRF token. */
  authenticated?: readonly number[];
  /** The body the authenticated probe sends. */
  body?: unknown;
  /** The authenticated probe's content type (JSON unless stated). */
  contentType?: string;
}

/** The logs routes require a session on every method, GET included (L11). */
function logsRoute(path: string, requestPath: string, anonymous: number[]): ExpectedRoute {
  return {
    host: 'boot',
    method: 'GET',
    path,
    requestPath,
    auth: 'session',
    csrf: false,
    wrongMethod: 405,
    anonymous,
    authenticated: [200],
  };
}

const MATRIX: readonly ExpectedRoute[] = [
  // First start: these three answer without a session on the boot host.
  {
    host: 'boot',
    method: 'GET',
    path: '/api/state',
    requestPath: '/api/state',
    auth: 'none',
    csrf: false,
    wrongMethod: 405,
    anonymous: [200],
    authenticated: [200],
  },
  {
    host: 'boot',
    method: 'POST',
    path: '/api/setup',
    requestPath: '/api/setup',
    auth: 'none',
    csrf: false,
    wrongMethod: 405,
    anonymous: [409],
    authenticated: [409],
    body: { password: 'secure owner password' },
  },
  {
    host: 'boot',
    method: 'POST',
    path: '/api/login',
    requestPath: '/api/login',
    auth: 'none',
    csrf: false,
    wrongMethod: 405,
    anonymous: [200],
    authenticated: [200],
    body: { password: 'owner password' },
  },
  // Everything else under /api/ requires a session; a write also needs CSRF.
  {
    host: 'boot',
    method: 'POST',
    path: '/api/password',
    requestPath: '/api/password',
    auth: 'session',
    csrf: true,
    wrongMethod: 405,
    anonymous: [401],
    // A refused content type: the rotation itself is covered by its own test.
    authenticated: [415],
    contentType: 'text/plain',
    body: { currentPassword: 'owner password', newPassword: 'a brand new secure password' },
  },
  {
    host: 'boot',
    method: 'POST',
    path: '/api/logout',
    requestPath: '/api/logout',
    auth: 'session',
    csrf: true,
    wrongMethod: 405,
    anonymous: [401],
  },
  {
    host: 'boot',
    method: 'POST',
    path: '/api/onboarding/device',
    requestPath: '/api/onboarding/device',
    auth: 'session',
    csrf: true,
    wrongMethod: 405,
    anonymous: [401],
    authenticated: [409],
    body: {},
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/api/model',
    requestPath: '/api/model',
    auth: 'session',
    csrf: false,
    wrongMethod: 405,
    anonymous: [403],
    authenticated: [200],
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/api/model-capture',
    requestPath: '/api/model-capture',
    auth: 'session',
    csrf: false,
    wrongMethod: 405,
    anonymous: [403],
    authenticated: [200],
  },
  {
    host: 'boot',
    method: 'PUT',
    path: '/api/model-capture',
    requestPath: '/api/model-capture',
    auth: 'session',
    csrf: true,
    wrongMethod: 405,
    anonymous: [401],
    authenticated: [200],
    body: { durationMs: null },
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/api/model-status',
    requestPath: '/api/model-status',
    auth: 'session',
    csrf: false,
    wrongMethod: 405,
    anonymous: [403],
    authenticated: [200],
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/api/workbench-source',
    requestPath: '/api/workbench-source',
    auth: 'session',
    csrf: false,
    wrongMethod: 405,
    anonymous: [403],
    authenticated: [200],
  },
  {
    host: 'boot',
    method: 'PUT',
    path: '/api/workbench-source',
    requestPath: '/api/workbench-source',
    auth: 'session',
    csrf: true,
    wrongMethod: 405,
    anonymous: [401],
    authenticated: [200],
    body: { registry: 'https://ghcr.io', repository: 'owner/repo' },
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/api/workbench-status',
    requestPath: '/api/workbench-status',
    auth: 'session',
    csrf: false,
    wrongMethod: 405,
    anonymous: [403],
    authenticated: [200],
  },
  {
    host: 'boot',
    method: 'PUT',
    path: '/api/model/primary',
    requestPath: '/api/model/primary',
    auth: 'session',
    csrf: true,
    wrongMethod: 405,
    anonymous: [401],
    authenticated: [200],
    body: { kind: 'openai', baseUrl: 'https://models.example/v1', model: 'm' },
  },
  {
    host: 'boot',
    method: 'PUT',
    path: '/api/model/reserve',
    requestPath: '/api/model/reserve',
    auth: 'session',
    csrf: true,
    wrongMethod: 405,
    anonymous: [401],
    authenticated: [200],
    body: { kind: 'openai', baseUrl: 'https://models.example/v1', model: 'm' },
  },
  {
    host: 'boot',
    method: 'DELETE',
    path: '/api/model/reserve',
    requestPath: '/api/model/reserve',
    auth: 'session',
    csrf: true,
    wrongMethod: 405,
    anonymous: [401],
    authenticated: [200],
    body: {},
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/api/settings',
    requestPath: '/api/settings',
    auth: 'session',
    csrf: false,
    wrongMethod: 405,
    anonymous: [403],
    authenticated: [200],
  },
  {
    host: 'boot',
    method: 'PUT',
    path: '/api/settings/:key',
    requestPath: '/api/settings/tasks.concurrency',
    auth: 'session',
    csrf: true,
    wrongMethod: 405,
    anonymous: [401],
    authenticated: [200],
    body: { value: 4 },
  },
  // The logs page and its API: a session on every method, GET included.
  logsRoute('/logs', '/logs', [303]),
  logsRoute(
    '/api/logs',
    `/api/logs?from=${String(LOGS_FROM)}&to=${String(LOGS_TO)}&module=core`,
    [403]
  ),
  logsRoute('/api/logs/modules', '/api/logs/modules', [403]),
  // The boot host's pages and files. Only GET is served; /logout is a known
  // path with no page here, so its GET answer is the plain 404.
  {
    host: 'boot',
    method: 'GET',
    path: '/',
    requestPath: '/',
    auth: 'none',
    csrf: false,
    wrongMethod: 405,
    anonymous: [200],
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/login',
    requestPath: '/login',
    auth: 'none',
    csrf: false,
    wrongMethod: 405,
    anonymous: [200],
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/setup',
    requestPath: '/setup',
    auth: 'none',
    csrf: false,
    wrongMethod: 405,
    anonymous: [303],
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/logout',
    requestPath: '/logout',
    auth: 'none',
    csrf: false,
    wrongMethod: 405,
    anonymous: [404],
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/favicon.svg',
    requestPath: '/favicon.svg',
    auth: 'none',
    csrf: false,
    wrongMethod: 404,
    anonymous: [200],
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/assets/*',
    requestPath: '/assets/app.js',
    auth: 'none',
    csrf: false,
    wrongMethod: 404,
    anonymous: [200],
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/ca.crt',
    requestPath: '/ca.crt',
    auth: 'none',
    csrf: false,
    wrongMethod: 404,
    anonymous: [200],
  },
  // The two authentication seams answer every method; they read only headers.
  {
    host: 'app',
    method: 'GET',
    path: '/_auth/handoff',
    requestPath: '/_auth/handoff',
    auth: 'none',
    csrf: false,
    wrongMethod: 404,
    anonymous: [303],
  },
  {
    host: 'loopback',
    method: 'ANY',
    path: '/_auth/handoff',
    requestPath: '/_auth/handoff',
    auth: 'none',
    csrf: false,
    wrongMethod: 404,
    anonymous: [303],
  },
  {
    host: 'loopback',
    method: 'ANY',
    path: '/_auth/verify',
    requestPath: '/_auth/verify',
    auth: 'none',
    csrf: false,
    wrongMethod: 404,
    anonymous: [401],
  },
  {
    host: 'service',
    method: 'ANY',
    path: '/_auth/verify',
    requestPath: '/_auth/verify',
    auth: 'none',
    csrf: false,
    wrongMethod: 404,
    anonymous: [401],
  },
];

const HOSTS: Record<RouteHost, string> = {
  boot: BOOT,
  app: APP,
  loopback: LOOPBACK,
  service: SERVICE,
};

const servers: LoaderHttp[] = [];
const roots: string[] = [];
let logsStore: LogsStoreFixture;

beforeAll(async () => {
  logsStore = await startLogsStoreFixture();
});

interface Fixture {
  base: string;
  record: PasswordRecord;
  token: string;
  csrf: string;
  request(
    route: ExpectedRoute,
    options?: {
      host?: string;
      method?: string;
      body?: string;
      headers?: Record<string, string>;
    }
  ): Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>;
}

function uiRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'loader-routes-'));
  roots.push(root);
  writeFileSync(join(root, 'index.html'), '<main>loader</main>');
  writeFileSync(join(root, 'logs.html'), '<main>logs</main>');
  writeFileSync(join(root, 'favicon.svg'), '<svg/>');
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1);');
  return root;
}

async function start(): Promise<Fixture> {
  const record = await hashPassword('owner password');
  const clock = createTestClock();
  const token = createSession(record, clock.now());
  const state: LoaderState = {
    ensureLayout: async () => {},
    readAuth: async () => record,
    writeAuth: async () => {},
    replaceAuth: async () => {},
    readOnboarding: async () => ({ version: 1, step: 'done', completedAt: 'now' }),
    reconcilePasswordOnboarding: async () => {},
    savePasswordOnboarding: async () => {},
    saveModelOnboarding: async () => {},
  };
  const slots: ModelSlots = {
    read: async () => null,
    write: async (_slot: 'primary' | 'reserve', _value: ModelSlot) => {},
    clearReserve: async () => {},
  };
  const section: SettingsSectionSnapshot = {
    declarations: [],
    values: {},
    revision: 1,
    problems: [],
    projection: { state: 'unattempted' },
  };
  const loader = createLoaderHttp({
    state,
    logger: createRecordingLogger([]),
    clock,
    config: loadConfig({
      LIFEMODEL_NAME: 'lifemodel',
      LIFEMODEL_LOGS_STORE_URL: logsStore.url,
    }),
    uiRoot: uiRoot(),
    modelSlots: slots,
    modelChecker: async () => {},
    modelStatus: { read: async () => ({ state: 'ok', outageSince: null, lastErrorCode: null }) },
    modelCapture: { read: async () => ({ until: null }), write: async () => {} },
    settings: {
      section: () => section,
      set: async () => ({ value: 4, revision: 2 }),
    },
    workbench: {
      read: async () => ({ registry: 'https://ghcr.io', repository: 'owner/repo' }),
      write: async () => {},
      status: async () => ({
        state: 'ready',
        lastAttemptAt: 1,
        pinnedDigest: `sha256:${'a'.repeat(64)}`,
      }),
      retrigger: async () => {},
    },
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
  const base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    record,
    token,
    csrf: csrfToken(record, token),
    request: (route, options = {}) => {
      const method = options.method ?? (route.method === 'ANY' ? 'GET' : route.method);
      const headers: Record<string, string> = {
        host: options.host ?? HOSTS[route.host],
        ...(options.headers ?? {}),
      };
      const body = options.body;
      const url = new URL(route.requestPath, base);
      return new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method,
            headers: {
              ...headers,
              ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }),
            },
          },
          (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
              text += chunk;
            });
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text })
            );
          }
        );
        req.on('error', reject);
        req.end(body);
      });
    },
  };
}

function anonymousHeaders(route: ExpectedRoute): Record<string, string> {
  return {
    origin: `https://${BOOT}`,
    'content-type': route.contentType ?? 'application/json',
  };
}

function sessionHeaders(fixture: Fixture, route: ExpectedRoute): Record<string, string> {
  return {
    cookie: `__Host-lm_session=${fixture.token}`,
    origin: `https://${BOOT}`,
    'x-csrf-token': fixture.csrf,
    'content-type': route.contentType ?? 'application/json',
  };
}

function bodyOf(route: ExpectedRoute): string | undefined {
  return route.body === undefined ? undefined : JSON.stringify(route.body);
}

afterAll(async () => {
  await Promise.all(servers.splice(0).map(({ close }) => close()));
  await logsStore.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function routeKey(route: { host: string; method: string; path: string }): string {
  return `${route.host} ${route.path} ${route.method}`;
}

describe('loader route matrix', () => {
  it('declares every method and path pair in the route table', () => {
    const declared = ROUTES.map(({ host, method, path, auth, csrf, wrongMethod }) => ({
      host,
      method,
      path,
      auth,
      csrf,
      wrongMethod,
    })).sort((a, b) => routeKey(a).localeCompare(routeKey(b)));
    const expected = MATRIX.map(({ host, method, path, auth, csrf, wrongMethod }) => ({
      host,
      method,
      path,
      auth,
      csrf,
      wrongMethod,
    })).sort((a, b) => routeKey(a).localeCompare(routeKey(b)));
    expect(declared).toEqual(expected);
  });

  it('answers another host with 404 on every pair', async () => {
    const fixture = await start();
    for (const route of MATRIX) {
      const otherHost = route.host === 'boot' ? APP : BOOT;
      const response = await fixture.request(route, { host: otherHost, body: bodyOf(route) });
      expect(
        response.status,
        `${route.host} ${route.method} ${route.requestPath} on ${otherHost}`
      ).toBe(404);
      const unknown = await fixture.request(route, { host: UNKNOWN, body: bodyOf(route) });
      expect(unknown.status, `${route.requestPath} on ${UNKNOWN}`).toBe(404);
    }
  });

  it('answers a wrong method with 405 on a known path and 404 on an unknown one', async () => {
    const fixture = await start();
    for (const route of MATRIX) {
      if (route.method === 'ANY') continue;
      const response = await fixture.request(route, {
        method: 'PATCH',
        headers: sessionHeaders(fixture, route),
        body: bodyOf(route),
      });
      expect(response.status, `${route.method} ${route.requestPath} as PATCH`).toBe(
        route.wrongMethod
      );
    }
  });

  it('answers each pair with the authentication state it allows', async () => {
    const fixture = await start();
    for (const route of MATRIX) {
      const anonymous = await fixture.request(route, {
        headers: anonymousHeaders(route),
        body: bodyOf(route),
      });
      expect(
        route.anonymous,
        `${route.host} ${route.method} ${route.requestPath} without a session answered ${String(anonymous.status)}`
      ).toContain(anonymous.status);
      if (route.authenticated === undefined) continue;
      const authenticated = await fixture.request(route, {
        headers: sessionHeaders(fixture, route),
        body: bodyOf(route),
      });
      expect(
        route.authenticated,
        `${route.host} ${route.method} ${route.requestPath} with a session answered ${String(authenticated.status)}`
      ).toContain(authenticated.status);
    }
  });

  it('answers without a session only on GET /api/state, POST /api/setup and POST /api/login', async () => {
    const fixture = await start();
    for (const route of MATRIX.filter((entry) => entry.path.startsWith('/api/'))) {
      const response = await fixture.request(route, {
        headers: anonymousHeaders(route),
        body: bodyOf(route),
      });
      const publicRoute =
        route.requestPath === '/api/state' ||
        route.requestPath === '/api/setup' ||
        route.requestPath === '/api/login';
      if (publicRoute) expect(route.anonymous).toContain(response.status);
      else expect([401, 403]).toContain(response.status);
    }
  });

  it('refuses every CSRF write without its token or with a foreign Origin', async () => {
    const fixture = await start();
    for (const route of MATRIX.filter((entry) => entry.csrf)) {
      const missingToken = await fixture.request(route, {
        headers: {
          cookie: `__Host-lm_session=${fixture.token}`,
          origin: `https://${BOOT}`,
          'content-type': route.contentType ?? 'application/json',
        },
        body: bodyOf(route),
      });
      expect(missingToken.status, `${route.method} ${route.requestPath} without CSRF`).toBe(403);
      const foreignOrigin = await fixture.request(route, {
        headers: {
          cookie: `__Host-lm_session=${fixture.token}`,
          origin: 'https://evil.example',
          'x-csrf-token': fixture.csrf,
          'content-type': route.contentType ?? 'application/json',
        },
        body: bodyOf(route),
      });
      expect(foreignOrigin.status, `${route.method} ${route.requestPath} from evil.example`).toBe(
        403
      );
    }
  });

  it('carries no-store, CSP and nosniff on every /api/ answer', async () => {
    const fixture = await start();
    for (const route of MATRIX.filter((entry) => entry.path.startsWith('/api/'))) {
      const responses = [await fixture.request(route, { body: bodyOf(route) })];
      if (route.authenticated !== undefined)
        responses.push(
          await fixture.request(route, {
            headers: sessionHeaders(fixture, route),
            body: bodyOf(route),
          })
        );
      for (const response of responses) {
        expect(response.headers['cache-control'], route.requestPath).toBe('no-store');
        expect(String(response.headers['content-security-policy']), route.requestPath).toContain(
          "default-src 'self'"
        );
        expect(String(response.headers['content-security-policy']), route.requestPath).toContain(
          "frame-ancestors 'none'"
        );
        expect(response.headers['x-content-type-options'], route.requestPath).toBe('nosniff');
      }
    }
  });

  it('rotates the password with a session and its CSRF token', async () => {
    const fixture = await start();
    const password = MATRIX.find((route) => route.requestPath === '/api/password');
    if (password === undefined) throw new Error('matrix is incomplete');
    const rotated = await fixture.request(password, {
      headers: {
        cookie: `__Host-lm_session=${fixture.token}`,
        origin: `https://${BOOT}`,
        'x-csrf-token': fixture.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        currentPassword: 'owner password',
        newPassword: 'a brand new secure password',
      }),
    });
    expect(rotated.status).toBe(200);
    expect(String(rotated.headers['set-cookie'])).toContain('__Host-lm_session=');
  });

  it('logs out with a session and its CSRF token', async () => {
    const fixture = await start();
    const logout = MATRIX.find((route) => route.requestPath === '/api/logout');
    if (logout === undefined) throw new Error('matrix is incomplete');
    const loggedOut = await fixture.request(logout, {
      headers: {
        cookie: `__Host-lm_session=${fixture.token}`,
        origin: `https://${BOOT}`,
        'x-csrf-token': fixture.csrf,
      },
    });
    expect(loggedOut.status).toBe(200);
    expect(String(loggedOut.headers['set-cookie'])).toContain('__Host-lm_session=;');
  });
});
