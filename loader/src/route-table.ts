/**
 * The loader's one route table (ADR-016 §4, L11).
 *
 * Every method and path the loader answers is declared here with the host it
 * answers on, the authentication state it allows (`none`: it does not require a
 * session; `session`: it does) and whether a write also needs the CSRF header
 * and the exact Origin. `http.ts` dispatches through this table; each route's
 * handler keeps its own refusal body (401 or 403, with or without JSON), so the
 * table states the matrix and the handlers answer it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostName } from './auth.js';
import { SETTING_KEY_PATTERN } from './settings/registry.js';

export type RouteHost = 'boot' | 'app' | 'loopback' | 'service';
export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
export type RouteAuth = 'none' | 'session';

/** The handler that answers a route; `http.ts` owns the map of these. */
export type RouteHandlerName =
  | 'apiState'
  | 'setupOrLogin'
  | 'password'
  | 'logout'
  | 'onboardingDevice'
  | 'model'
  | 'modelCapture'
  | 'modelStatusRead'
  | 'workbench'
  | 'settingsRead'
  | 'settingWrite'
  | 'modelSlotWrite'
  | 'modelReserveDelete'
  | 'logsPage'
  | 'logsQuery'
  | 'logsModules'
  | 'logsSettingsRead'
  | 'logsSettingsWrite'
  | 'bootPage'
  | 'notFound'
  | 'favicon'
  | 'assets'
  | 'caCertificate'
  | 'handoff'
  | 'verify';

export interface RouteEntry {
  readonly host: RouteHost;
  /** `ANY` for the two `_auth` seams, which answer every method. */
  readonly method: RouteMethod | 'ANY';
  /** A literal path, the settings-key pattern, or the asset prefix. */
  readonly path: string;
  readonly auth: RouteAuth;
  readonly csrf: boolean;
  /** What a method this path does not serve answers: 405 for a known path, 404 otherwise. */
  readonly wrongMethod: 404 | 405;
  readonly handler: RouteHandlerName;
}

/** The service account's ForwardAuth host: the only host with no browser route. */
export const SERVICE_VERIFY_HOST = 'loader.lifemodel-system.svc.cluster.local';

const SETTINGS_PREFIX = '/api/settings/';
const SETTINGS_KEY_ROUTE = '/api/settings/:key';
const ASSET_PREFIX = '/assets/';
const ASSET_ROUTE = `${ASSET_PREFIX}*`;

/** The setting key a write path names, or null when the path names none. */
export function settingsKeyOf(path: string): string | null {
  if (!path.startsWith(SETTINGS_PREFIX)) return null;
  const key = path.slice(SETTINGS_PREFIX.length);
  return SETTING_KEY_PATTERN.test(key) ? key : null;
}

/**
 * Every route, in the order the matrix test names them. `GET /logout` is a
 * known path with no page on the boot host: the app host owns logout, and the
 * boot host answers 404 to the page while refusing other methods with 405.
 */
