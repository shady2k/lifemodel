/** One process boot owns its PUTs until transport and publication have settled.
 * Database wall time decides cross-process freshness. Local monotonic time only
 * makes this process fail closed well before another process may reclaim it. */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { StorageAccessError } from './storage-access-error.js';

export const STORAGE_UPLOAD_OWNER_STALE_MS = 60_000;
const RENEW_MS = 5_000;
const FAIL_CLOSED_MS = 30_000;
const QUERY_MS = 5_000;

export interface StorageUploadOwner {
  readonly bootId: string;
  isLive(attemptId: string): boolean;
  ready(): Promise<void>;
  /** Check the monotonic safety deadline before synchronous transport dispatch. */
  assertActive(): void;
  /** Synchronous registration must precede the begin_attempt publication. */
  register(attemptId: string): AbortSignal;
  /** Call only after the transport and all publication/cleanup have settled. */
  unregister(attemptId: string): void;
  close(): Promise<void>;
}

export function createStorageUploadOwner(options: {
  connectionString: string;
}): StorageUploadOwner {
  const bootId = randomUUID();
  const pool = new Pool({
    connectionString: options.connectionString,
    max: 1,
    connectionTimeoutMillis: QUERY_MS,
    query_timeout: QUERY_MS,
    statement_timeout: QUERY_MS,
    idleTimeoutMillis: 10_000,
    application_name: 'lifemodel-storage-upload-owner',
  });
  pool.on('error', () => undefined);
  pool.on('connect', (client) => client.on('error', () => undefined));
  const live = new Set<string>();
  const controller = new AbortController();
  let initialized = false;
  let failed = false;
  let closed = false;
  let lastRenewalStart = Infinity;
  let renewal: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let initialization: Promise<void> | undefined;
  let pendingRenewal: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const unavailable = () => new StorageAccessError(503, 'upload_owner_unavailable');

  function fail(): void {
    failed = true;
    if (renewal) clearTimeout(renewal);
    if (watchdog) clearTimeout(watchdog);
    controller.abort();
  }
  function check(): void {
    if (performance.now() - lastRenewalStart >= FAIL_CLOSED_MS) fail();
    if (closed || failed) throw unavailable();
  }
  function armWatchdog(): void {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(
      fail,
      Math.max(1, FAIL_CLOSED_MS - (performance.now() - lastRenewalStart))
    );
    watchdog.unref();
  }
  function scheduleRenewal(): void {
    if (closed || failed) return;
    renewal = setTimeout(() => {
      pendingRenewal = renew();
    }, RENEW_MS);
    renewal.unref();
  }
  async function renew(): Promise<void> {
    const started = performance.now();
    try {
      check();
      // UPDATE takes the same owner row lock as begin and reclamation. A stale
      // row can never be revived, even after a long outage or a lock wait.
      const client = await pool.connect();
      let renewed = false;
      try {
        await client.query('BEGIN');
        await client.query(
          'SELECT boot_id FROM storage.upload_owners WHERE boot_id=$1 FOR UPDATE',
          [bootId]
        );
        check();
        // Test freshness AFTER obtaining the row lock. A predicate evaluated
        // before a lock wait could otherwise resurrect a boot that just expired.
        const result = await client.query(
          `UPDATE storage.upload_owners SET heartbeat_at=clock_timestamp()
           WHERE boot_id=$1 AND heartbeat_at>clock_timestamp()-interval '60 seconds'
           RETURNING boot_id`,
          [bootId]
        );
        renewed = result.rowCount === 1;
        check();
        await client.query('COMMIT');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          client.release(true);
          throw error;
        }
        client.release();
        throw error;
      }
      client.release();
      check();
      if (!renewed) {
        fail();
        return;
      }
      // Count from dispatch, not response: a slow SQL reply must not extend the
      // local safety deadline beyond the database heartbeat it acknowledges.
      lastRenewalStart = started;
      armWatchdog();
    } catch {
      // Retry only while the local deadline still leaves a full safety margin.
      if (performance.now() - lastRenewalStart >= FAIL_CLOSED_MS) fail();
    } finally {
      scheduleRenewal();
    }
  }
  async function initialize(): Promise<void> {
    const started = performance.now();
    lastRenewalStart = started;
    armWatchdog();
    try {
      await pool.query(
        'INSERT INTO storage.upload_owners(boot_id,heartbeat_at) VALUES($1,clock_timestamp())',
        [bootId]
      );
      check();
      initialized = true;
      lastRenewalStart = started;
      armWatchdog();
      scheduleRenewal();
    } catch {
      fail();
      throw unavailable();
    }
  }
  return {
    bootId,
    isLive: (attemptId) => live.has(attemptId),
    ready: async () => {
      check();
      initialization ??= initialize();
      await initialization;
      check();
    },
    assertActive: check,
    register: (attemptId) => {
      check();
      if (!initialized || live.has(attemptId)) throw unavailable();
      live.add(attemptId);
      return controller.signal;
    },
    unregister: (attemptId) => {
      live.delete(attemptId);
    },
    close: () => {
      closing ??= (async () => {
        closed = true;
        fail();
        await Promise.allSettled([initialization, pendingRenewal]);
        // Leave the last heartbeat durable. It will age out; deleting it here
        // would let a foreign GC retire still-settling canceled transports.
        await pool.end();
      })();
      return closing;
    },
  };
}
