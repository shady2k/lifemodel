/**
 * The loader's own web interface (lifemodel-q4x.2.1, stories S1, S2, S6).
 *
 * It listens on loopback only and is always up, independent of lifemodel:
 * that is what makes it the way back when lifemodel has become a brick. It
 * answers three kinds of caller:
 *
 *   - a browser without a session: /setup (only while no password is set) and
 *     /login, the two routes the front door leaves open;
 *   - a browser with the session cookie: the loader's page, and the panic and
 *     resume buttons on it;
 *   - Caddy: GET /_auth/verify, 2xx with the cookie and 401 without it;
 *   - the command line inside the container: /_api/status|panic|resume, which
 *     asks for the root-only token file instead of a session.
 *
 * Two rules stand in front of all of it (rework 2, findings 5 and 7):
 *
 *   - the loader answers on ITS OWN hosts only. A Host it does not know is
 *     refused with 400 before anything else happens, so no cookie Domain is
 *     ever derived from a name a request supplied;
 *   - a request that CHANGES something must come from a page on the host it was
 *     sent to (Origin, or Referer) and, wherever a session exists, carry the
 *     session-bound anti-CSRF token of the form. The session cookie is ambient:
 *     lifemodel controls the root host, and a form it serves would otherwise be
 *     sent with the owner's cookie and could panic or resume the instance. The
 *     two routes without a session yet - /setup and /login - are the only ones
 *     that rest on the Origin check alone, and they say so here.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  ALLOWED_HOSTS,
  clearSessionCookie,
  createSession,
  csrfToken,
  hashPassword,
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
import type { Bootstrap, InstanceStatus } from './bootstrap.js';
import type { Clock } from './clock.js';
import { LoaderFatalError } from './errors.js';
import type { LoaderLogger } from './logger.js';
import type { LoaderState } from './state.js';
import { describe } from './state.js';
import type { Supervisor } from './supervisor.js';

/** What the command line proves itself with; root-only on the volume. */
export const CLI_TOKEN_HEADER = 'x-loader-cli-token';

export interface LoaderHttpDeps {
  state: LoaderState;
  supervisor: Supervisor;
  bootstrap: Bootstrap;
  logger: LoaderLogger;
  clock: Clock;
}

export interface LoaderHttp {
  server: Server;
  close(): Promise<void>;
}

const MAX_FORM_BYTES = 8192;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 34rem; line-height: 1.5; color: #1a1a1a; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  dt { font-weight: 600; } dd { margin: 0 0 .5rem 0; }
  form { margin-top: 1rem; } button { font: inherit; padding: .4rem .9rem; }
  input { font: inherit; padding: .4rem; width: 100%; box-sizing: border-box; }
  .note { color: #555; } .bad { color: #a00; }
</style>
</head>
<body>
<h1>lifemodel loader</h1>
${body}
</body>
</html>
`;
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
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
  const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  const form: Record<string, string> = {};
  for (const [name, value] of params) form[name] = value;
  return form;
}

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function setupPage(message?: string): string {
  return page(
    'lifemodel loader setup',
    `<h2>Set the loader's password</h2>
<p class="note">This password opens the loader, lifemodel's interface and Agent Vault. It is kept
in a file only root can read, on the volume.</p>
${message === undefined ? '' : `<p class="bad">${escapeHtml(message)}</p>`}
<form method="post" action="/setup">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="new-password" autofocus>
  <p><button type="submit">Set the password and start lifemodel</button></p>
</form>`
  );
}

function loginPage(message?: string, next?: string | null): string {
  return page(
    'lifemodel loader login',
    `<h2>Log in</h2>
${message === undefined ? '' : `<p class="bad">${escapeHtml(message)}</p>`}
<form method="post" action="/login">
${next === undefined || next === null ? '' : `  <input type="hidden" name="next" value="${escapeHtml(next)}">\n`}  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" autofocus>
  <p><button type="submit">Log in</button></p>
</form>`
  );
}

function refusalPage(reason: string): string {
  return page(
    'lifemodel loader',
    `<p class="bad">Refused: ${escapeHtml(reason)}</p><p><a href="/">Back to the loader</a></p>`
  );
}

/**
 * The loader's page. Every form on it carries the session-bound anti-CSRF
 * token, so a form served by another page of the instance (lifemodel's own
 * root host) cannot drive panic, resume or logout with the owner's cookie.
 */
function dashboardPage(status: InstanceStatus, csrf: string): string {
  const failed = status.failed;
  const state = failed ? 'failed' : status.lifemodel === 'running' ? 'running' : 'stopped';
  return page(
    'lifemodel loader',
    `<h2>lifemodel</h2>
<dl>
  <dt>state</dt><dd>${state}${failed || status.phase === 'idle' ? '' : ` (${status.phase})`}</dd>
  <dt>commit</dt><dd>${status.commit === null ? 'none' : escapeHtml(status.commit)}</dd>
  <dt>panic</dt><dd>${status.panic ? 'on' : 'off'}</dd>
  <dt>restarts</dt><dd>${String(status.restarts)}</dd>
</dl>
${status.lastError === null ? '' : `<p class="bad">failed: ${escapeHtml(status.lastError)}</p>`}
<form method="post" action="/panic"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">Panic: stop lifemodel</button></form>
<form method="post" action="/resume"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">Resume: start lifemodel</button></form>
<p class="note">Panic keeps lifemodel down across a restart of the container until you resume it.</p>
<form method="post" action="/logout"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">Log out</button></form>`
  );
}

