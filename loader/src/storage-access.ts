/** Short complete-mediation guard for trusted storage adapters. No reusable permit
 * escapes. Chunk callbacks dispatch synchronously only: never schedule deferred
 * work with the decision. Await socket drain/S3 outside this guard and reenter
 * for every next chunk. Untrusted code never supplies a callback or SQL. */
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { StorageAccessError } from './storage-access-error.js';
import { STORAGE_AUDIENCES, type KubernetesStorageIdentity } from './storage-identity.js';
export { STORAGE_AUDIENCES } from './storage-identity.js';
export { StorageAccessError } from './storage-access-error.js';

export interface StorageDecision {
  space: string;
  revision: string;
  mode: 'active' | 'wrapping';
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
  publish(statement: StorageMetadataStatement): Promise<void>;
  close(): void;
}
export interface StorageMetadataStatement {
  text: string;
  values: unknown[];
}
export interface StorageAccessOptions {
  connectionString: string;
  identity: KubernetesStorageIdentity;
  timeoutMs?: number;
}
export interface StorageAccess {
  identity: KubernetesStorageIdentity;
  openTaskStream(input: { token: string; space: string; signal?: AbortSignal }): StorageTaskStream;
  revoke(space: string, expectedRevision: string, effectKey: string): Promise<RevokeReceipt>;
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

export function createStorageAccess(options: StorageAccessOptions): StorageAccess {
  const streams = new Map<string, Set<AbortController>>();
  const timeoutMs = options.timeoutMs ?? 5_000;
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
    run: (client: Client, assertLive: () => void) => Promise<T>,
    parent?: AbortSignal
  ): Promise<T> {
    const client = new Client({
      connectionString: options.connectionString,
      application_name: 'lifemodel-storage-access',
      connectionTimeoutMillis: timeoutMs,
      query_timeout: timeoutMs,
      statement_timeout: timeoutMs,
      lock_timeout: timeoutMs,
    });
    // Keep through teardown: an error event is independent of a query rejection.
    let transportFailed = false;
    client.on('error', () => {
      transportFailed = true;
    });
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(parent ? [parent] : [])]);
    const abort = (): void => {
      void client.end().catch(() => undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      await client.connect();
      await client.query('BEGIN');
      const assertLive = (): void => {
        if (signal.aborted || transportFailed)
          throw new StorageAccessError(503, 'access_unavailable');
      };
      const value = await run(client, assertLive);
      assertLive();
      signal.throwIfAborted();
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof StorageAccessError) throw error;
      throw new StorageAccessError(503, 'access_unavailable');
    } finally {
      signal.removeEventListener('abort', abort);
      await client.end().catch(() => undefined);
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
    identity: options.identity,
    check: async (signal) => {
      try {
        await transaction(async (client) => {
          await client.query(AUTH_READY);
        }, signal);
        return true;
      } catch {
        return false;
      }
    },
    openTaskStream: ({ token, space, signal: parent }) => {
      validateSpace(space);
      const controller = new AbortController();
      const controllers = streams.get(space) ?? new Set<AbortController>();
      controllers.add(controller);
      streams.set(space, controllers);
      const signal = AbortSignal.any([controller.signal, ...(parent ? [parent] : [])]);
      function live(): void {
        if (signal.aborted) throw new StorageAccessError(403, 'access_revoked');
      }
      async function guarded(
        bytes: number,
        dispatch: ((decision: StorageDecision) => undefined) | StorageMetadataStatement
      ): Promise<void> {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 4 * 1024 * 1024)
          throw new StorageAccessError(400, 'invalid_chunk');
        live();
        const identity = await options.identity.verify(token, STORAGE_AUDIENCES.task, signal);
        {
          live();
          await transaction(async (client, assertLive) => {
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
            } else {
              // No Client/permit escapes. The storage adapter supplies fixed SQL,
              // binds all request values, and must never issue transaction control.
              await client.query(dispatch.text, dispatch.values);
              assertLive();
              live();
            }
          }, signal);
        }
      }
      return {
        signal,
        chunk: guarded,
        publish: (statement) => guarded(0, statement),
        close: () => {
          controller.abort();
          controllers.delete(controller);
          if (!controllers.size && streams.get(space) === controllers) streams.delete(space);
        },
      };
    },
    revoke: async (space, expectedRevision, effectKey) => {
      validateSpace(space);
      if (
        !REVISION.test(expectedRevision) ||
        BigInt(expectedRevision) >= MAX_REVISION ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(effectKey)
      )
        throw new StorageAccessError(400, 'invalid_request');
      return exclusive(space, async () => {
        const receipt = await transaction(async (client) => {
          // Global effect-key lock also orders same-key requests across spaces.
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [effectKey]);
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
            WHERE id=$1 AND access_revision=$2 RETURNING access_revision::text`,
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
        });
        // SQL denies new chunks after commit; all local streams cancel before ACK. Replays cancel too.
        cancel(space);
        return receipt;
      });
    },
  };
}
