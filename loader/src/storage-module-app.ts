/**
 * The platform storage module (ADR-015 S-D1). This build answers health and
 * serves separate TLS task/control/read listeners. The status listener checks
 * the catalog, authorization schema and SeaweedFS. Every operation independently
 * verifies a live Kubernetes identity; no core-process call is an authority.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createSecureServer, type Server as SecureServer } from 'node:https';
import type { LoaderLogger } from './logger.js';
import type { Catalog } from './storage-catalog.js';
import { STORAGE_AUDIENCES, StorageAccessError, type StorageAccess } from './storage-access.js';
import {
  createStorageHealth,
  type StorageHealth,
  type StorageHealthOptions,
  type StoreCheck,
} from './storage-health.js';
import { StorageCustodyError, type StorageS3Credentials } from './storage-custody.js';
import type { S3Check } from './storage-s3.js';

/** The mounted instance-CA leaf: read at start, then re-read on every reload. */
export interface StorageTaskTlsOptions {
  cert: string;
  key: string;
  /** The mounted Secret, re-read by each reload; a failure keeps the last certificate. */
  read(): Promise<{ cert: string; key: string }>;
  reloadMs?: number;
  timers?: { set: typeof setTimeout; clear: typeof clearTimeout };
}

export interface StorageTaskListener {
  server: SecureServer;
  /** Re-read the certificate and use it for the next handshake. */
  reload(): Promise<void>;
  close(): void;
}

export interface StorageModuleOptions {
  bucket: string;
  /** Required authority: readiness and every data operation fail closed. */
  access: StorageAccess;
  /** The module's own catalog; readiness needs it, as it needs the store. */
  catalog: Catalog;
  /** The custody record, in memory only; a failure here is a failed module. */
  custody: { read(): Promise<StorageS3Credentials> };
  /** One authenticated check of the store; the signal ends a check past its deadline. */
  check(credentials: StorageS3Credentials, signal: AbortSignal): Promise<S3Check>;
  logger: LoaderLogger;
  /** The task listener's server certificate: an instance-CA leaf, never a key of its own. */
  tls: StorageTaskTlsOptions;
  now?: () => number;
  health?: { cacheMs?: number; boundMs?: number };
  timers?: { set: typeof setTimeout; clear: typeof clearTimeout };
}

export interface StorageModule {
  status: Server;
  task: StorageTaskListener;
  control: StorageTaskListener;
  read: StorageTaskListener;
  health: StorageHealth;
}

export const STORAGE_MODULE_PATHS = { status: '/status', livez: '/livez' } as const;
/** What the task listener answers before it carries an API: a health-like ping. */
export const STORAGE_TASK_PATHS = { ping: '/ping' } as const;
/** The mounted Secret is re-read once a minute: renewal lands without a restart. */
export const STORAGE_TASK_TLS_DEFAULTS = { reloadMs: 60_000 } as const;

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

