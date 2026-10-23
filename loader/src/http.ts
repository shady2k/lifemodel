/** Authenticated HTTP interface for the platform bootstrap loader. */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  clearSessionCookie,
  configureInstanceName,
  createSession,
  csrfToken,
  HANDOFF_CODE_BYTES,
  HANDOFF_TTL_MS,
  hashPassword,
  hostName,
  isAllowedHost,
  loginLocation,
  parseCookies,
  type PasswordRecord,
  sameOrigin,
  SESSION_COOKIE_NAME,
  sessionCookie,
  verifyCsrf,
  verifyPassword,
  verifySession,
  vettedNext,
} from './auth.js';
import type { Clock } from './clock.js';
import type { LoaderLogger } from './logger.js';
import type { LoaderState } from './state.js';
import type { LoaderConfig } from './config.js';
import type { PkiManager } from './pki.js';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createModelChecker,
  MAX_SLOT_BODY,
  ModelCheckError,
  publicSlot,
  SlotHeaderError,
  validateSlotHeaders,
  type ModelSlot,
  type ModelSlotHeader,
  type ModelSlotName,
  type ModelSlots,
} from './model.js';
import {
  createModelStatusReader,
  parseLoaderModelStatus,
  type LoaderModelStatus,
  type ModelStatusReader,
} from './model-status.js';
import { SettingsWriteError, type SettingsSectionSnapshot } from './settings/store.js';
import { SETTING_KEY_PATTERN } from './settings/registry.js';

/** The settings seam the HTTP layer sees: the section and one validated write. */
export interface SettingsHttp {
  section(): SettingsSectionSnapshot;
  set(key: string, value: unknown): Promise<{ value: boolean | number | string; revision: number }>;
}