export function createLoaderHttp(deps: LoaderHttpDeps): LoaderHttp {
  const { state, supervisor, bootstrap, logger, clock } = deps;

  /** One request header, as a string (a repeated one is not a value here). */
  function header(req: IncomingMessage, name: string): string | undefined {
    const value = req.headers[name];
    return typeof value === 'string' ? value : undefined;
  }

  /** The session this request carries, or null when it carries none that holds. */
  function sessionToken(req: IncomingMessage, record: PasswordRecord): string | null {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
    if (token === undefined) return null;
    return verifySession(token, record, clock.now()) ? token : null;
  }

  async function hasSession(req: IncomingMessage): Promise<boolean> {
    const record = await state.readAuth();
    if (record === null) return false;
    return sessionToken(req, record) !== null;
  }

  async function hasCliToken(req: IncomingMessage): Promise<boolean> {
    const expected = await state.readCliToken();
    if (expected === null) return false;
    const presented = req.headers[CLI_TOKEN_HEADER];
    return typeof presented === 'string' && sameToken(presented, expected);
  }

  /** One refused caller: what was asked, from where, and no secret in the line. */
  function refusedLogin(req: IncomingMessage): void {
    logger.warn(
      { host: req.headers.host ?? 'unknown', remote: req.socket.remoteAddress ?? 'unknown' },
      'login refused: the password does not match'
    );
  }

  /**
   * Why a state-changing request is refused, or null when it may go ahead. Both
   * halves are needed: the Origin/Referer check says WHICH PAGE sent it, the
   * token says WHICH SESSION it acts with (rework 2, finding 5).
   */
  function refusalFor(
    req: IncomingMessage,
    record: PasswordRecord | null,
    token: string | null,
    form: Record<string, string>
  ): string | null {
    if (!sameOrigin(header(req, 'origin'), header(req, 'referer'), header(req, 'host'))) {
      return 'the request did not come from a page on this host (Origin or Referer names another one)';
    }
    if (record === null || token === null) return null;
    if (!verifyCsrf(form['csrf'] ?? '', record, token)) {
      return 'the form carried no anti-CSRF token of this session';
    }
    return null;
  }

  /** One warn line for a refused state change, with the reason and no secret. */
  function refusedChange(req: IncomingMessage, reason: string): void {
    logger.warn(
      {
        host: req.headers.host ?? 'unknown',
        path: req.url ?? '',
        remote: req.socket.remoteAddress ?? 'unknown',
        reason,
      },
      `a state-changing request was refused: ${reason}`
    );
  }

  async function handleSetup(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const existing = await state.readAuth();
    if (existing !== null) {
      logger.warn(
        { host: req.headers.host ?? 'unknown' },
        'setup refused: a password is already set'
      );
      redirect(res, '/login');
      return;
    }
    if (req.method === 'GET') {
      sendHtml(res, 200, setupPage());
      return;
    }
    if (req.method !== 'POST') {
      sendText(res, 405, 'the loader takes GET or POST here');
      return;
    }
    // No session exists yet, so this is the one route that rests on the Origin
    // check alone: the page that asks for the password is the loader's own.
    const refusal = refusalFor(req, null, null, {});
    if (refusal !== null) {
      refusedChange(req, refusal);
      sendHtml(res, 403, refusalPage(refusal));
      return;
    }
    const form = await readForm(req);
    const password = form['password'] ?? '';
    if (password === '') {
      sendHtml(res, 400, setupPage('A password is needed.'));
      return;
    }
    const record = await hashPassword(password);
    await state.writeAuth(record);
    const host = req.headers.host ?? 'localhost';
    logger.info({ host }, "the loader's password is set: seeding and starting the instance");
    // The browser is answered at once; the first start takes minutes and the
    // loader's own page reports where it is - a failure among them included
    // (rework 1: it is recorded in the state, it does not end the loader).
    void bootstrap.ensureReady('setup');
    redirect(res, '/', { 'set-cookie': sessionCookie(createSession(record, clock.now()), host) });
  }

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const record = await state.readAuth();
    if (record === null) {
      redirect(res, '/setup');
      return;
    }
    if (req.method === 'GET') {
      // Where the browser was going before it was sent here; only an address
      // of this instance is kept (no open redirect).
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      sendHtml(res, 200, loginPage(undefined, vettedNext(query.get('next') ?? undefined)));
      return;
    }
    if (req.method !== 'POST') {
      sendText(res, 405, 'the loader takes GET or POST here');
      return;
    }
    // As /setup: there is no session to bind a token to yet, so the login page
    // is protected by the Origin check (and by the Host pinning above).
    const refusal = refusalFor(req, null, null, {});
    if (refusal !== null) {
      refusedChange(req, refusal);
      sendHtml(res, 403, refusalPage(refusal));
      return;
    }
    const form = await readForm(req);
    const password = form['password'] ?? '';
    const next = vettedNext(form['next']);
    if (!(await verifyPassword(password, record))) {
      refusedLogin(req);
      sendHtml(res, 401, loginPage('That password does not match.', next));
      return;
    }
    const host = req.headers.host ?? 'localhost';
    logger.info({ host }, 'the owner logged in');
    redirect(res, next ?? '/', {
      'set-cookie': sessionCookie(createSession(record, clock.now()), host),
    });
  }

  /** Not logged in: the same answer the page gives, and no state changed. */
  function notLoggedIn(res: ServerResponse): void {
    sendHtml(
      res,
      401,
      page(
        'lifemodel loader',
        '<p class="bad">Not logged in.</p><p><a href="/login">Log in</a></p>'
      )
    );
  }

  async function handleDashboard(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const record = await state.readAuth();
    const token = record === null ? null : sessionToken(req, record);
    if (record === null || token === null) {
      notLoggedIn(res);
      return;
    }
    if (req.method !== 'POST') {
      sendHtml(res, 200, dashboardPage(await bootstrap.status(), csrfToken(record, token)));
      return;
    }
    const form = await readForm(req);
    const refusal = refusalFor(req, record, token, form);
    if (refusal !== null) {
      refusedChange(req, refusal);
      sendHtml(res, 403, refusalPage(refusal));
      return;
    }
    // Only /panic and /resume act: a POST to / is not a resume alias.
    const action = (req.url ?? '').split('?')[0] === '/panic' ? 'panic' : 'resume';
    if (action === 'panic') {
      await state.setPanic('the loader page');
      const outcome = await supervisor.stop('panic');
      logger.warn(
        { drainTimedOut: outcome.drainTimedOut },
        'panic set from the loader page: lifemodel is stopped'
      );
    } else {
      await state.clearPanic();
      logger.info({}, 'panic cleared from the loader page: starting lifemodel');
      void bootstrap.ensureReady('resume');
    }
    redirect(res, '/');
  }

  async function handleLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const record = await state.readAuth();
    const token = record === null ? null : sessionToken(req, record);
    if (record === null || token === null) {
      notLoggedIn(res);
      return;
    }
    const form = await readForm(req);
    const refusal = refusalFor(req, record, token, form);
    if (refusal !== null) {
      refusedChange(req, refusal);
      sendHtml(res, 403, refusalPage(refusal));
      return;
    }
    logger.info({}, 'the owner logged out');
    redirect(res, '/login', {
      'set-cookie': clearSessionCookie(req.headers.host ?? 'localhost'),
    });
  }

  async function handleCli(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!(await hasCliToken(req))) {
      logger.warn(
        { host: req.headers.host ?? 'unknown', path: req.url ?? '' },
        'command line request refused: the loader token does not match'
      );
      sendJson(res, 403, { error: 'the loader token does not match' });
      return;
    }
    const path = (req.url ?? '').split('?')[0];
    if (path === '/_api/status') {
      sendJson(res, 200, await bootstrap.status());
      return;
    }
    if (path === '/_api/panic') {
      await state.setPanic('the command line');
      const outcome = await supervisor.stop('panic');
      logger.warn(
        { drainTimedOut: outcome.drainTimedOut },
        'panic set from the command line: lifemodel is stopped'
      );
      sendJson(res, 200, await bootstrap.status());
      return;
    }
    if (path === '/_api/resume') {
      await state.clearPanic();
      logger.info({}, 'panic cleared from the command line: starting lifemodel');
      await bootstrap.ensureReady('resume');
      sendJson(res, 200, await bootstrap.status());
      return;
    }
    sendJson(res, 404, { error: `no such loader command: ${path ?? '/'}` });
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const method = req.method ?? 'GET';

    // The loader answers on its own hosts and on nothing else (rework 2,
    // finding 7): this runs before any route, so no cookie domain and no page
    // is ever derived from a name a request supplied.
    if (!isAllowedHost(req.headers.host)) {
      logger.warn(
        { host: req.headers.host ?? 'none', path },
        'request refused: the loader does not answer on that host'
      );
      sendText(res, 400, `the loader answers only ${ALLOWED_HOSTS.join(', ')}`);
      return;
    }

    if (path === '/_auth/verify') {
      // Caddy's forward_auth: 2xx for a logged-in browser. A browser without a
      // session that is OPENING a page (GET or HEAD) is sent to the login on
      // the boot host - forward_auth passes the redirect through - so a person
      // who opens the address README names gets the password page, not a bare
      // 401 (rework 3, the stage-1 walk). Everything else without a session
      // is refused with 401: no state-changing request is ever redirected.
      if (await hasSession(req)) {
        sendText(res, 200, 'ok');
        return;
      }
      const forwardedMethod = (header(req, 'x-forwarded-method') ?? '').toUpperCase();
      const location =
        forwardedMethod === 'GET' || forwardedMethod === 'HEAD'
          ? loginLocation(
              header(req, 'x-forwarded-host') ?? '',
              header(req, 'x-forwarded-uri') ?? '/'
            )
          : null;
      if (location === null) sendText(res, 401, 'no session');
      else redirect(res, location);
      return;
    }
    if (path === '/setup') {
      await handleSetup(req, res);
      return;
    }
    if (path === '/login') {
      await handleLogin(req, res);
      return;
    }
    if (path.startsWith('/_api/')) {
      await handleCli(req, res);
      return;
    }
    if (path === '/logout') {
      if (method !== 'POST') {
        sendText(res, 405, 'logging out is a POST from the loader page');
        return;
      }
      await handleLogout(req, res);
      return;
    }
    if (path === '/') {
      if (method === 'POST') {
        // A POST to / is not a resume alias: the two actions have their own
        // addresses, and nothing else changes state (rework 2, finding 5).
        logger.warn({ path }, 'request refused: there is no action at /');
        sendText(res, 405, 'there is no action at /: panic and resume have their own addresses');
        return;
      }
      await handleDashboard(req, res);
      return;
    }
    if (path === '/panic' || path === '/resume') {
      await handleDashboard(req, res);
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