export function createStorageModule(options: StorageModuleOptions): StorageModule {
  let custodyCode: string | null = null;

  /**
   * The catalog first: a module that cannot read its own catalog cannot serve a
   * request, whatever the store says, and the read is the cheaper of the two.
   * The repair travels as the check's `cause`, so the health machine logs one
   * line per change - with the cause, and never with a body.
   */
  async function checkCatalog(signal: AbortSignal): Promise<StoreCheck> {
    if (signal.aborted) return { ok: false, code: 'timeout' };
    const result = await options.catalog.check(signal);
    if (result.ok) return { ok: true };
    return { ok: false, code: 'catalog_unavailable', cause: result.cause };
  }

  async function checkStore(signal: AbortSignal): Promise<StoreCheck> {
    // A deadline that has already passed is not worth a Bao read.
    if (signal.aborted) return { ok: false, code: 'timeout' };
    const catalog = await checkCatalog(signal);
    if (!catalog.ok) return catalog;
    if (!(await options.access.check(signal)))
      return { ok: false, code: 'catalog_unavailable', cause: 'authorization_unavailable' };
    let credentials: StorageS3Credentials;
    try {
      credentials = await options.custody.read();
    } catch (error) {
      const code = error instanceof StorageCustodyError ? error.code : 'unreachable';
      // The reason is logged once per change; the credential itself never is.
      if (code !== custodyCode) {
        custodyCode = code;
        options.logger.warn(
          { code },
          'The storage module cannot read its SeaweedFS custody record'
        );
      }
      return { ok: false, code: 'credentials_unavailable' };
    }
    custodyCode = null;
    return options.check(credentials, signal);
  }

  const healthOptions: StorageHealthOptions = {
    bucket: options.bucket,
    check: checkStore,
    logger: options.logger,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.health?.cacheMs === undefined ? {} : { cacheMs: options.health.cacheMs }),
    ...(options.health?.boundMs === undefined ? {} : { boundMs: options.health.boundMs }),
    ...(options.timers === undefined ? {} : { timers: options.timers }),
  };
  const health = createStorageHealth(healthOptions);

  async function answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.url === STORAGE_MODULE_PATHS.livez) {
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({ state: 'live' }));
      return;
    }
    if (req.url !== STORAGE_MODULE_PATHS.status) {
      res.writeHead(404);
      res.end();
      return;
    }
    const result = await health.evaluate();
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(result.status, JSON_HEADERS);
    res.end(JSON.stringify(result.body));
  }

  const status = createServer((req, res) => {
    void answer(req, res);
  });
  const serve =
    (role: 'task' | 'control' | 'read') =>
    async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      req.on('error', () => undefined);
      res.on('error', () => undefined);
      try {
        if (role === 'task' && req.method === 'GET' && req.url === STORAGE_TASK_PATHS.ping) {
          res.writeHead(200, JSON_HEADERS);
          res.end(JSON.stringify({ state: 'ok' }));
          return;
        }
        const match = /^\/spaces\/([a-z0-9][a-z0-9_-]{0,63})\/access$/.exec(req.url ?? '');
        if (
          !(
            (role === 'task' && req.method === 'GET' && match) ||
            (role === 'control' && req.method === 'POST' && req.url === '/revoke') ||
            (role === 'read' && req.method === 'GET' && req.url === '/identity')
          )
        ) {
          res.writeHead(404);
          res.end();
          return;
        }
        const access = options.access;
        const authHeaders = req.rawHeaders.filter(
          (_, index) => index % 2 === 0 && req.rawHeaders[index]?.toLowerCase() === 'authorization'
        );
        const header = req.headers.authorization;
        if (
          authHeaders.length !== 1 ||
          typeof header !== 'string' ||
          !/^Bearer [^\s]+$/.test(header)
        )
          throw new StorageAccessError(403, 'identity_denied');
        const token = header.slice(7);
        const control = new AbortController();
        const disconnected = (): void => {
          if (!res.writableEnded) control.abort();
        };
        res.on('close', disconnected);
        const signal = AbortSignal.any([control.signal, AbortSignal.timeout(10_000)]);
        try {
          let result: unknown;
          if (role === 'task' && match?.[1]) {
            const stream = access.openTaskStream({ token, space: match[1], signal });
            try {
              await stream.chunk(0, (decision) => {
                result = decision;
              });
            } finally {
              stream.close();
            }
          } else {
            const identity = await access.identity.verify(token, STORAGE_AUDIENCES[role], signal);
            if (role === 'read') result = { role: identity.role };
            else {
              let size = 0;
              const chunks: Buffer[] = [];
              for await (const part of req) {
                signal.throwIfAborted();
                const chunk = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
                size += chunk.length;
                if (size > 4096) throw new StorageAccessError(413, 'request_too_large');
                chunks.push(chunk);
              }
              let value: unknown;
              try {
                value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              } catch {
                throw new StorageAccessError(400, 'invalid_request');
              }
              if (value === null || typeof value !== 'object' || Array.isArray(value))
                throw new StorageAccessError(400, 'invalid_request');
              const input = value as Record<string, unknown>;
              if (
                Object.keys(input).length !== 3 ||
                typeof input['space'] !== 'string' ||
                typeof input['expectedRevision'] !== 'string' ||
                typeof input['effectKey'] !== 'string'
              )
                throw new StorageAccessError(400, 'invalid_request');
              result = await access.revoke(
                input['space'],
                input['expectedRevision'],
                input['effectKey']
              );
            }
          }
          if (!res.destroyed && !res.writableEnded) {
            res.writeHead(200, JSON_HEADERS);
            res.end(JSON.stringify(result));
          }
        } finally {
          res.removeListener('close', disconnected);
        }
      } catch (error) {
        const failure =
          error instanceof StorageAccessError
            ? error
            : new StorageAccessError(503, 'access_unavailable');
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(failure.status, JSON_HEADERS);
          res.end(JSON.stringify({ error: { id: failure.id, code: failure.code } }));
        }
      }
    };
  return {
    status,
    health,
    task: createTaskListener(options.tls, options.logger, serve('task')),
    control: createTaskListener(options.tls, options.logger, serve('control')),
    read: createTaskListener(options.tls, options.logger, serve('read')),
  };
}

/**
 * The TLS task listener. Its certificate is the loader's instance-CA leaf for
 * this module's DNS names, mounted from the Secret the loader alone writes; the
 * reload replaces the context for the next handshake, so a renewed leaf reaches
 * the module without a restart. Requests travel only over TLS: there is no
 * plain listener for the task port.
 */
function createTaskListener(
  options: StorageTaskTlsOptions,
  logger: LoaderLogger,
  answer: (req: IncomingMessage, res: ServerResponse) => Promise<void>
): StorageTaskListener {
  const { set: schedule, clear: cancel } = options.timers ?? {
    set: setTimeout,
    clear: clearTimeout,
  };
  const reloadMs = options.reloadMs ?? STORAGE_TASK_TLS_DEFAULTS.reloadMs;
  let cert = options.cert;
  let key = options.key;
  const server = createSecureServer({ cert, key }, (req, res) => {
    void answer(req, res);
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.on('connection', (socket) => {
    socket.on('error', () => undefined);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let failed = false;
  let reloading = false;

  async function reload(): Promise<void> {
    if (reloading) return;
    reloading = true;
    try {
      const next = await options.read();
      // Both halves are replaced together; either changing means a new context.
      if (next.cert !== cert || next.key !== key) {
        server.setSecureContext({ cert: next.cert, key: next.key });
        cert = next.cert;
        key = next.key;
        // A rotation is an event, not the absence of one.
        logger.info(
          { code: 'task_certificate_reloaded' },
          'The storage module reloaded its certificate'
        );
      }
      failed = false;
    } catch {
      // The previous context stays in use: a failed read is not a lost certificate.
      if (!failed)
        logger.warn(
          { code: 'task_certificate_unreadable' },
          'The storage module could not re-read its certificate'
        );
      failed = true;
    } finally {
      reloading = false;
    }
  }

  function scheduleNext(): void {
    if (stopped) return;
    timer = schedule(() => {
      void reload().then(() => {
        scheduleNext();
      });
    }, reloadMs);
  }

  server.once('listening', scheduleNext);
  return {
    server,
    reload,
    close: () => {
      stopped = true;
      if (timer !== undefined) cancel(timer);
      if (!server.listening) return;
      server.closeAllConnections();
      server.close();
    },
  };
}
