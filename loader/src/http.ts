/** Authenticated HTTP interface for the platform bootstrap loader. */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ALLOWED_HOSTS,
  clearSessionCookie,
  createHandoff,
  verifyHandoff,
  HANDOFF_TTL_MS,
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
  const { state, logger, clock } = deps;
  const usedTickets = new Map<string, number>();
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
  function handoffRedirect(
    record: PasswordRecord,
    session: string,
    next: string,
    currentHost: string
  ): string {
    const target = new URL(next);
    const path = `${target.pathname}${target.search}${target.hash}`;
    if (target.host === currentHost) return next;
    const ticket = createHandoff(record, {
      target: target.host,
      session,
      next: path,
      expires: clock.now() + HANDOFF_TTL_MS,
    });
    return `${target.origin}/_auth/handoff?ticket=${encodeURIComponent(ticket)}&next=${encodeURIComponent(path)}`;
  }
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const method = req.method ?? 'GET';
    const serviceVerify =
      path === '/_auth/verify' &&
      hostName(req.headers.host ?? '') === 'loader.lifemodel-system.svc.cluster.local';
    if (!serviceVerify && !isAllowedHost(req.headers.host)) {
      sendText(res, 400, `the loader answers only ${ALLOWED_HOSTS.join(', ')}`);
      return;
    }
    if (path === '/_auth/handoff') {
      const host = req.headers.host ?? '';
      const url = new URL(req.url ?? '/', `http://${host}`);
      const ticketText = url.searchParams.get('ticket') ?? '';
      const record = await state.readAuth();
      const ticket = record === null ? null : verifyHandoff(ticketText, record, clock.now());
      const nextParam = url.searchParams.get('next');
      const next =
        nextParam?.startsWith('/') && !nextParam.startsWith('//')
          ? vettedNext(`http://${host}${nextParam}`, host)
          : null;
      const boot = `http://boot.localhost/login`;
      const ticketId = ticketText;
      for (const [id, expiry] of usedTickets) if (expiry <= clock.now()) usedTickets.delete(id);
      if (
        ticket === null ||
        next === null ||
        ticket.target !== host.toLowerCase() ||
        ticket.next !== `${new URL(next).pathname}${new URL(next).search}` ||
        usedTickets.has(ticketId)
      ) {
        redirect(res, boot);
        return;
      }
      usedTickets.set(ticketId, ticket.expires);
      redirect(res, ticket.next, { 'set-cookie': sessionCookie(ticket.session, host) });
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
      await state.writeAuth(record);
      logger.info({}, "the loader's password is set: platform authentication is ready");
      const host = req.headers.host ?? 'localhost';
      const token = createSession(record, clock.now());
      const next = vettedNext(setupForm['next'], host);
      redirect(res, next === null ? '/' : handoffRedirect(record, token, next, host), {
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
            next === null ? '/' : handoffRedirect(record, active, next, header(req, 'host') ?? '')
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
      const host = req.headers.host ?? 'localhost';
      logger.info({ host }, 'the owner logged in');
      const token = createSession(record, clock.now());
      redirect(res, next === null ? '/' : handoffRedirect(record, token, next, host), {
        'set-cookie': sessionCookie(token, host),
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
      record.sessionSecret = randomBytes(32).toString('base64');
      await state.writeAuth(record);
      logger.info({}, 'the owner logged out');
      redirect(res, '/login', {
        'set-cookie': clearSessionCookie(req.headers.host ?? 'localhost'),
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
