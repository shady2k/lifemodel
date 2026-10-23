/** One process boot owns its PUTs until transport and publication have settled.
 * Database wall time decides cross-process freshness. Local monotonic time only
 * makes this process fail closed well before another process may reclaim it. */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { storageMaintenanceFence } from './storage-maintenance.js';
import { withStorageSqlClient, storageSqlCompletion } from './storage-control-work.js';
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
  /** Local monotonic safety clock; never used to decide database staleness. */
  now?: () => number;
}): StorageUploadOwner {
  const now = options.now ?? (() => performance.now());
  let bootId = randomUUID();
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
  let controller = new AbortController();
  let initialized = false;
  let failed = false;
  let closed = false;
  let lastRenewalStart = Infinity;
  let renewal: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let initialization: Promise<void> | undefined;
  let pendingRenewal: Promise<void> | undefined;
  let recovery: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const unavailable = () => new StorageAccessError(503, 'upload_owner_unavailable');

  function fail(): void {
    failed = true;
    if (renewal) clearTimeout(renewal);
    if (watchdog) clearTimeout(watchdog);
    controller.abort();
  }
  function check(): void {
    if (now() - lastRenewalStart >= FAIL_CLOSED_MS) fail();
    if (closed || failed) throw unavailable();
  }
  function armWatchdog(): void {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(fail, Math.max(1, FAIL_CLOSED_MS - (now() - lastRenewalStart)));
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
    const started = now();
    try {
      check();
      // UPDATE takes the same owner row lock as begin and reclamation. A stale
      // row can never be revived, even after a long outage or a lock wait.
      let renewed = false;
      let held = false;
      await withStorageSqlClient(
        pool,
        options.connectionString,
        undefined,
        async (client, retire) => {
          try {
            await client.query('BEGIN');
            if (!(await storageMaintenanceFence(client, false))) {
              held = true;
              await storageSqlCompletion(client, 'COMMIT', retire);
              return;
            }
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
            await storageSqlCompletion(client, 'COMMIT', retire);
          } catch (error) {
            await storageSqlCompletion(client, 'ROLLBACK', retire).catch(() => undefined);
            throw error;
          }
        }
      );
      if (held) return;
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
      if (now() - lastRenewalStart >= FAIL_CLOSED_MS) fail();
    } finally {
      scheduleRenewal();
    }
  }
  async function initialize(): Promise<void> {
    const started = now();
    lastRenewalStart = started;
    armWatchdog();
    try {
      let writable = false;
      await withStorageSqlClient(
        pool,
        options.connectionString,
        undefined,
        async (client, retire) => {
          try {
            await client.query('BEGIN');
            writable = await storageMaintenanceFence(client, false);
            if (writable)
              await client.query(
                'INSERT INTO storage.upload_owners(boot_id,heartbeat_at) VALUES($1,clock_timestamp())',
                [bootId]
              );
            await storageSqlCompletion(client, 'COMMIT', retire);
          } catch (error) {
            await storageSqlCompletion(client, 'ROLLBACK', retire).catch(() => undefined);
            throw error;
          }
        }
      );
      if (!writable) return;
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
  async function recover(): Promise<void> {
    // No old boot write may overlap replacement. In particular, a pending
    // initialization can still insert a fresh row after the local abort.
    await Promise.allSettled([initialization, pendingRenewal]);
    if (closed) throw unavailable();
    await withStorageSqlClient(
      pool,
      options.connectionString,
      undefined,
      async (client, retire) => {
        try {
          await client.query('BEGIN');
          await client.query(
            'SELECT boot_id FROM storage.upload_owners WHERE boot_id=$1 FOR UPDATE',
            [bootId]
          );
          // Use the retirement predicate AFTER obtaining its same row lock. Local
          // elapsed time cannot prove that a cross-process heartbeat has expired.
          const result = await client.query<{ fresh: boolean }>(
            `SELECT heartbeat_at>clock_timestamp()-interval '60 seconds' AS fresh
           FROM storage.upload_owners WHERE boot_id=$1`,
            [bootId]
          );
          if (result.rows[0]?.fresh) throw unavailable();
          await storageSqlCompletion(client, 'COMMIT', retire);
        } catch (error) {
          await storageSqlCompletion(client, 'ROLLBACK', retire).catch(() => undefined);
          throw error;
        }
      }
    );
    if (closed) throw unavailable();
    // The old identity is never revived. Its attempts retain their aborted
    // signal and remain subject to the durable staleness rule during cleanup.
    bootId = randomUUID();
    controller = new AbortController();
    initialized = false;
    failed = false;
    lastRenewalStart = Infinity;
    initialization = undefined;
    pendingRenewal = undefined;
    initialization = initialize();
    await initialization;
  }
  return {
    get bootId() {
      return bootId;
    },
    isLive: (attemptId) => live.has(attemptId),
    ready: async () => {
      if (closed) throw unavailable();
      // Held service still serves reads and readiness. No heartbeat or recovery
      // write is needed until admission reopens; register/assertActive still
      // enforce the existing boot freshness rules for actual transfers.
      const maintenance = await pool.query<{ state: string }>(
        'SELECT state FROM storage.maintenance WHERE id=true'
      );
      if (!maintenance.rows[0]) throw unavailable();
      if (maintenance.rows[0].state !== 'normal') return;
      if (now() - lastRenewalStart >= FAIL_CLOSED_MS) fail();
      if (failed || recovery) {
        recovery ??= recover()
          .catch(() => {
            throw unavailable();
          })
          .finally(() => {
            recovery = undefined;
          });
        await recovery;
      } else {
        initialization ??= initialize();
        await initialization;
        if (!initialized) initialization = undefined;
      }
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
        await Promise.allSettled([initialization, pendingRenewal, recovery]);
        // Leave the last heartbeat durable. It will age out; deleting it here
        // would let a foreign GC retire still-settling canceled transports.
        await pool.end();
      })();
      return closing;
    },
  };
}
