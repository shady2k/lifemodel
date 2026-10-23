/** Short complete-mediation guard for trusted storage adapters. No reusable permit
 * escapes. Chunk callbacks dispatch synchronously only: never schedule deferred
 * work with the decision. Await socket drain/S3 outside this guard and reenter
 * for every next chunk. Untrusted code never supplies a callback or SQL. */
import { Pool, type PoolClient } from 'pg';
import { storageSqlCompletion, withStorageSqlClient } from './storage-control-work.js';
import { randomUUID } from 'node:crypto';
import { storageMaintenanceFence } from './storage-maintenance.js';
import { StorageAccessError } from './storage-access-error.js';
import { STORAGE_AUDIENCES, type KubernetesStorageIdentity } from './storage-identity.js';
export { STORAGE_AUDIENCES } from './storage-identity.js';
export { StorageAccessError } from './storage-access-error.js';

export interface StorageDecision {
  space: string;
  revision: string;
  mode: 'active' | 'wrapping' | 'open' | 'frozen' | 'sealed' | 'revoked';
}
export interface RevokeReceipt {
  id: string;
  space: string;
  revision: string;
  effectKey: string;
}
export interface StorageTaskStream {
  signal: AbortSignal;
  /** Dispatch ONE bounded chunk synchronously. Never await drain under this guard. */
  chunk(bytes: number, dispatch: (decision: StorageDecision) => undefined): Promise<void>;
  /** Trusted module SQL only, never caller-provided SQL. Executes one parameterized
   * metadata statement under fresh authority + revision locks. Resolves after COMMIT.
   * .7.5 uses this for publication/mark; private S3 transfer stays outside the lock. */
  publish(statement: StorageMetadataStatement): Promise<StoragePublicationResult>;
  close(): void | Promise<void>;
}
export interface StoragePublicationResult {
  rows: Record<string, unknown>[];
}
export interface StorageMetadataStatement {
  text: string;
  values: unknown[];
}
export interface StorageAccessOptions {
  connectionString: string;
  identity: KubernetesStorageIdentity;
  timeoutMs?: number;
  /** Task guard SQL capacity (default eight, configurable up to ten).
   * The two control guards always use their own independent pool. */
  poolMax?: number;
}
export interface StorageAccess {
  identity: KubernetesStorageIdentity;
  openTaskStream(input: {
    token: string;
    space: string;
    signal?: AbortSignal;
    /** Writer/publication streams participate in normal-end quiescence. Defaults to true. */
    write?: boolean;
  }): StorageTaskStream;
  revoke(
    space: string,
    expectedRevision: string,
    effectKey: string,
    signal?: AbortSignal
  ): Promise<RevokeReceipt>;
  /** Freeze commits the SQL fence before canceling and settling local handlers. */
  settleSpace(space: string, signal?: AbortSignal): Promise<void>;
  quiesceSpace(space: string, signal?: AbortSignal): Promise<void>;
  check(signal: AbortSignal): Promise<boolean>;
}
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REVISION = /^(0|[1-9][0-9]{0,18})$/;
const MAX_REVISION = 9223372036854775807n;
/** Deliberate extra readiness subject: the catalog alone cannot prove auth DDL. */
const AUTH_READY = `SELECT p.pod_uid, i.revision, r.receipt_id FROM task_access.projections p
  JOIN task_access.intents i USING (task_id,attempt_id,launch_id)
  LEFT JOIN storage.revoke_receipts r ON r.space_id=p.space_id LIMIT 0`;
/** One authoritative read, AFTER locks; clock_timestamp is wall time after any wait.
 * Canonical deadlines win over lagging projected deadlines. No default active row.
 * Stable intent writers UPDATE in place; gateway binding is immutable once verified.
 */
export const STORAGE_AUTH_READ = `WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS at) SELECT s.id AS space, s.access_revision::text AS revision,
 CASE WHEN i.mode='revoked' OR p.mode='revoked' OR s.mode NOT IN ('open','wrapping')
      OR instant.at >= i.hard_stop_at THEN 'denied'
      WHEN i.mode='wrapping' OR p.mode='wrapping' OR s.mode='wrapping'
      OR instant.at >= i.soft_due_at THEN 'wrapping' ELSE 'active' END AS mode
 FROM storage.spaces s JOIN task_access.projections p ON p.space_id=s.id
 JOIN task_access.intents i USING (task_id,attempt_id,launch_id) CROSS JOIN instant
 WHERE s.id=$1 AND p.pod_uid=$2 AND p.job_uid=$3
 AND p.access_revision=s.access_revision AND p.intent_revision <= i.revision
 AND i.task_id=$4 AND i.attempt_id=$5 AND i.launch_id=$6`;

