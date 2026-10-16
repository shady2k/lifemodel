/** Authenticated HTTP interface for the platform bootstrap loader. */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  configureInstanceName,
  clearSessionCookie,
  HANDOFF_TTL_MS,
  HANDOFF_CODE_BYTES,
  createSession,
  csrfToken,
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
import { LoaderFatalError } from './errors.js';
import type { LoaderLogger } from './logger.js';
import type { LoaderState } from './state.js';
import { describe } from './state.js';

export interface LoaderHttpDeps {
  state: LoaderState;
  logger: LoaderLogger;
  clock: Clock;
  instanceName: string;
}
export interface LoaderHttp {
  server: Server;
  close(): Promise<void>;
}
const MAX_FORM_BYTES = 8192;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;margin:3rem auto;max-width:34rem;line-height:1.5;color:#1a1a1a}h1{font-size:1.4rem}h2{font-size:1.1rem}form{margin-top:1rem}button,input{font:inherit;padding:.4rem}.bad{color:#a00}</style></head><body><h1>lifemodel platform loader</h1>${body}</body></html>`;
}
function sendHtml(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}
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
async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_FORM_BYTES) throw new LoaderFatalError('the form is too large');
    chunks.push(buffer);
  }
  const form: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(Buffer.concat(chunks).toString('utf8')))
    form[name] = value;
  return form;
}
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
function formPage(
  title: string,
  action: string,
  label: string,
  message?: string,
  next?: string | null
): string {
  const hiddenNext =
    next === undefined || next === null
      ? ''
      : `<input type="hidden" name="next" value="${escapeHtml(next)}">`;
  return page(
    title,
    `${message === undefined ? '' : `<p class="bad">${escapeHtml(message)}</p>`}<form method="post" action="${action}">${hiddenNext}<label for="password">${label}</label><input id="password" name="password" type="password" autocomplete="current-password" autofocus><p><button type="submit">Continue</button></p></form>`
  );
}

