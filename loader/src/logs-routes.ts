/**
 * The logs page and its two API routes (ADR-016 §4, L11).
 *
 * They live outside `http.ts` so the route table's file does not grow: the
 * handlers only know the log query seam, the session check they are given and
 * the page's HTML file.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LoaderConfig } from './config.js';
import type { PasswordRecord } from './auth.js';
import { CSP, redirect, sendText } from './http-responses.js';
import { createLogsQuery, parseLogsPageQuery } from './logs-query.js';
import { createLogsStore } from './logs-store-adapter.js';
import type { RouteHandler, RouteRequest } from './route-table.js';
import type { LoaderState } from './state.js';

export interface LogsHandlerDeps {
  readonly state: LoaderState;
  readonly config: LoaderConfig;
  readonly uiRoot: string;
  readonly sessionToken: (req: IncomingMessage, record: PasswordRecord) => string | null;
  readonly hasSession: (req: IncomingMessage) => Promise<boolean>;
}

export interface LogsHandlers {
  readonly logsPage: RouteHandler;
  readonly logsQuery: RouteHandler;
  readonly logsModules: RouteHandler;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

export function createLogsHandlers(deps: LogsHandlerDeps): LogsHandlers {
  const logs = createLogsQuery({ store: createLogsStore({ url: deps.config.logsStoreUrl }) });

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
      sendJson(res, 400, { state: 'invalid', reason: 'filter', field: parsed.field });
      return;
    }
    const result = await logs.page(parsed.request);
    sendJson(res, result.state === 'ok' ? 200 : 503, result);
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

  return { logsPage, logsQuery, logsModules };
}