export function createStorageAccess(
  options: StorageAccessOptions
): StorageAccess & { close(): Promise<void> } {
  const streams = new Map<string, Set<AbortController>>();
  const settlements = new Map<AbortController, Promise<void>>();
  const writers = new Set<AbortController>();
  const timeoutMs = options.timeoutMs ?? 5_000;
  const poolMax = options.poolMax ?? 8;
  if (!Number.isSafeInteger(poolMax) || poolMax < 1 || poolMax > 10)
    throw new StorageAccessError(500, 'access_config');
  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: 'lifemodel-storage-access',
    max: poolMax,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
    lock_timeout: timeoutMs,
    idleTimeoutMillis: 1_000,
    allowExitOnIdle: true,
  });
  // Revoke must not queue behind unrelated task guards waiting on row locks.
  const controlPool = new Pool({
    connectionString: options.connectionString,
    application_name: 'lifemodel-storage-access-control',
    max: 2,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
    lock_timeout: timeoutMs,
    idleTimeoutMillis: 1_000,
    allowExitOnIdle: true,
  });
  controlPool.on('error', () => undefined);
  controlPool.on('connect', (client) => client.on('error', () => undefined));
  // Pool errors and client errors are independent of query promise rejections.
  // Install once per connection, never once per checkout, and keep through end().
  const failed = new WeakSet<PoolClient>();
  pool.on('error', () => undefined);
  pool.on('connect', (client) => {
    client.on('error', () => {
      failed.add(client);
    });
  });
  let closing = false;
  let closePromise: Promise<void> | undefined;
  /** An aborted waiter cannot cancel pg-pool's internal pending item. If it is
   * eventually handed a client, destroy that client without running any SQL. */
  async function acquire(signal: AbortSignal): Promise<PoolClient> {
    signal.throwIfAborted();
    if (closing) throw new StorageAccessError(503, 'access_unavailable');
    return new Promise((resolve, reject) => {
      let settled = false;
      const abort = (): void => {
        settled = true;
        reject(new StorageAccessError(503, 'access_unavailable'));
      };
      signal.addEventListener('abort', abort, { once: true });
      void pool.connect().then(
        (client) => {
          signal.removeEventListener('abort', abort);
          if (settled || signal.aborted || closing) {
            client.release(true);
            if (!settled) reject(new StorageAccessError(503, 'access_unavailable'));
          } else {
            settled = true;
            resolve(client);
          }
        },
        () => {
          signal.removeEventListener('abort', abort);
          if (!settled) {
            settled = true;
            reject(new StorageAccessError(503, 'access_unavailable'));
          }
        }
      );
    });
  }
  /** Serializes local decisions/dispatch with commit-to-cancel-to-ACK. Not transfer. */
  const queues = new Map<string, Promise<void>>();
  async function exclusive<T>(space: string, run: () => Promise<T>): Promise<T> {
    const previous = queues.get(space) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    queues.set(space, next);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (queues.get(space) === next) queues.delete(space);
    }
  }
  async function transaction<T>(
    run: (client: PoolClient, assertLive: () => void) => Promise<T>,
    parent?: AbortSignal,
    write = true,
    control = false
  ): Promise<T> {
    if (control) {
      try {
        return await withStorageSqlClient(
          controlPool,
          options.connectionString,
          parent,
          async (client, retire) => {
            try {
              await client.query('BEGIN');
              await storageMaintenanceFence(client);
              const assertLive = (): void => {
                parent?.throwIfAborted();
              };
              const result = await run(client, assertLive);
              assertLive();
              await storageSqlCompletion(client, 'COMMIT', retire);
              return result;
            } catch (error) {
              if (!parent?.aborted)
                await storageSqlCompletion(client, 'ROLLBACK', retire).catch(() => undefined);
              throw error;
            }
          }
        );
      } catch (error) {
        // Checkout sees raw protocol errors and decides retirement BEFORE the
        // public error is normalized. Business refusals stay unchanged.
        if (error instanceof StorageAccessError) throw error;
        throw new StorageAccessError(503, 'access_unavailable');
      }
    }
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(parent ? [parent] : [])]);
    let client: PoolClient | undefined;
    let retired = false;
    const abort = (): void => {
      if (client && !retired) {
        retired = true;
        // release(true) destroys the connection. A query still in flight must
        // never return to the idle pool or execute for the next request.
        client.release(true);
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      client = await acquire(signal);
      // An abort can win between acquire resolving and this continuation.
      if (signal.aborted) abort();
      const connected = client;
      const assertLive = (): void => {
        if (signal.aborted || retired || failed.has(connected))
          throw new StorageAccessError(503, 'access_unavailable');
      };
      assertLive();
      await client.query('BEGIN');
      if (write) await storageMaintenanceFence(client);
      const value = await run(client, assertLive);
      assertLive();
      await storageSqlCompletion(client, 'COMMIT', () => failed.add(connected));
      assertLive();
      return value;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      // A local query timeout can reject before PostgreSQL finishes its query.
      // Only server SQLSTATE errors (or our own completed mediation checks) are
      // safe to roll back and reuse; retire every uncertain protocol state.
      if (
        client &&
        !(error instanceof StorageAccessError) &&
        (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code))
      )
        failed.add(client);
      if (client && !retired && !failed.has(client))
        await client.query('ROLLBACK').catch(() => {
          if (client) failed.add(client);
        });
      if (error instanceof StorageAccessError) throw error;
      if (error && typeof error === 'object' && 'code' in error && error.code === '53000')
        throw new StorageAccessError(507, 'capacity_exhausted');
      throw new StorageAccessError(503, 'access_unavailable');
    } finally {
      signal.removeEventListener('abort', abort);
      if (client && !retired) client.release(failed.has(client));
    }
  }
  async function waitForSpace(
    pending: Promise<void>[],
    code: string,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    let abort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(pending),
        new Promise<never>((_, reject) => {
          abort = () => {
            reject(new StorageAccessError(503, code));
          };
          signal?.addEventListener('abort', abort, { once: true });
          timer = setTimeout(abort, 5000);
          timer.unref();
        }),
      ]);
    } finally {
      if (abort) signal?.removeEventListener('abort', abort);
      if (timer) clearTimeout(timer);
    }
  }
  function cancel(space: string): void {
    for (const controller of streams.get(space) ?? [])
      controller.abort(new StorageAccessError(403, 'access_revoked'));
  }
  function validateSpace(space: string): void {
    if (!ID.test(space)) throw new StorageAccessError(400, 'invalid_request');
  }
  return {
    close: () => {
      closing = true;
      for (const space of streams.keys()) cancel(space);
      closePromise ??= Promise.all([pool.end(), controlPool.end()]).then(() => undefined);
      return closePromise;
    },
    identity: options.identity,
    quiesceSpace: async (space, signal) => {
      const pending = [...(streams.get(space) ?? [])]
        .filter((controller) => writers.has(controller))
        .map((controller) => {
          const promise = settlements.get(controller);
          if (!promise) throw new StorageAccessError(503, 'cleanup_pending');
          return promise;
        });
      await waitForSpace(pending, 'quiescence_pending', signal);
    },
    settleSpace: async (space, signal) => {
      const pending = [...(streams.get(space) ?? [])].map((controller) => {
        const promise = settlements.get(controller);
        if (!promise) throw new StorageAccessError(503, 'cleanup_pending');
        return promise;
      });
      cancel(space);
      await waitForSpace(pending, 'cleanup_pending', signal);
    },
    check: async (signal) => {
      try {
        await transaction(
          async (client) => {
            await client.query(AUTH_READY);
          },
          signal,
          false
        );
        return true;
      } catch {
        return false;
      }
    },
    openTaskStream: ({ token, space, signal: parent, write = true }) => {
      validateSpace(space);
      const controller = new AbortController();
      const controllers = streams.get(space) ?? new Set<AbortController>();
      let settled: () => void = () => undefined;
      settlements.set(
        controller,
        new Promise<void>((resolve) => {
          settled = resolve;
        })
      );
      controllers.add(controller);
      if (write) writers.add(controller);
      streams.set(space, controllers);
      const signal = AbortSignal.any([controller.signal, ...(parent ? [parent] : [])]);
      function live(): void {
        if (signal.aborted) throw new StorageAccessError(403, 'access_revoked');
      }
      async function guarded(
        bytes: number,
        dispatch: ((decision: StorageDecision) => undefined) | StorageMetadataStatement
      ): Promise<StoragePublicationResult | undefined> {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 4 * 1024 * 1024)
          throw new StorageAccessError(400, 'invalid_chunk');
        live();
        const identity = await options.identity.verify(token, STORAGE_AUDIENCES.task, signal);
        {
          live();
          return await transaction(
            async (client, assertLive) => {
              // Fixed lock order: stable canonical authority, then catalog. These
              // lock-only reads confer no permission; the one final JOIN does.
              const locked = await client.query<{
                task_id: string;
                attempt_id: string;
                launch_id: string;
              }>(
                `SELECT i.task_id, i.attempt_id, i.launch_id FROM task_access.intents i
              JOIN task_access.projections p USING(task_id,attempt_id,launch_id)
              WHERE p.space_id=$1 AND p.pod_uid=$2 FOR SHARE OF i,p`,
                [space, identity.podUid]
              );
              const binding = locked.rows[0];
              if (locked.rows.length !== 1 || !binding)
                throw new StorageAccessError(403, 'access_denied');
              assertLive();
              const lockedSpace = await client.query(
                'SELECT id FROM storage.spaces WHERE id=$1 FOR SHARE',
                [space]
              );
              if (lockedSpace.rows.length !== 1) throw new StorageAccessError(403, 'access_denied');
              const result = await client.query<StorageDecision & { mode: string }>(
                STORAGE_AUTH_READ,
                [
                  space,
                  identity.podUid,
                  identity.jobUid,
                  binding.task_id,
                  binding.attempt_id,
                  binding.launch_id,
                ]
              );
              const decision = result.rows[0];
              live();
              assertLive();
              if (!decision || (decision.mode !== 'active' && decision.mode !== 'wrapping'))
                throw new StorageAccessError(403, 'access_denied');
              if (typeof dispatch === 'function') {
                if (dispatch.constructor.name === 'AsyncFunction')
                  throw new StorageAccessError(500, 'async_dispatch_forbidden');
                const returned = (dispatch as (value: StorageDecision) => unknown)(decision);
                if (returned !== undefined)
                  throw new StorageAccessError(500, 'async_dispatch_forbidden');
                return undefined;
              } else {
                // No Client/permit escapes. The storage adapter supplies fixed SQL,
                // binds all request values, and must never issue transaction control.
                const result = await client.query(dispatch.text, dispatch.values);
                assertLive();
                live();
                return { rows: result.rows as Record<string, unknown>[] };
              }
            },
            signal,
            write
          );
        }
      }
      return {
        signal,
        chunk: async (bytes, dispatch) => {
          await guarded(bytes, dispatch);
        },
        publish: async (statement) => {
          const result = await guarded(0, statement);
          if (!result) throw new StorageAccessError(503, 'publication_unavailable');
          return result;
        },
        close: () => {
          controller.abort();
          controllers.delete(controller);
          settlements.delete(controller);
          writers.delete(controller);
          settled();
          if (!controllers.size && streams.get(space) === controllers) streams.delete(space);
        },
      };
    },
    revoke: async (space, expectedRevision, effectKey, signal) => {
      validateSpace(space);
      if (
        !REVISION.test(expectedRevision) ||
        BigInt(expectedRevision) >= MAX_REVISION ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(effectKey)
      )
        throw new StorageAccessError(400, 'invalid_request');
      return exclusive(space, async () => {
        signal?.throwIfAborted();
        const receipt = await transaction(
          async (client) => {
            // Global effect-key lock also orders same-key requests across spaces.
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
              effectKey,
            ]);
            const old = await client.query<{
              receipt_id: string;
              space_id: string;
              expected_revision: string;
              revision: string;
            }>('SELECT * FROM storage.revoke_receipts WHERE effect_key=$1', [effectKey]);
            const saved = old.rows[0];
            if (saved) {
              if (saved.space_id !== space || saved.expected_revision !== expectedRevision)
                throw new StorageAccessError(409, 'effect_conflict');
              return { id: saved.receipt_id, space, revision: saved.revision, effectKey };
            }
            const existing = await client.query(
              'SELECT id FROM storage.spaces WHERE id=$1 FOR UPDATE',
              [space]
            );
            if (existing.rows.length !== 1) throw new StorageAccessError(404, 'space_not_found');
            const updated = await client.query<{ access_revision: string }>(
              `UPDATE storage.spaces SET access_revision=access_revision+1, mode='revoked'
            WHERE id=$1 AND access_revision=$2 AND mode IN ('open','wrapping','revoked') RETURNING access_revision::text`,
              [space, expectedRevision]
            );
            const revision = updated.rows[0]?.access_revision;
            if (revision === undefined) throw new StorageAccessError(409, 'revision_conflict');
            const id = randomUUID();
            await client.query(
              `INSERT INTO storage.revoke_receipts(effect_key,space_id,expected_revision,revision,receipt_id) VALUES($1,$2,$3,$4,$5)`,
              [effectKey, space, expectedRevision, revision, id]
            );
            return { id, space, revision, effectKey };
          },
          signal,
          true,
          true
        );
        // SQL denies new chunks after commit; all local streams cancel before ACK. Replays cancel too.
        cancel(space);
        return receipt;
      });
    },
  };
}