export interface LoaderHttpDeps {
  state: LoaderState;
  logger: LoaderLogger;
  clock: Clock;
  pki: PkiManager;
  config: LoaderConfig;
  uiRoot?: string;
  modelSlots?: ModelSlots;
  modelStatus?: ModelStatusReader;
  modelChecker?: (slot: ModelSlot, slotName?: ModelSlotName) => Promise<void>;
  settings?: SettingsHttp;
}
export interface LoaderHttp {
  server: Server;
  close(): Promise<void>;
}
const MAX_FORM_BYTES = 8192;
const API_METHODS: Record<string, string> = {
  '/api/state': 'GET',
  '/api/setup': 'POST',
  '/api/login': 'POST',
  '/api/password': 'POST',
  '/api/logout': 'POST',
  '/api/onboarding/device': 'POST',
  '/api/model': 'GET',
  '/api/model-status': 'GET',
  '/api/model/primary': 'PUT',
  '/api/model/reserve': 'PUT',
  '/api/settings': 'GET',
};
function settingsKeyOf(path: string): string | null {
  if (!path.startsWith('/api/settings/')) return null;
  const key = path.slice('/api/settings/'.length);
  return SETTING_KEY_PATTERN.test(key) ? key : null;
}
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}
function redirect(
  res: ServerResponse,
  location: string,
  headers: Record<string, string> = {}
): void {
  res.writeHead(303, { location, 'cache-control': 'no-store', ...headers });
  res.end();
}
export function createLoaderHttp(deps: LoaderHttpDeps): LoaderHttp {
  const { state, logger, clock, pki, config } = deps;
  const slots: ModelSlots = deps.modelSlots ?? {
    read: () => Promise.reject(new Error('model storage unavailable')),
    write: () => Promise.reject(new Error('model storage unavailable')),
    clearReserve: () => Promise.reject(new Error('model storage unavailable')),
  };
  const defaultModelChecker = createModelChecker();
  const checkModel = deps.modelChecker ?? defaultModelChecker;
  const settings: SettingsHttp = deps.settings ?? {
    section: () => {
      throw new Error('settings storage unavailable');
    },
    set: () => Promise.reject(new Error('settings storage unavailable')),
  };
  const modelStatus: ModelStatusReader =
    deps.modelStatus ?? createModelStatusReader({ url: config.modelStatusUrl });
  const modelChecks = new Set<ModelSlotName>();
  const uiRoot = resolve(
    deps.uiRoot ??
      process.env['LIFEMODEL_UI_ROOT'] ??
      fileURLToPath(new URL('../../web/loader/dist/', import.meta.url))
  );
  configureInstanceName(config.instanceName);
  // Single loader replica: short-lived codes remain process-local by design.
  interface HandoffEntry {
    session: string;
    target: string;
    next: string;
    expires: number;
  }
  const handoffCodes = new Map<string, HandoffEntry>();
  let authTransition: Promise<void> = Promise.resolve();
  async function withAuthTransition<T>(action: () => Promise<T>): Promise<T> {
    const previous = authTransition;
    let release!: () => void;
    authTransition = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
  const header = (req: IncomingMessage, name: string): string | undefined => {
    const value = req.headers[name];
    return typeof value === 'string' ? value : undefined;
  };
  const sessionToken = (req: IncomingMessage, record: PasswordRecord): string | null => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
    return token !== undefined && verifySession(token, record, clock.now()) ? token : null;
  };
  async function hasSession(req: IncomingMessage): Promise<boolean> {
    const record = await state.readAuth();
    return record !== null && sessionToken(req, record) !== null;
  }
  function refuseOrigin(req: IncomingMessage): string | null {
    return sameOrigin(header(req, 'origin'), undefined, `boot-${config.instanceName}.local`)
      ? null
      : 'the request did not come from a page on this host';
  }
  function handoffRedirect(session: string, next: string, currentHost: string): string {
    const target = new URL(next);
    const path = `${target.pathname}${target.search}`;
    if (target.host === currentHost) return `${target.origin}${path}`;
    const code = randomBytes(HANDOFF_CODE_BYTES).toString('base64url');
    handoffCodes.set(code, {
      target: target.host,
      session,
      next: path,
      expires: clock.now() + HANDOFF_TTL_MS,
    });
    return `${target.origin}/_auth/handoff?code=${encodeURIComponent(code)}&next=${encodeURIComponent(path)}`;
  }
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const method = req.method ?? 'GET';
    const serviceVerify =
      path === '/_auth/verify' &&
      hostName(req.headers.host ?? '') === 'loader.lifemodel-system.svc.cluster.local';
    if (!serviceVerify && !isAllowedHost(req.headers.host, config.instanceName)) {
      sendText(res, 404, 'not found');
      return;
    }
    const requestHost = hostName(req.headers.host ?? '');
    const bootHost = `boot-${config.instanceName}.local`;
    const appHost = `${config.instanceName}.local`;
    if (
      !serviceVerify &&
      requestHost === appHost &&
      (path !== '/_auth/handoff' || method !== 'GET')
    ) {
      sendText(res, 404, 'not found');
      return;
    }
    if (!serviceVerify && requestHost === bootHost && path === '/_auth/handoff') {
      sendText(res, 404, 'not found');
      return;
    }
    if (!serviceVerify && requestHost === bootHost && path.startsWith('/api/')) {
      const expectedMethod = settingsKeyOf(path) !== null ? 'PUT' : API_METHODS[path];
      if (expectedMethod === undefined) {
        sendText(res, 404, 'not found');
        return;
      }
      const validMethod =
        path === '/api/model/reserve'
          ? method === 'PUT' || method === 'DELETE'
          : method === expectedMethod;
      if (!validMethod) {
        sendText(res, 405, 'method not allowed');
        return;
      }
    }
    const bootRouteAllowed =
      (method === 'GET' &&
        (path === '/' ||
          path === '/login' ||
          path === '/setup' ||
          path === '/ca.crt' ||
          path === '/favicon.svg' ||
          path === '/api/state' ||
          path === '/api/model' ||
          path === '/api/model-status' ||
          path.startsWith('/assets/'))) ||
      (method === 'POST' &&
        (path === '/api/setup' ||
          path === '/api/login' ||
          path === '/api/password' ||
          path === '/api/logout' ||
          path === '/api/onboarding/device')) ||
      (method === 'PUT' && (path === '/api/model/primary' || path === '/api/model/reserve')) ||
      (method === 'DELETE' && path === '/api/model/reserve') ||
      (method === 'GET' && path === '/api/settings') ||
      (method === 'PUT' && settingsKeyOf(path) !== null);
    if (
      !serviceVerify &&
      requestHost === bootHost &&
      ['/', '/login', '/setup', '/logout'].includes(path) &&
      method !== 'GET'
    ) {
      sendText(res, 405, 'method not allowed');
      return;
    }
    if (!serviceVerify && requestHost === bootHost && !bootRouteAllowed) {
      sendText(res, 404, 'not found');
      return;
    }
    if (
      !serviceVerify &&
      requestHost !== bootHost &&
      requestHost !== appHost &&
      requestHost !== '127.0.0.1'
    ) {
      sendText(res, 404, 'not found');
      return;
    }
    if (requestHost === bootHost && path.startsWith('/api/')) {
      res.setHeader('cache-control', 'no-store');
      res.setHeader('content-security-policy', CSP);
      res.setHeader('x-content-type-options', 'nosniff');
      if (path === '/api/state' && method === 'GET') {
        const record = await state.readAuth();
        const token = record === null ? null : sessionToken(req, record);
        if (token !== null && record !== null) {
          await state.reconcilePasswordOnboarding?.();
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            setupNeeded: record === null,
            loggedIn: token !== null,
            ...(record !== null && token !== null ? { csrfToken: csrfToken(record, token) } : {}),
            ...(token !== null && state.readOnboarding !== undefined
              ? {
                  onboarding: await state.readOnboarding(),
                  instanceName: config.instanceName,
                  caFingerprint:
                    (await pki.report()).caFingerprint ?? (await pki.report()).fingerprint,
                }
              : {}),
          })
        );
        return;
      }
      if (path === '/api/setup' || path === '/api/login') {
        if (
          header(req, 'content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
        ) {
          res.writeHead(415, { 'content-type': 'application/json; charset=utf-8' });
          res.end('{"error":"content_type"}');
          return;
        }
        const refusal = refuseOrigin(req);
        if (refusal !== null) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
          res.end('{"error":"origin"}');
          return;
        }
        const chunks: Uint8Array[] = [];
        let bodyBytes = 0;
        for await (const chunk of req) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bodyBytes += bytes.length;
          if (bodyBytes > MAX_FORM_BYTES) break;
          chunks.push(new Uint8Array(bytes));
        }
        if (bodyBytes > MAX_FORM_BYTES) {
          res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
          res.end('{"error":"body_too_large"}');
          return;
        }
        let payload: { password?: unknown; next?: unknown };
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
            throw new Error('invalid object');
          payload = parsed as { password?: unknown; next?: unknown };
        } catch {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end('{"error":"invalid_body"}');
          return;
        }
        const requestHost = req.headers.host ?? '';
        const next =
          typeof payload.next === 'string'
            ? vettedNext(payload.next, requestHost, config.instanceName)
            : null;
        if (payload.next !== undefined && next === null) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end('{"error":"next"}');
          return;
        }
        const password = typeof payload.password === 'string' ? payload.password : '';
        if (password.length < (path === '/api/setup' ? 12 : 1) || password.length > 1024) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end('{"error":"password"}');
          return;
        }
        if (path === '/api/setup') {
          if ((await state.readAuth()) !== null) {
            res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
            res.end('{"error":"already_setup"}');
            return;
          }
          const record = await hashPassword(password);
          const installed = await withAuthTransition(async () => {
            if ((await state.readAuth()) !== null) return false;
            await state.writeAuth(record);
            return true;
          });
          if (!installed) {
            res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
            res.end('{"error":"already_setup"}');
            return;
          }
          await state.savePasswordOnboarding?.();
          const token = createSession(record, clock.now());
          const location = null;
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'set-cookie': sessionCookie(token, req.headers.host ?? ''),
            'cache-control': 'no-store',
          });
          res.end(
            JSON.stringify({ ok: true, ...(location === null ? {} : { redirectTo: location }) })
          );
          return;
        }
        const login = await withAuthTransition(async () => {
          const record = await state.readAuth();
          if (record === null || !(await verifyPassword(password, record))) return null;
          await state.reconcilePasswordOnboarding?.();
          const token = createSession(record, clock.now());
          const onboarding = await state.readOnboarding?.();
          const location =
            next === null || onboarding?.step !== 'done'
              ? null
              : handoffRedirect(token, next, requestHost);
          return { token, location };
        });
        if (login === null) {
          res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
          res.end('{"error":"invalid_credentials"}');
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'set-cookie': sessionCookie(login.token, req.headers.host ?? ''),
          'cache-control': 'no-store',
        });
        res.end(
          JSON.stringify({
            ok: true,
            ...(login.location === null ? {} : { redirectTo: login.location }),
          })
        );
        return;
      }
      if (path === '/api/password' && method === 'POST') {
        const initial = await state.readAuth();
        const token = initial === null ? null : sessionToken(req, initial);
        if (initial === null || token === null) {
          res.writeHead(401);
          res.end();
          return;
        }
        if (
          refuseOrigin(req) !== null ||
          !verifyCsrf(header(req, 'x-csrf-token') ?? '', initial, token)
        ) {
          res.writeHead(403);
          res.end('{"error":"origin_or_csrf"}');
          return;
        }
        if (
          header(req, 'content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
        ) {
          res.writeHead(415);
          res.end('{"error":"content_type"}');
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += part.length;
          if (size > MAX_FORM_BYTES) break;
          chunks.push(Buffer.from(part));
        }
        if (size > MAX_FORM_BYTES) {
          res.writeHead(413);
          res.end('{"error":"body_too_large"}');
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400);
          res.end('{"error":"invalid_body"}');
          return;
        }
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          res.writeHead(400);
          res.end('{"error":"invalid_body"}');
          return;
        }
        const value = payload as Record<string, unknown>;
        if (
          Object.keys(value).length !== 2 ||
          Object.keys(value).some((key) => !['currentPassword', 'newPassword'].includes(key)) ||
          typeof value['currentPassword'] !== 'string' ||
          value['currentPassword'].length < 1 ||
          value['currentPassword'].length > 1024 ||
          typeof value['newPassword'] !== 'string' ||
          value['newPassword'].length < 12 ||
          value['newPassword'].length > 1024
        ) {
          res.writeHead(400);
          res.end('{"error":"invalid_body"}');
          return;
        }
        const replacement = await withAuthTransition(async () => {
          const current = await state.readAuth();
          const currentToken = current === null ? null : sessionToken(req, current);
          if (
            current === null ||
            currentToken === null ||
            !verifyCsrf(header(req, 'x-csrf-token') ?? '', current, currentToken)
          )
            return null;
          if (!(await verifyPassword(value['currentPassword'] as string, current))) return false;
          const updated = await hashPassword(value['newPassword'] as string);
          await state.replaceAuth(updated);
          return updated;
        });
        if (replacement === false) {
          res.writeHead(401);
          res.end('{"error":"invalid_credentials"}');
          return;
        }
        if (replacement === null) {
          res.writeHead(401);
          res.end();
          return;
        }
        const fresh = createSession(replacement, clock.now());
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'set-cookie': sessionCookie(fresh, req.headers.host ?? ''),
          'cache-control': 'no-store',
        });
        res.end('{"ok":true}');
        return;
      }
      if (path === '/api/model' && method === 'GET') {
        const origin = header(req, 'origin');
        const fetchSite = header(req, 'sec-fetch-site');
        const record = await state.readAuth();
        const token = record === null ? null : sessionToken(req, record);
        if (
          token === null ||
          (origin !== undefined &&
            !sameOrigin(origin, undefined, `boot-${config.instanceName}.local`)) ||
          (fetchSite !== undefined && fetchSite !== 'same-origin')
        ) {
          res.writeHead(403);
          res.end();
          return;
        }
        try {
          const [primary, reserve] = await Promise.all([
            slots.read('primary'),
            slots.read('reserve'),
          ]);
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(JSON.stringify({ primary: publicSlot(primary), reserve: publicSlot(reserve) }));
        } catch {
          res.writeHead(503, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end('{"error":"storage_unavailable"}');
        }
        return;
      }
      if (path === '/api/model-status' && method === 'GET') {
        const origin = header(req, 'origin');
        const fetchSite = header(req, 'sec-fetch-site');
        const record = await state.readAuth();
        const token = record === null ? null : sessionToken(req, record);
        if (
          token === null ||
          (origin !== undefined &&
            !sameOrigin(origin, undefined, `boot-${config.instanceName}.local`)) ||
          (fetchSite !== undefined && fetchSite !== 'same-origin')
        ) {
          res.writeHead(403);
          res.end();
          return;
        }
        // ADR-013 D6: the safe fields only — the reader's own value is
        // re-projected at the browser boundary — and an unreadable status is a
        // plain "unavailable" for the settings page, never an error page.
        let status: LoaderModelStatus | null = null;
        try {
          status = parseLoaderModelStatus(await modelStatus.read());
        } catch {
          status = null;
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify(status));
        return;
      }
      if (path === '/api/settings' && method === 'GET') {
        const origin = header(req, 'origin');
        const fetchSite = header(req, 'sec-fetch-site');
        const record = await state.readAuth();
        const token = record === null ? null : sessionToken(req, record);
        if (
          token === null ||
          (origin !== undefined &&
            !sameOrigin(origin, undefined, `boot-${config.instanceName}.local`)) ||
          (fetchSite !== undefined && fetchSite !== 'same-origin')
        ) {
          res.writeHead(403);
          res.end();
          return;
        }
        try {
          const section = settings.section();
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(JSON.stringify(section));
        } catch {
          res.writeHead(503, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end('{"error":"storage_unavailable"}');
        }
        return;
      }
      if (path.startsWith('/api/settings/') && method === 'PUT') {
        const key = settingsKeyOf(path);
        if (key === null) {
          sendText(res, 404, 'not found');
          return;
        }
        const record = await state.readAuth();
        const token = record === null ? null : sessionToken(req, record);
        if (record === null || token === null) {
          res.writeHead(401);
          res.end();
          return;
        }
        if (
          refuseOrigin(req) !== null ||
          !verifyCsrf(header(req, 'x-csrf-token') ?? '', record, token)
        ) {
          res.writeHead(403);
          res.end('{"error":"origin_or_csrf"}');
          return;
        }
        if (
          header(req, 'content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
        ) {
          res.writeHead(415);
          res.end('{"error":"content_type"}');
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += part.length;
          if (size > MAX_FORM_BYTES) break;
          chunks.push(Buffer.from(part));
        }
        if (size > MAX_FORM_BYTES) {
          res.writeHead(413);
          res.end('{"error":"body_too_large"}');
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400);
          res.end('{"error":"invalid_body"}');
          return;
        }
        if (
          typeof payload !== 'object' ||
          payload === null ||
          Array.isArray(payload) ||
          Object.keys(payload).length !== 1 ||
          !('value' in payload)
        ) {
          res.writeHead(400);
          res.end('{"error":"invalid_body"}');
          return;
        }
        try {
          const written = await settings.set(key, (payload as { value: unknown }).value);
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(JSON.stringify({ ok: true, ...written }));
        } catch (error) {
          if (error instanceof SettingsWriteError) {
            const status = error.code === 'unknown_key' ? 404 : 400;
            const code =
              error.code === 'unknown_key'
                ? 'unknown_setting'
                : error.code === 'secret_setting'
                  ? 'secret_setting'
                  : 'invalid_value';
            res.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            });
            res.end(
              JSON.stringify({
                error: code,
                reason: error.message,
                ...(error.code === 'unknown_key' || error.code === 'secret_setting'
                  ? {}
                  : { reasonCode: error.code }),
                ...(error.limit === undefined ? {} : { limit: error.limit }),
              })
            );
            return;
          }
          res.writeHead(503, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end('{"error":"storage_unavailable"}');
        }
        return;
      }
      if ((path === '/api/model/primary' || path === '/api/model/reserve') && method === 'PUT') {
        const slotName = path.endsWith('/primary') ? 'primary' : 'reserve';
        const record = await state.readAuth();
        const token = record === null ? null : sessionToken(req, record);
        if (record === null || token === null) {
          res.writeHead(401);
          res.end();
          return;
        }
        if (
          refuseOrigin(req) !== null ||
          !verifyCsrf(header(req, 'x-csrf-token') ?? '', record, token)
        ) {
          res.writeHead(403);
          res.end('{"error":"origin_or_csrf"}');
          return;
        }
        if (
          header(req, 'content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
        ) {
          res.writeHead(415);
          res.end('{"error":"content_type"}');
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += part.length;
          if (size > MAX_SLOT_BODY) break;
          chunks.push(Buffer.from(part));
        }
        if (size > MAX_SLOT_BODY) {
          res.writeHead(413);
          res.end('{"error":"body_too_large"}');
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400);
          res.end('{"error":"invalid_body"}');
          return;
        }
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          res.writeHead(400);
          res.end('{"error":"invalid_body"}');
          return;
        }
        const value = payload as Record<string, unknown>;
        if (
          Object.keys(value).some(
            (key) => !['kind', 'baseUrl', 'model', 'key', 'headers'].includes(key)
          ) ||
          (value['kind'] !== 'openai' && value['kind'] !== 'ollama') ||
          typeof value['baseUrl'] !== 'string' ||
          typeof value['model'] !== 'string' ||
          value['model'].length === 0 ||
          (value['key'] !== undefined && typeof value['key'] !== 'string')
        ) {
          res.writeHead(400);
          res.end('{"error":"invalid_body"}');
          return;
        }
        // A header list that breaks a rule is refused with the rule's own
        // code, before the endpoint is checked (ADR-013, custom headers). An
        // omitted list keeps the stored one, like the key; `[]` clears it.
        let headers: ModelSlotHeader[] | undefined;
        if (value['headers'] !== undefined) {
          try {
            headers = validateSlotHeaders(value['headers']);
          } catch (error) {
            res.writeHead(400, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            });
            res.end(
              JSON.stringify({
                error: error instanceof SlotHeaderError ? error.code : 'invalid_body',
              })
            );
            return;
          }
        }
        try {
          const old = await slots.read(slotName);
          const candidate: ModelSlot = {
            kind: value['kind'],
            baseUrl: value['baseUrl'],
            model: value['model'],
            ...(value['key'] === undefined && old?.key !== undefined
              ? { key: old.key }
              : value['key'] === undefined
                ? {}
                : { key: value['key'] }),
            ...(headers !== undefined
              ? { headers }
              : old?.headers !== undefined
                ? { headers: old.headers }
                : {}),
          };
          if (modelChecks.has(slotName)) {
            res.writeHead(409);
            res.end('{"error":"check_in_progress"}');
            return;
          }
          modelChecks.add(slotName);
          try {
            await checkModel(candidate, slotName);
          } finally {
            modelChecks.delete(slotName);
          }
          await slots.write(slotName, candidate);
          if (slotName === 'primary') await state.saveModelOnboarding?.();
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(JSON.stringify({ ok: true, slot: publicSlot(candidate) }));
        } catch (error) {
          const code = error instanceof ModelCheckError ? error.code : 'storage_unavailable';
          const status =
            error instanceof ModelCheckError ? (code === 'blocked_destination' ? 400 : 502) : 503;
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(JSON.stringify({ error: code }));
        }
        return;
      }
      if (path === '/api/model/reserve' && method === 'DELETE') {
        const record = await state.readAuth();
        const token = record === null ? null : sessionToken(req, record);
        if (record === null || token === null) {
          res.writeHead(401);
          res.end();
          return;
        }
        if (
          refuseOrigin(req) !== null ||
          !verifyCsrf(header(req, 'x-csrf-token') ?? '', record, token)
        ) {
          res.writeHead(403);
          res.end('{"error":"origin_or_csrf"}');
          return;
        }
        if (
          header(req, 'content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
        ) {
          res.writeHead(415);
          res.end('{"error":"content_type"}');
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += part.length;
          if (size > 16 * 1024) break;
          chunks.push(Buffer.from(part));
        }
        if (size > 16 * 1024) {
          res.writeHead(413);
          res.end('{"error":"body_too_large"}');
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400);
          res.end('{"error":"invalid_body"}');
          return;
        }
        if (
          typeof payload !== 'object' ||
          payload === null ||
          Array.isArray(payload) ||
          Object.keys(payload).length !== 0
        ) {
          res.writeHead(400);
          res.end('{"error":"invalid_body"}');
          return;
        }
        try {
          await slots.clearReserve();
          res.writeHead(200, { 'cache-control': 'no-store' });
          res.end();
        } catch {
          res.writeHead(503);
          res.end('{"error":"storage_unavailable"}');
        }
        return;
      }
      if (path === '/api/onboarding/device' && method === 'POST') {
        const record = await state.readAuth();
        const token = record === null ? null : sessionToken(req, record);
        if (record === null || token === null) {
          res.writeHead(401);
          res.end();
          return;
        }
        if (
          refuseOrigin(req) !== null ||
          !verifyCsrf(header(req, 'x-csrf-token') ?? '', record, token)
        ) {
          res.writeHead(403);
          res.end('{"error":"origin_or_csrf"}');
          return;
        }
        if (
          header(req, 'content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
        ) {
          res.writeHead(415);
          res.end('{"error":"content_type"}');
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += part.length;
          if (size > MAX_FORM_BYTES) break;
          chunks.push(Buffer.from(part));
        }
        if (size > MAX_FORM_BYTES) {
          res.writeHead(413);
          res.end('{"error":"body_too_large"}');
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400);
          res.end('{"error":"invalid_body"}');
          return;
        }
        if (
          typeof payload !== 'object' ||
          payload === null ||
          Array.isArray(payload) ||
          Object.keys(payload).length !== 0
        ) {
          res.writeHead(400);
          res.end('{"error":"invalid_body"}');
          return;
        }
        try {
          const onboarding = await state.readOnboarding?.();
          if (
            onboarding?.step !== 'device' ||
            onboarding?.completedAt !== null ||
            !state.completeDeviceOnboarding
          ) {
            res.writeHead(409);
            res.end('{"error":"step_conflict"}');
            return;
          }
          await state.completeDeviceOnboarding(new Date(clock.now()).toISOString());
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end('{"ok":true}');
        } catch {
          res.writeHead(409);
          res.end('{"error":"step_conflict"}');
        }
        return;
      }
      if (path === '/api/logout' && method === 'POST') {
        const record = await state.readAuth();
        const token = record === null ? null : sessionToken(req, record);
        if (record === null || token === null) {
          res.writeHead(401);
          res.end();
          return;
        }
        if (
          refuseOrigin(req) !== null ||
          !verifyCsrf(header(req, 'x-csrf-token') ?? '', record, token)
        ) {
          res.writeHead(403);
          res.end();
          return;
        }
        const loggedOut = await withAuthTransition(async () => {
          const current = await state.readAuth();
          const currentToken = current === null ? null : sessionToken(req, current);
          if (
            current === null ||
            currentToken === null ||
            !verifyCsrf(header(req, 'x-csrf-token') ?? '', current, currentToken)
          )
            return false;
          current.sessionSecret = randomBytes(32).toString('base64');
          await state.replaceAuth(current);
          return true;
        });
        if (!loggedOut) {
          res.writeHead(401);
          res.end();
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'set-cookie': clearSessionCookie(req.headers.host ?? ''),
        });
        res.end('{"ok":true}');
        return;
      }
    }
    if (requestHost === bootHost && path === '/favicon.svg' && method === 'GET') {
      try {
        const bytes = await readFile(resolve(uiRoot, 'favicon.svg'));
        res.writeHead(200, {
          'content-type': 'image/svg+xml',
          'cache-control': 'public, max-age=86400',
          'content-security-policy': CSP,
          'x-content-type-options': 'nosniff',
        });
        res.end(bytes);
      } catch {
        sendText(res, 404, 'not found');
      }
      return;
    }
    if (requestHost === bootHost && path.startsWith('/assets/')) {
      try {
        const relative = path.slice(1);
        const asset = resolve(uiRoot, relative);
        if (!asset.startsWith(uiRoot + sep)) {
          sendText(res, 404, 'not found');
          return;
        }
        const bytes = await readFile(asset);
        const immutable = /-[A-Za-z0-9_-]{8,}\./.test(relative.split('/').pop() ?? '');
        res.writeHead(200, {
          'content-type': relative.endsWith('.html')
            ? 'text/html; charset=utf-8'
            : relative.endsWith('.css')
              ? 'text/css; charset=utf-8'
              : relative.endsWith('.js')
                ? 'text/javascript; charset=utf-8'
                : 'font/woff2',
          'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
          'content-security-policy': CSP,
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        });
        res.end(bytes);
        return;
      } catch {
        sendText(res, 404, 'not found');
        return;
      }
    }
    if (
      path === '/ca.crt' &&
      method === 'GET' &&
      hostName(req.headers.host ?? '') === `boot-${config.instanceName}.local`
    ) {
      res.writeHead(200, {
        'content-type': 'application/x-pem-file',
        'cache-control': 'public, max-age=300',
      });
      res.end(await pki.caPem());
      return;
    }
    if (path === '/_auth/handoff') {
      const host = req.headers.host ?? '';
      const url = new URL(req.url ?? '/', `http://${host}`);
      const code = url.searchParams.get('code') ?? '';
      const entry = handoffCodes.get(code);
      // Consume synchronously before awaits: concurrent redemption cannot reuse it.
      if (entry !== undefined) handoffCodes.delete(code);
      const now = clock.now();
      for (const [key, value] of handoffCodes) if (value.expires <= now) handoffCodes.delete(key);
      const record = await state.readAuth();
      const nextParam = url.searchParams.get('next');
      const next =
        nextParam?.startsWith('/') && !nextParam.startsWith('//')
          ? vettedNext(`https://${host}${nextParam}`, host, config.instanceName)
          : null;
      const boot = `https://boot-${config.instanceName}.local/login`;
      if (
        entry === undefined ||
        entry.expires <= now ||
        entry.target !== host.toLowerCase() ||
        next === null ||
        entry.next !== `${new URL(next).pathname}${new URL(next).search}` ||
        record === null ||
        !verifySession(entry.session, record, now)
      ) {
        redirect(res, boot, { 'referrer-policy': 'no-referrer' });
        return;
      }
      redirect(res, entry.next, {
        'set-cookie': sessionCookie(entry.session, host),
        'referrer-policy': 'no-referrer',
      });
      return;
    }
    if (path === '/_auth/verify') {
      if (await hasSession(req)) {
        sendText(res, 200, 'ok');
        return;
      }
      const forwardedMethod = (header(req, 'x-forwarded-method') ?? '').toUpperCase();
      // A missing session must never turn a file download into a saved login page.
      if ((header(req, 'x-forwarded-uri') ?? '').startsWith('/api/attachments/')) {
        sendText(res, 401, 'no session');
        return;
      }
      const next =
        forwardedMethod === 'GET' || forwardedMethod === 'HEAD'
          ? loginLocation(
              `${config.instanceName}.local`,
              header(req, 'x-forwarded-uri') ?? '/',
              config.instanceName
            )
          : null;
      if (next === null) sendText(res, 401, 'no session');
      else redirect(res, next);
      return;
    }
    if ((path === '/' || path === '/login' || path === '/setup') && requestHost === bootHost) {
      const record = await state.readAuth();
      const query = new URL(req.url ?? '/', `https://${req.headers.host ?? bootHost}`).searchParams;
      const safeNext = vettedNext(
        query.get('next') ?? undefined,
        req.headers.host ?? '',
        config.instanceName
      );
      const nextQuery = safeNext === null ? '' : `?next=${encodeURIComponent(safeNext)}`;
      if (record === null && path !== '/setup') {
        redirect(res, `/setup${nextQuery}`);
        return;
      }
      if (record !== null && path === '/setup') {
        await state.reconcilePasswordOnboarding?.();
        const onboarding = await state.readOnboarding?.();
        if (onboarding !== undefined && onboarding.step !== 'done') {
          // Keep authenticated unfinished onboarding in the app shell.
        } else {
          redirect(res, `/login${nextQuery}`);
          return;
        }
      }
      if (record !== null && sessionToken(req, record) !== null && path !== '/') {
        await state.reconcilePasswordOnboarding?.();
        const onboarding = await state.readOnboarding?.();
        if (onboarding !== undefined && onboarding.step !== 'done') {
          try {
            const bytes = await readFile(resolve(uiRoot, 'index.html'));
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-cache',
              'content-security-policy': CSP,
              'x-content-type-options': 'nosniff',
              'referrer-policy': 'no-referrer',
            });
            res.end(bytes);
          } catch {
            sendText(res, 503, 'loader interface is unavailable');
          }
          return;
        }
        const token = sessionToken(req, record);
        if (token === null) {
          redirect(res, '/');
          return;
        }
        redirect(
          res,
          safeNext === null ? '/' : handoffRedirect(token, safeNext, req.headers.host ?? '')
        );
        return;
      }
      try {
        const bytes = await readFile(resolve(uiRoot, 'index.html'));
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
          'content-security-policy': CSP,
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        });
        res.end(bytes);
      } catch {
        sendText(res, 503, 'loader interface is unavailable');
      }
      return;
    }
    if (path === '/panic' || path === '/resume' || path.startsWith('/_api/')) {
      sendText(res, 404, 'not found');
      return;
    }
    sendText(res, 404, 'not found');
  }
  const server = createServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      logger.error(
        {
          path: (req.url ?? '').split('?')[0],
          method: req.method ?? '',
          errorType: error instanceof Error ? error.name : 'unknown',
        },
        'the loader could not answer a request'
      );
      if (!res.headersSent) sendText(res, 500, 'the loader could not answer this request');
      else res.end();
    });
  });
  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