export function createLoaderHttp(deps: LoaderHttpDeps): LoaderHttp {
  const { state, logger, clock, instanceName } = deps;
  configureInstanceName(instanceName);
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
    return sameOrigin(header(req, 'origin'), header(req, 'referer'), header(req, 'host'))
      ? null
      : 'the request did not come from a page on this host';
  }
  function handoffRedirect(session: string, next: string, currentHost: string): string {
    const target = new URL(next);
    const path = `${target.pathname}${target.search}`; // URL fragments never reach the server.
    if (target.host === currentHost) return `${target.origin}${path}`;
    const code = randomBytes(HANDOFF_CODE_BYTES).toString('base64url');
    const expires = clock.now() + HANDOFF_TTL_MS;
    handoffCodes.set(code, { target: target.host, session, next: path, expires });
    return `${target.origin}/_auth/handoff?code=${encodeURIComponent(code)}&next=${encodeURIComponent(path)}`;
  }
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const method = req.method ?? 'GET';
    const serviceVerify =
      path === '/_auth/verify' &&
      hostName(req.headers.host ?? '') === 'loader.lifemodel-system.svc.cluster.local';
    if (!serviceVerify && !isAllowedHost(req.headers.host)) {
      sendText(res, 404, 'not found');
      return;
    }
    const requestHost = hostName(req.headers.host ?? '');
    const bootHost = `boot-${instanceName}.local`;
    const appHost = `${instanceName}.local`;
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
    const bootRouteAllowed =
      (method === 'GET' &&
        (path === '/' ||
          path === '/login' ||
          path === '/setup' ||
          path === '/ca.crt' ||
          path === '/api/state' ||
          path === '/api/model' ||
          path.startsWith('/assets/'))) ||
      (method === 'POST' &&
        (path === '/login' ||
          path === '/setup' ||
          path === '/logout' ||
          path === '/api/setup' ||
          path === '/api/login')) ||
      (['POST', 'PUT', 'DELETE'].includes(method) && path.startsWith('/api/'));
    if (requestHost === bootHost && !bootRouteAllowed) {
      sendText(res, 404, 'not found');
      return;
    }
    if (requestHost !== bootHost && requestHost !== appHost && !serviceVerify) {
      sendText(res, 404, 'not found');
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
          ? vettedNext(`http://${host}${nextParam}`, host)
          : null;
      const boot = `http://boot-${instanceName}.local/login`;
      if (
        entry === undefined ||
        entry.expires <= now ||
        entry.target !== host.toLowerCase() ||
        next === null ||
        entry.next !== `${new URL(next).pathname}${new URL(next).search}` ||
        record === null ||
        !verifySession(entry.session, record, now)
      ) {
        redirect(res, boot);
        return;
      }
      redirect(res, entry.next, { 'set-cookie': sessionCookie(entry.session, host) });
      return;
    }
    if (path === '/_auth/verify') {
      if (await hasSession(req)) {
        sendText(res, 200, 'ok');
        return;
      }
      const forwardedMethod = (header(req, 'x-forwarded-method') ?? '').toUpperCase();
      const next =
        forwardedMethod === 'GET' || forwardedMethod === 'HEAD'
          ? loginLocation(
              header(req, 'x-forwarded-host') ?? '',
              header(req, 'x-forwarded-uri') ?? '/'
            )
          : null;
      if (next === null) sendText(res, 401, 'no session');
      else redirect(res, next);
      return;
    }
    if (path === '/setup') {
      const existing = await state.readAuth();
      if (existing !== null) {
        redirect(res, '/login');
        return;
      }
      if (method === 'GET') {
        const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
        const next = vettedNext(query.get('next') ?? undefined, header(req, 'host') ?? '');
        sendHtml(res, 200, formPage('Set loader password', '/setup', 'Password', undefined, next));
        return;
      }
      if (method !== 'POST') {
        sendText(res, 405, 'the loader takes GET or POST here');
        return;
      }
      const refusal = refuseOrigin(req);
      if (refusal !== null) {
        sendHtml(res, 403, page('Refused', escapeHtml(refusal)));
        return;
      }
      const setupForm = await readForm(req);
      const password = setupForm['password'] ?? '';
      if (password === '') {
        sendHtml(
          res,
          400,
          formPage('Set loader password', '/setup', 'Password', 'A password is needed.')
        );
        return;
      }
      const record = await hashPassword(password);
      const installed = await withAuthTransition(async () => {
        if ((await state.readAuth()) !== null) return false;
        await state.writeAuth(record);
        return true;
      });
      if (!installed) {
        redirect(res, '/login');
        return;
      }
      logger.info({}, "the loader's password is set: platform authentication is ready");
      const host = req.headers.host ?? '';
      const token = createSession(record, clock.now());
      const next = vettedNext(setupForm['next'], host);
      redirect(res, next === null ? '/' : handoffRedirect(token, next, host), {
        'set-cookie': sessionCookie(token, host),
      });
      return;
    }
    if (path === '/login') {
      const record = await state.readAuth();
      if (record === null) {
        redirect(res, '/setup');
        return;
      }
      if (method === 'GET') {
        const active = sessionToken(req, record);
        const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
        const next = vettedNext(query.get('next') ?? undefined, header(req, 'host') ?? '');
        if (active !== null) {
          redirect(
            res,
            next === null ? '/' : handoffRedirect(active, next, header(req, 'host') ?? '')
          );
          return;
        }
        sendHtml(res, 200, formPage('Loader login', '/login', 'Password', undefined, next));
        return;
      }
      if (method !== 'POST') {
        sendText(res, 405, 'the loader takes GET or POST here');
        return;
      }
      const refusal = refuseOrigin(req);
      if (refusal !== null) {
        sendHtml(res, 403, page('Refused', escapeHtml(refusal)));
        return;
      }
      const form = await readForm(req);
      const password = form['password'] ?? '';
      const next = vettedNext(form['next'], header(req, 'host') ?? '');
      if (!(await verifyPassword(password, record))) {
        logger.warn(
          { host: req.headers.host ?? 'unknown', remote: req.socket.remoteAddress ?? 'unknown' },
          'login refused: the password does not match'
        );
        sendHtml(
          res,
          401,
          formPage('Loader login', '/login', 'Password', 'That password does not match.', next)
        );
        return;
      }
      const host = req.headers.host ?? '';
      const issued = await withAuthTransition(async () => {
        const current = await state.readAuth();
        if (current === null || !(await verifyPassword(password, current))) return null;
        return { record: current, token: createSession(current, clock.now()) };
      });
      if (issued === null) {
        sendHtml(
          res,
          401,
          formPage('Loader login', '/login', 'Password', 'That password does not match.', next)
        );
        return;
      }
      logger.info({ host }, 'the owner logged in');
      redirect(res, next === null ? '/' : handoffRedirect(issued.token, next, host), {
        'set-cookie': sessionCookie(issued.token, host),
      });
      return;
    }
    if (path === '/logout') {
      if (method !== 'POST') {
        sendText(res, 405, 'logging out is a POST from the loader page');
        return;
      }
      const record = await state.readAuth();
      const token = record === null ? null : sessionToken(req, record);
      if (record === null || token === null) {
        sendHtml(res, 401, page('Loader login', '<p>Not logged in.</p>'));
        return;
      }
      const form = await readForm(req);
      const refusal =
        refuseOrigin(req) ??
        (verifyCsrf(form['csrf'] ?? '', record, token)
          ? null
          : 'the form carried no anti-CSRF token of this session');
      if (refusal !== null) {
        sendHtml(res, 403, page('Refused', escapeHtml(refusal)));
        return;
      }
      const loggedOut = await withAuthTransition(async () => {
        const current = await state.readAuth();
        const currentToken = current === null ? null : sessionToken(req, current);
        if (
          current === null ||
          currentToken === null ||
          !verifyCsrf(form['csrf'] ?? '', current, currentToken)
        )
          return false;
        current.sessionSecret = randomBytes(32).toString('base64');
        await state.writeAuth(current);
        return true;
      });
      if (!loggedOut) {
        sendHtml(res, 401, page('Loader login', '<p>Not logged in.</p>'));
        return;
      }
      logger.info({}, 'the owner logged out');
      redirect(res, '/login', {
        'set-cookie': clearSessionCookie(req.headers.host ?? ''),
      });
      return;
    }
    if (path === '/' && method !== 'POST') {
      const record = await state.readAuth();
      const token = record === null ? null : sessionToken(req, record);
      if (record === null || token === null) {
        sendHtml(
          res,
          401,
          page(
            'Loader login',
            '<p class="bad">Not logged in.</p><p><a href="/login">Log in</a></p>'
          )
        );
        return;
      }
      const csrf = csrfToken(record, token);
      sendHtml(
        res,
        200,
        page(
          'Platform loader',
          '<h2>Platform mode</h2><p>This loader provides authentication and resumable platform bootstrap. It does not run a lifemodel instance.</p><form method="post" action="/logout"><input type="hidden" name="csrf" value="' +
            csrf +
            '"><button type="submit">Log out</button></form>'
        )
      );
      return;
    }
    if (path === '/' && method === 'POST') {
      sendText(res, 405, 'there is no action at /');
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
        { path: req.url ?? '', method: req.method ?? '', error: describe(error) },
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