export const ROUTES: readonly RouteEntry[] = [
  {
    host: 'boot',
    method: 'GET',
    path: '/api/state',
    auth: 'none',
    csrf: false,
    wrongMethod: 405,
    handler: 'apiState',
  },
  {
    host: 'boot',
    method: 'POST',
    path: '/api/setup',
    auth: 'none',
    csrf: false,
    wrongMethod: 405,
    handler: 'setupOrLogin',
  },
  {
    host: 'boot',
    method: 'POST',
    path: '/api/login',
    auth: 'none',
    csrf: false,
    wrongMethod: 405,
    handler: 'setupOrLogin',
  },
  {
    host: 'boot',
    method: 'POST',
    path: '/api/password',
    auth: 'session',
    csrf: true,
    wrongMethod: 405,
    handler: 'password',
  },
  {
    host: 'boot',
    method: 'POST',
    path: '/api/logout',
    auth: 'session',
    csrf: true,
    wrongMethod: 405,
    handler: 'logout',
  },
  {
    host: 'boot',
    method: 'POST',
    path: '/api/onboarding/device',
    auth: 'session',
    csrf: true,
    wrongMethod: 405,
    handler: 'onboardingDevice',
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/api/model',
    auth: 'session',
    csrf: false,
    wrongMethod: 405,
    handler: 'model',
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/api/model-capture',
    auth: 'session',
    csrf: false,
    wrongMethod: 405,
    handler: 'modelCapture',
  },
  {
    host: 'boot',
    method: 'PUT',
    path: '/api/model-capture',
    auth: 'session',
    csrf: true,
    wrongMethod: 405,
    handler: 'modelCapture',
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/api/model-status',
    auth: 'session',
    csrf: false,
    wrongMethod: 405,
    handler: 'modelStatusRead',
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/api/workbench-source',
    auth: 'session',
    csrf: false,
    wrongMethod: 405,
    handler: 'workbench',
  },
  {
    host: 'boot',
    method: 'PUT',
    path: '/api/workbench-source',
    auth: 'session',
    csrf: true,
    wrongMethod: 405,
    handler: 'workbench',
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/api/workbench-status',
    auth: 'session',
    csrf: false,
    wrongMethod: 405,
    handler: 'workbench',
  },
  {
    host: 'boot',
    method: 'PUT',
    path: '/api/model/primary',
    auth: 'session',
    csrf: true,
    wrongMethod: 405,
    handler: 'modelSlotWrite',
  },
  {
    host: 'boot',
    method: 'PUT',
    path: '/api/model/reserve',
    auth: 'session',
    csrf: true,
    wrongMethod: 405,
    handler: 'modelSlotWrite',
  },
  {
    host: 'boot',
    method: 'DELETE',
    path: '/api/model/reserve',
    auth: 'session',
    csrf: true,
    wrongMethod: 405,
    handler: 'modelReserveDelete',
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/api/settings',
    auth: 'session',
    csrf: false,
    wrongMethod: 405,
    handler: 'settingsRead',
  },
  {
    host: 'boot',
    method: 'PUT',
    path: SETTINGS_KEY_ROUTE,
    auth: 'session',
    csrf: true,
    wrongMethod: 405,
    handler: 'settingWrite',
  },
  // The logs page and its API: a session on every method, GET included.
  {
    host: 'boot',
    method: 'GET',
    path: '/logs',
    auth: 'session',
    csrf: false,
    wrongMethod: 405,
    handler: 'logsPage',
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/api/logs',
    auth: 'session',
    csrf: false,
    wrongMethod: 405,
    handler: 'logsQuery',
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/api/logs/modules',
    auth: 'session',
    csrf: false,
    wrongMethod: 405,
    handler: 'logsModules',
  },
  // The owner's retention setting: read on GET, written on PUT, both under a
  // session and the write with the CSRF header and the exact Origin.
  {
    host: 'boot',
    method: 'GET',
    path: '/api/logs/settings',
    auth: 'session',
    csrf: false,
    wrongMethod: 405,
    handler: 'logsSettingsRead',
  },
  {
    host: 'boot',
    method: 'PUT',
    path: '/api/logs/settings',
    auth: 'session',
    csrf: true,
    wrongMethod: 405,
    handler: 'logsSettingsWrite',
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/',
    auth: 'none',
    csrf: false,
    wrongMethod: 405,
    handler: 'bootPage',
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/login',
    auth: 'none',
    csrf: false,
    wrongMethod: 405,
    handler: 'bootPage',
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/setup',
    auth: 'none',
    csrf: false,
    wrongMethod: 405,
    handler: 'bootPage',
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/logout',
    auth: 'none',
    csrf: false,
    wrongMethod: 405,
    handler: 'notFound',
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/favicon.svg',
    auth: 'none',
    csrf: false,
    wrongMethod: 404,
    handler: 'favicon',
  },
  {
    host: 'boot',
    method: 'GET',
    path: ASSET_ROUTE,
    auth: 'none',
    csrf: false,
    wrongMethod: 404,
    handler: 'assets',
  },
  {
    host: 'boot',
    method: 'GET',
    path: '/ca.crt',
    auth: 'none',
    csrf: false,
    wrongMethod: 404,
    handler: 'caCertificate',
  },
  {
    host: 'app',
    method: 'GET',
    path: '/_auth/handoff',
    auth: 'none',
    csrf: false,
    wrongMethod: 404,
    handler: 'handoff',
  },
  {
    host: 'loopback',
    method: 'ANY',
    path: '/_auth/handoff',
    auth: 'none',
    csrf: false,
    wrongMethod: 404,
    handler: 'handoff',
  },
  {
    host: 'loopback',
    method: 'ANY',
    path: '/_auth/verify',
    auth: 'none',
    csrf: false,
    wrongMethod: 404,
    handler: 'verify',
  },
  {
    host: 'service',
    method: 'ANY',
    path: '/_auth/verify',
    auth: 'none',
    csrf: false,
    wrongMethod: 404,
    handler: 'verify',
  },
];

/** The host a request arrived on, or null when the loader answers no route there. */
export function routeHostOf(host: string, instanceName: string): RouteHost | null {
  const name = hostName(host);
  if (name === `boot-${instanceName}.local`) return 'boot';
  if (name === `${instanceName}.local`) return 'app';
  if (name === '127.0.0.1') return 'loopback';
  if (name === SERVICE_VERIFY_HOST) return 'service';
  return null;
}

function matchesPath(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  if (pattern === SETTINGS_KEY_ROUTE) return settingsKeyOf(path) !== null;
  if (pattern === ASSET_ROUTE) return path.startsWith(ASSET_PREFIX);
  return false;
}

export interface RouteQuery {
  readonly host: RouteHost | null;
  readonly method: string;
  readonly path: string;
}

export type RouteDecision =
  | { readonly kind: 'route'; readonly entry: RouteEntry }
  | { readonly kind: 'method' }
  | { readonly kind: 'none' };

/** The request a handler receives. */
export interface RouteRequest {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly path: string;
  readonly method: string;
}

export type RouteHandler = (request: RouteRequest) => Promise<void>;

/**
 * The one dispatch decision: a matching route, a known path with the wrong
 * method (405), or nothing on this host (404). A literal path and the
 * settings-key pattern are known paths, so another method on them is 405 (the
 * table's `wrongMethod`); the asset prefix is only a GET prefix, so another
 * method there is 404. An unknown settings key matches nothing at all.
 */
export function matchRoute(query: RouteQuery): RouteDecision {
  if (query.host === null) return { kind: 'none' };
  let knownPath = false;
  for (const entry of ROUTES) {
    if (entry.host !== query.host || !matchesPath(entry.path, query.path)) continue;
    if (entry.method === 'ANY' || entry.method === query.method) return { kind: 'route', entry };
    if (entry.wrongMethod === 405) knownPath = true;
  }
  return knownPath ? { kind: 'method' } : { kind: 'none' };
}
