/**
 * The loader's route matrix (ADR-016 §4, L11): every method and path pair the
 * loader answers, with the host, the authentication state it allows and whether
 * a write also needs the CSRF header and the exact Origin.
 *
 * It lives beside the fixture store rather than in the test so a new route
 * extends a data file the ratchet counts, not the test that walks it.
 */

const LOGS_FROM = Date.parse('2026-11-07T10:00:00.000Z');
const LOGS_TO = Date.parse('2026-11-07T11:00:00.000Z');

export type RouteHost = 'boot' | 'app' | 'loopback' | 'service';
export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'ANY';

export interface ExpectedRoute {
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

export const MATRIX: readonly ExpectedRoute[] = [
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
  logsRoute('/api/logs/settings', '/api/logs/settings', [403]),
  {
    host: 'boot',
    method: 'PUT',
    path: '/api/logs/settings',
    requestPath: '/api/logs/settings',
    auth: 'session',
    csrf: true,
    wrongMethod: 405,
    anonymous: [401],
    authenticated: [200],
    body: { days: 7, maxBytes: 1_073_741_824 },
  },
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

