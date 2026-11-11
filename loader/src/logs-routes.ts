/**
 * The logs page, its query routes and the retention setting's two routes
 * (ADR-016 §4, §5, L11).
 *
 * They live outside `http.ts` so the route table's file does not grow: the
 * handlers only know the log query seam, the retention setting's service, the
 * session and origin checks they are given and the page's HTML file.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LoaderConfig } from './config.js';
import { sameOrigin, verifyCsrf, type PasswordRecord } from './auth.js';
import { CSP, redirect, sendText } from './http-responses.js';
import { createLogsQuery, parseLogsPageQuery } from './logs-query.js';
import { createLogsStore } from './logs-store-adapter.js';
import { readLogsThrottle } from './logs-throttle.js';
import { createLogsStatus, type LogsStatusQuery } from './logs-status.js';
import { createLogsEvictorStatus } from './logs-evictor-status.js';
import type { LogsSettings, LogsSettingsStatus } from './logs-settings.js';
import type { RouteHandler, RouteRequest } from './route-table.js';
import type { LoaderState } from './state.js';

export interface LogsHandlerDeps {
  readonly state: LoaderState;
  readonly config: LoaderConfig;
  readonly uiRoot: string;
  readonly sessionToken: (req: IncomingMessage, record: PasswordRecord) => string | null;
  readonly hasSession: (req: IncomingMessage) => Promise<boolean>;
  /** The freshness, the store alarm and the evictor's notices (ADR-016 §4, §5). */
  readonly logsStatus?: LogsStatusQuery;
  /** The owner's retention setting (ADR-016 §5). */
  readonly logsSettings?: Pick<LogsSettings, 'status' | 'write'>;
}

/** The optional seams the loader's composition root passes in (ADR-016 §4, §5). */
export type LogsStatusDep = Pick<LogsHandlerDeps, 'logsStatus' | 'logsSettings'>;

export interface LogsHandlers {
  readonly logsPage: RouteHandler;
  readonly logsQuery: RouteHandler;
  readonly logsModules: RouteHandler;
  readonly logsSettingsRead: RouteHandler;
  readonly logsSettingsWrite: RouteHandler;
}

/** The largest body the two numbers can arrive in; the loader's other writes use 8 KiB. */
const MAX_SETTINGS_BODY_BYTES = 8192;

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

export function createLogsHandlers(deps: LogsHandlerDeps): LogsHandlers {
  const store = createLogsStore({ url: deps.config.logsStoreUrl });
  const logs = createLogsQuery({ store });
  const status =
    deps.logsStatus ??
    createLogsStatus({
      store,
      evictor: createLogsEvictorStatus(),
      now: Date.now,
    });

  async function logsPage({ req, res }: RouteRequest): Promise<void> {
    const record = await deps.state.readAuth();
    const token = record === null ? null : deps.sessionToken(req, record);
    if (token === null) {
      redirect(res, `/login?next=${encodeURIComponent('/logs')}`);
      return;
    }
    try {
      const bytes = await readFile(resolve(deps.uiRoot, 'logs.html'));
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
  }

  async function logsQuery({ req, res }: RouteRequest): Promise<void> {
    if (!(await deps.hasSession(req))) {
      res.writeHead(403);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parsed = parseLogsPageQuery(url.searchParams);
    if (parsed.state === 'invalid') {
      sendJson(res, 400, {
        state: 'invalid',
        reason: 'filter',
        field: parsed.field,
      });
      return;
    }
    const result = await logs.page(parsed.request);
    if (result.state !== 'ok') {
      sendJson(res, 503, result);
      return;
    }
    // Counter windows belong to the first page only; paging reuses that
    // snapshot instead of repeating the same bounded store read.
    const throttle =
      parsed.request.offset === 0
        ? { throttle: await readLogsThrottle(store, parsed.request.filter, result.records) }
        : {};
    if (url.searchParams.get('status') !== '1') {
      sendJson(res, 200, { ...result, ...throttle });
      return;
    }
    const window = parsed.request.filter;
    sendJson(res, 200, {
      ...result,
      status: await status.read({ from: window.from, to: window.to }),
      ...throttle,
    });
  }

  async function logsModules({ req, res }: RouteRequest): Promise<void> {
    if (!(await deps.hasSession(req))) {
      res.writeHead(403);
      res.end();
      return;
    }
    const result = await logs.modules();
    sendJson(res, result.state === 'ok' ? 200 : 503, result);
  }

  function unavailable(res: ServerResponse, reason: string): void {
    sendJson(res, 503, { state: 'unavailable', reason });
  }

  async function logsSettingsRead({ req, res }: RouteRequest): Promise<void> {
    if (!(await deps.hasSession(req))) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      if (deps.logsSettings === undefined) throw new Error('no settings service');
      const status: LogsSettingsStatus = await deps.logsSettings.status();
      sendJson(res, 200, { state: 'ok', ...status });
    } catch {
      unavailable(res, 'unavailable');
    }
  }

  async function logsSettingsWrite({ req, res }: RouteRequest): Promise<void> {
    const record = await deps.state.readAuth();
    const session = record === null ? null : deps.sessionToken(req, record);
    if (record === null || session === null) {
      res.writeHead(401);
      res.end();
      return;
    }
    // The exact Origin the loader's other writes demand, and the CSRF token
    // that may only be sent from it (L11).
    if (
      !sameOrigin(header(req, 'origin'), undefined, `boot-${deps.config.instanceName}.local`) ||
      !verifyCsrf(header(req, 'x-csrf-token') ?? '', record, session)
    ) {
      sendJson(res, 403, { state: 'refused', reason: 'origin_or_csrf' });
      return;
    }
    if (header(req, 'content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      sendJson(res, 415, { state: 'refused', reason: 'content_type' });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += part.length;
      if (size > MAX_SETTINGS_BODY_BYTES) break;
      chunks.push(Buffer.from(part));
    }
    if (size > MAX_SETTINGS_BODY_BYTES) {
      res.writeHead(413);
      res.end();
      return;
    }
    let input: unknown;
    try {
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      sendJson(res, 400, { state: 'invalid', field: 'body' });
      return;
    }
    if (deps.logsSettings === undefined) {
      unavailable(res, 'unavailable');
      return;
    }
    const result = await deps.logsSettings.write(input);
    if (result.state === 'ok') {
      sendJson(res, 200, { state: 'ok', ...result.status });
      return;
    }
    if (result.state === 'invalid') {
      sendJson(res, 400, { state: 'invalid', field: result.field });
      return;
    }
    if (result.state === 'above_volume') {
      // The refusal carries both numbers: what was asked, and the largest bound
      // this volume can ever reach (ADR-016 §5).
      sendJson(res, 400, {
        state: 'refused',
        reason: 'above_volume',
        maxBytes: result.maxBytes,
        largestMaxBytes: result.largestMaxBytes,
        volumeBytes: result.volumeBytes,
        evictorThresholdBytes: result.evictorThresholdBytes,
      });
      return;
    }
    unavailable(res, result.state);
  }

  return {
    logsPage,
    logsQuery,
    logsModules,
    logsSettingsRead,
    logsSettingsWrite,
  };
}
