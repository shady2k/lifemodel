/**
 * The platform storage module (ADR-015 S-D1). This build answers health and
 * serves its TLS task listener: the status listener reports whether the
 * module's catalog and SeaweedFS answer, and the task listener is where task
 * requests arrive once 653.7.2 adds their authorization.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createSecureServer, type Server as SecureServer } from 'node:https';
import type { LoaderLogger } from './logger.js';
import type { Catalog } from './storage-catalog.js';
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
  return { status, health, task: createTaskListener(options.tls, options.logger) };
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
  logger: LoaderLogger
): StorageTaskListener {
  const { set: schedule, clear: cancel } = options.timers ?? {
    set: setTimeout,
    clear: clearTimeout,
  };
  const reloadMs = options.reloadMs ?? STORAGE_TASK_TLS_DEFAULTS.reloadMs;
  let cert = options.cert;
  const server = createSecureServer({ cert, key: options.key }, (req, res) => {
    if (req.method !== 'GET' || req.url !== STORAGE_TASK_PATHS.ping) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify({ state: 'ok' }));
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
      if (next.cert !== cert) {
        server.setSecureContext({ cert: next.cert, key: next.key });
        cert = next.cert;
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

  scheduleNext();
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
