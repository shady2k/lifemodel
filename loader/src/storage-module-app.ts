/**
 * The platform storage module (ADR-015 S-D1). This build answers health only:
 * its own status listener reports whether SeaweedFS answers with valid auth.
 * The task, control and owner-read listeners arrive with their stages.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { LoaderLogger } from './logger.js';
import {
  createStorageHealth,
  type StorageHealth,
  type StorageHealthOptions,
  type StoreCheck,
} from './storage-health.js';
import { StorageCustodyError, type StorageS3Credentials } from './storage-custody.js';
import type { S3Check } from './storage-s3.js';

export interface StorageModuleOptions {
  bucket: string;
  /** The custody record, in memory only; a failure here is a failed module. */
  custody: { read(): Promise<StorageS3Credentials> };
  /** One authenticated check of the store; the signal ends a check past its deadline. */
  check(credentials: StorageS3Credentials, signal: AbortSignal): Promise<S3Check>;
  logger: LoaderLogger;
  now?: () => number;
  health?: { cacheMs?: number; boundMs?: number };
  timers?: { set: typeof setTimeout; clear: typeof clearTimeout };
}

export interface StorageModule {
  status: Server;
  health: StorageHealth;
}

export const STORAGE_MODULE_PATHS = { status: '/status', livez: '/livez' } as const;

export function createStorageModule(options: StorageModuleOptions): StorageModule {
  let custodyCode: string | null = null;

  async function checkStore(signal: AbortSignal): Promise<StoreCheck> {
    let credentials: StorageS3Credentials;
    try {
      // A deadline that has already passed is not worth a Bao read.
      if (signal.aborted) return { ok: false, code: 'unreachable' };
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
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
    if (req.url === STORAGE_MODULE_PATHS.livez) {
      res.writeHead(200, headers);
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
    res.writeHead(result.status, headers);
    res.end(JSON.stringify(result.body));
  }

  const status = createServer((req, res) => {
    void answer(req, res);
  });
  return { status, health };
}
