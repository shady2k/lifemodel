/** Module-owned retention policy, durable warning batches and recoverable byte removal. */
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { StorageAccessError } from './storage-access-error.js';
import type { StorageObjectS3 } from './storage-object-s3.js';
import type { LoaderLogger } from './logger.js';
import { sweepExpiredUploads } from './storage-expired-uploads.js';
import type { StorageUploadOwner } from './storage-upload-owner.js';

export interface RetentionSettings {
  retention: '90d' | 'forever';
  warningLeadDays: number;
  revision: number;
}
interface Options {
  connectionString: string;
  s3: StorageObjectS3;
  owner: StorageUploadOwner;
  settings: { read(): Promise<RetentionSettings> };
  logger: LoaderLogger;
  now?: () => number;
}
export interface StorageRetention {
  snapshot(client: PoolClient, space: string): Promise<void>;
  pending(input: { limit?: number; cursor?: string }): Promise<Record<string, unknown>>;
  warningCommitted(input: unknown): Promise<Record<string, unknown>>;
  policy(input: unknown): Promise<Record<string, unknown>>;
  reclaim(input: unknown): Promise<Record<string, unknown>>;
  runOnce(): Promise<void>;
  start(): void;
  check(signal: AbortSignal): Promise<boolean>;
  close(): Promise<void>;
}
export const STORAGE_RETENTION_BOUNDS = {
  batch: 100,
  orphanGraceMs: 172_800_000,
  readLeaseMs: 30_000,
  intervalMs: 60_000,
} as const;
const DAY = 86_400_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SPACE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REV = /^(0|[1-9][0-9]{0,18})$/;
function fail(status: number, code: string): never {
  throw new StorageAccessError(status, code);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_request');
  return value as Record<string, unknown>;
}
function fields(row: Record<string, unknown>, names: string[]) {
  if (Object.keys(row).length !== names.length || names.some((name) => !(name in row)))
    fail(400, 'invalid_request');
}
function id(value: unknown, space = false): string {
  if (typeof value !== 'string' || !(space ? SPACE : ID).test(value)) fail(400, 'invalid_request');
  return value;
}
interface Candidate extends QueryResultRow {
  plan_id: string;
  space_id: string;
  object_id: string;
  policy_revision: string;
  object_revision: string;
  s3_key: string;
  size: string;
  state: string;
}
export function createStorageRetention(options: Options): StorageRetention {
  const now = options.now ?? Date.now;
  const pool = new Pool({
    connectionString: options.connectionString,
    max: 4,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    statement_timeout: 5000,
    lock_timeout: 5000,
    application_name: 'lifemodel-storage-retention',
  });
  pool.on('error', () => undefined);
  pool.on('connect', (client) => client.on('error', () => undefined));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let sweepCursor: string | undefined;
  async function tx<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect().catch(() => fail(503, 'catalog_unavailable'));
    let broken = false;
    const onError = () => {
      broken = true;
    };
    client.on('error', onError);
    try {
      await client.query('BEGIN');
      const result = await run(client);
      if (broken) fail(503, 'catalog_unavailable');
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof StorageAccessError) throw error;
      if (typeof error === 'object' && error && 'code' in error && error.code === '53000')
        fail(507, 'capacity_exhausted');
      fail(503, 'catalog_unavailable');
    } finally {
      client.removeListener('error', onError);
      client.release(broken);
    }
  }
  /** SQL sessions serialize healthy contenders, but cannot fence S3 after loss.
   * DELETE is at-least-once and idempotent: private immutable random keys are
   * never reused; 200/204/404 confirm removal and SQL accounting changes once.
   * Cancel transport synchronously on owner error/end, then await its settlement
   * before releasing this holder. A remote completion can still be ambiguous. */
  async function withSessionLock<T>(
    key: string,
    namespace: 7 | 8,
    work: (signal: AbortSignal) => Promise<T>
  ): Promise<T | undefined> {
    const owner = await pool.connect();
    const controller = new AbortController();
    let locked = false;
    let broken = false;
    const failed = () => {
      broken = true;
      controller.abort();
    };
    owner.on('error', failed);
    owner.on('end', failed);
    try {
      locked =
        (
          await owner.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_lock(hashtextextended($1,$2)) AS locked',
            [key, namespace]
          )
        ).rows[0]?.locked === true;
      if (!locked) return undefined;
      controller.signal.throwIfAborted();
      const result = await work(controller.signal);
      controller.signal.throwIfAborted();
      return result;
    } finally {
      if (locked && !broken)
        await owner
          .query('SELECT pg_advisory_unlock(hashtextextended($1,$2))', [key, namespace])
          .catch(failed);
      owner.removeListener('error', failed);
      owner.removeListener('end', failed);
      owner.release(broken);
    }
  }
  function withKey<T>(key: string, work: (signal: AbortSignal) => Promise<T>) {
    return withSessionLock(key, 8, work);
  }
  function collectionFailure(error: unknown, message: string) {
    const failure =
      error instanceof StorageAccessError ? error : new StorageAccessError(503, 'gc_unavailable');
    options.logger.warn(
      {
        id: failure.id,
        ...(error instanceof StorageAccessError ? { status: error.status } : {}),
        count: 1,
      },
      message
    );
  }
  async function lockPlans(client: PoolClient) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('storage-retention-plans',0))"
    );
  }
  async function totals(client: PoolClient, planIds: string[]) {
    await client.query(
      `UPDATE storage.deletion_plans p SET total_bytes=(SELECT COALESCE(sum(size),0) FROM storage.deletion_candidates c WHERE c.plan_id=p.id AND c.state<>'removed'),state=CASE WHEN NOT EXISTS(SELECT 1 FROM storage.deletion_candidates c WHERE c.plan_id=p.id AND c.state IN ('pending','deleting')) THEN 'complete' ELSE p.state END WHERE p.state<>'complete' AND p.id=ANY($1::text[])`,
      [planIds]
    );
  }
  async function build(
    reason: 'age' | 'quota',
    bytes?: number,
    transaction?: PoolClient
  ): Promise<string | null> {
    const settings = await options.settings.read();
    const work = async (client: PoolClient) => {
      await lockPlans(client);
      const rows = (
        await client.query<{ space_id: string }>(
          `SELECT p.space_id FROM storage.retention_policies p JOIN storage.spaces s ON s.id=p.space_id WHERE s.mode='sealed' AND p.state='retained' AND NOT p.pinned AND p.retention='90d' AND ($1::text='quota' OR p.expires_at<=to_timestamp($2/1000.0)) AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.space_id=p.space_id AND NOT EXISTS(SELECT 1 FROM storage.object_tombstones t WHERE t.object_id=o.id) AND NOT EXISTS(SELECT 1 FROM storage.deletion_candidates c WHERE c.object_id=o.id AND c.state IN ('pending','deleting'))) ORDER BY p.terminal_at,p.space_id LIMIT 100 FOR UPDATE OF p`,
          [reason, now()]
        )
      ).rows;
      if (!rows.length) return null;
      let plan = (
        await client.query<{ id: string }>(
          "SELECT id FROM storage.deletion_plans WHERE reason=$1 AND state='pending' AND exposed_at IS NULL FOR UPDATE",
          [reason]
        )
      ).rows[0]?.id;
      if (!plan) {
        plan = randomUUID();
        await client.query(
          'INSERT INTO storage.deletion_plans(id,reason,lead_days,settings_revision) VALUES($1,$2,$3,$4)',
          [plan, reason, settings.warningLeadDays, settings.revision]
        );
      }
      let selected = 0;
      let remaining = STORAGE_RETENTION_BOUNDS.batch as number;
      for (const row of rows) {
        const added = await client.query<{ size: string }>(
          `INSERT INTO storage.deletion_candidates(plan_id,space_id,policy_revision,object_id,object_revision,s3_key,size) SELECT $1,o.space_id,p.revision,o.id,o.sequence,a.s3_key,o.size FROM storage.objects o JOIN storage.retention_policies p ON p.space_id=o.space_id JOIN storage.object_versions v ON v.object_id=o.id JOIN storage.upload_attempts a ON a.id=v.attempt_id WHERE o.space_id=$2 AND NOT EXISTS(SELECT 1 FROM storage.object_tombstones t WHERE t.object_id=o.id) AND NOT EXISTS(SELECT 1 FROM storage.deletion_candidates c WHERE c.object_id=o.id AND c.state IN ('pending','deleting')) ORDER BY o.id LIMIT $3 ON CONFLICT(plan_id,object_id) DO UPDATE SET policy_revision=EXCLUDED.policy_revision,object_revision=EXCLUDED.object_revision,state='pending' WHERE storage.deletion_candidates.state='removed' RETURNING size::text`,
          [plan, row.space_id, remaining]
        );
        selected += added.rows.reduce((sum, r) => sum + Number(r.size), 0);
        remaining -= added.rows.length;
        if (remaining === 0 || (bytes !== undefined && selected >= bytes)) break;
      }
      // Pending notices may gain candidates, but can never lose protection.
      await client.query(
        'UPDATE storage.deletion_plans SET lead_days=GREATEST(lead_days,$2),settings_revision=$3 WHERE id=$1',
        [plan, settings.warningLeadDays, settings.revision]
      );
      await totals(client, [plan]);
      return plan;
    };
    return transaction ? work(transaction) : tx(work);
  }
  async function removeCandidate(client: PoolClient, candidate: Candidate) {
    await client.query(
      "UPDATE storage.deletion_candidates SET state='removed' WHERE plan_id=$1 AND object_id=$2 AND state='pending'",
      [candidate.plan_id, candidate.object_id]
    );
    await totals(client, [candidate.plan_id]);
  }
  async function deleteCandidate(candidate: Candidate, settings: RetentionSettings) {
    await withSessionLock(candidate.object_id, 7, async (signal) => {
      const ready = await tx(async (client) => {
        // Policy is the shared pin/delete lock. No network I/O holds it.
        const policy = (
          await client.query<{
            revision: string;
            pinned: boolean;
            retention: string;
            state: string;
          }>(
            'SELECT revision::text,pinned,retention,state FROM storage.retention_policies WHERE space_id=$1 FOR UPDATE',
            [candidate.space_id]
          )
        ).rows[0];
        const current = (
          await client.query<Candidate>(
            'SELECT * FROM storage.deletion_candidates WHERE plan_id=$1 AND object_id=$2 FOR UPDATE',
            [candidate.plan_id, candidate.object_id]
          )
        ).rows[0];
        if (!current || !policy || !['pending', 'deleting'].includes(current.state)) return false;
        if (current.state === 'deleting') return true;
        const plan = (
          await client.query<{
            state: string;
            warned_at: Date;
            earliest_delete_at: Date;
            lead_days: number;
          }>(
            'SELECT state,warned_at,earliest_delete_at,lead_days FROM storage.deletion_plans WHERE id=$1 FOR UPDATE',
            [candidate.plan_id]
          )
        ).rows[0];
        if (plan?.state !== 'warned' || !plan.warned_at) return false;
        const earliest = Math.max(
          plan.earliest_delete_at.getTime(),
          plan.warned_at.getTime() + settings.warningLeadDays * DAY
        );
        if (earliest > plan.earliest_delete_at.getTime())
          await client.query(
            'UPDATE storage.deletion_plans SET earliest_delete_at=to_timestamp($2/1000.0),lead_days=GREATEST(lead_days,$3) WHERE id=$1',
            [candidate.plan_id, earliest, settings.warningLeadDays]
          );
        if (now() < earliest) return false;
        if (
          policy.pinned ||
          policy.retention === 'forever' ||
          policy.revision !== current.policy_revision
        ) {
          await removeCandidate(client, current);
          return false;
        }
        const object = (
          await client.query<{ sequence: string }>(
            'SELECT sequence::text FROM storage.objects o WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM storage.object_tombstones t WHERE t.object_id=o.id)',
            [current.object_id]
          )
        ).rows[0];
        if (object?.sequence !== current.object_revision) {
          await removeCandidate(client, current);
          return false;
        }
        await client.query('SELECT id FROM storage.spaces WHERE id=$1 FOR UPDATE', [
          current.space_id,
        ]);
        if (
          (
            await client.query(
              'SELECT 1 FROM storage.read_leases WHERE space_id=$1 AND expires_at>to_timestamp($2/1000.0) LIMIT 1',
              [current.space_id, now()]
            )
          ).rowCount
        )
          return false;
        await client.query(
          "UPDATE storage.retention_policies SET state='deleting' WHERE space_id=$1",
          [current.space_id]
        );
        await client.query(
          "INSERT INTO storage.retention_tombstones(object_id,space_id,plan_id,state) VALUES($1,$2,$3,'deleting') ON CONFLICT DO NOTHING",
          [current.object_id, current.space_id, current.plan_id]
        );
        await client.query(
          "UPDATE storage.deletion_candidates SET state='deleting' WHERE plan_id=$1 AND object_id=$2",
          [current.plan_id, current.object_id]
        );
        return true;
      });
      if (!ready) return;
      signal.throwIfAborted();
      await options.s3.delete(
        candidate.space_id,
        candidate.s3_key,
        AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      );
      signal.throwIfAborted();
      await tx(async (client) => {
        await client.query(
          'SELECT space_id FROM storage.retention_policies WHERE space_id=$1 FOR UPDATE',
          [candidate.space_id]
        );
        const changed = await client.query(
          "UPDATE storage.deletion_candidates SET state='deleted' WHERE plan_id=$1 AND object_id=$2 AND state='deleting' RETURNING size::text",
          [candidate.plan_id, candidate.object_id]
        );
        if (!changed.rowCount) return;
        await client.query(
          "INSERT INTO storage.object_tombstones(object_id,space_id,reason) VALUES($1,$2,'seal_unmarked') ON CONFLICT DO NOTHING",
          [candidate.object_id, candidate.space_id]
        );
        await client.query(
          "UPDATE storage.retention_tombstones SET state='deleted' WHERE object_id=$1",
          [candidate.object_id]
        );
        await client.query(
          'UPDATE storage.space_quota SET charged_bytes=charged_bytes-$2 WHERE space_id=$1',
          [candidate.space_id, candidate.size]
        );
        await client.query(
          "UPDATE storage.retention_policies p SET state=CASE WHEN EXISTS(SELECT 1 FROM storage.objects o WHERE o.space_id=p.space_id AND NOT EXISTS(SELECT 1 FROM storage.object_tombstones t WHERE t.object_id=o.id)) THEN CASE WHEN EXISTS(SELECT 1 FROM storage.deletion_candidates c WHERE c.space_id=p.space_id AND c.state='deleting') THEN 'deleting' ELSE 'retained' END ELSE 'deleted' END WHERE space_id=$1",
          [candidate.space_id]
        );
        await totals(client, [candidate.plan_id]);
      });
    });
  }
  async function sweep() {
    const page = await options.s3.listPrivate(sweepCursor, AbortSignal.timeout(10_000));
    sweepCursor = page.nextCursor ?? undefined;
    for (const entry of page.objects) {
      try {
        await tx(async (client) => {
          // A referenced object never becomes orphan garbage. A live attempt is
          // protected regardless of the backend object's LastModified timestamp.
          const referenced = await client.query(
            `SELECT 1 FROM storage.upload_attempts a JOIN storage.upload_intents i USING(space_id,upload_id) WHERE a.s3_key=$1 AND (EXISTS(SELECT 1 FROM storage.object_versions v WHERE v.attempt_id=a.id AND NOT EXISTS(SELECT 1 FROM storage.object_tombstones t WHERE t.object_id=v.object_id)) OR (i.state='pending' AND NOT EXISTS(SELECT 1 FROM storage.attempt_gc g WHERE g.attempt_id=a.id) AND NOT EXISTS(SELECT 1 FROM storage.seal_gc g WHERE g.attempt_id=a.id AND g.deleted)))`,
            [entry.key]
          );
          if (referenced.rowCount) return;
          // Charge discoveries even during grace: unknown backend bytes cannot
          // silently create free ledger capacity. No reservation is double charged.
          const held = await client.query(
            `SELECT 1 FROM storage.upload_attempts a JOIN storage.upload_intents i USING(space_id,upload_id) WHERE a.s3_key=$1 AND i.reserved`,
            [entry.key]
          );
          if (held.rowCount) return;
          if (
            (
              await client.query(
                'SELECT 1 FROM storage.attempt_gc WHERE s3_key=$1 AND NOT deleted',
                [entry.key]
              )
            ).rowCount
          )
            return;
          const inserted = await client.query(
            'INSERT INTO storage.orphan_gc(s3_key,size,first_seen_at,last_modified) VALUES($1,$2,to_timestamp($3/1000.0),to_timestamp($4/1000.0)) ON CONFLICT(s3_key) DO UPDATE SET size=EXCLUDED.size,first_seen_at=EXCLUDED.first_seen_at,last_modified=EXCLUDED.last_modified,deleted=false WHERE storage.orphan_gc.deleted RETURNING s3_key',
            [entry.key, entry.size, now(), entry.lastModified]
          );
          if (inserted.rowCount)
            await client.query(
              'UPDATE storage.instance_ledger SET used_bytes=used_bytes+$1 WHERE id=true',
              [entry.size]
            );
        });
      } catch (error) {
        collectionFailure(error, 'Storage orphan accounting pending');
      }
    }
    const garbage = await tx(
      async (client) =>
        (
          await client.query<{ s3_key: string; size: string }>(
            `SELECT s3_key,size::text FROM storage.orphan_gc WHERE NOT deleted AND last_modified<=to_timestamp($1/1000.0) AND NOT EXISTS(SELECT 1 FROM storage.attempt_gc g WHERE g.s3_key=storage.orphan_gc.s3_key AND NOT g.deleted) AND NOT EXISTS(SELECT 1 FROM storage.upload_attempts a JOIN storage.upload_intents i USING(space_id,upload_id) WHERE a.s3_key=storage.orphan_gc.s3_key AND ((i.state='pending' AND NOT EXISTS(SELECT 1 FROM storage.attempt_gc g WHERE g.attempt_id=a.id) AND NOT EXISTS(SELECT 1 FROM storage.seal_gc g WHERE g.attempt_id=a.id AND g.deleted)) OR EXISTS(SELECT 1 FROM storage.object_versions v WHERE v.attempt_id=a.id AND NOT EXISTS(SELECT 1 FROM storage.object_tombstones t WHERE t.object_id=v.object_id)))) ORDER BY first_seen_at,s3_key LIMIT 100`,
            [now() - STORAGE_RETENTION_BOUNDS.orphanGraceMs]
          )
        ).rows
    );
    for (const entry of garbage) {
      try {
        await withKey(entry.s3_key, async (signal) => {
          const safe = await tx(async (client) => {
            const row = await client.query(
              'SELECT 1 FROM storage.orphan_gc WHERE s3_key=$1 AND NOT deleted',
              [entry.s3_key]
            );
            const ref = await client.query(
              `SELECT 1 FROM storage.upload_attempts a JOIN storage.upload_intents i USING(space_id,upload_id) WHERE a.s3_key=$1 AND ((i.state='pending' AND NOT EXISTS(SELECT 1 FROM storage.attempt_gc g WHERE g.attempt_id=a.id) AND NOT EXISTS(SELECT 1 FROM storage.seal_gc g WHERE g.attempt_id=a.id AND g.deleted)) OR EXISTS(SELECT 1 FROM storage.object_versions v WHERE v.attempt_id=a.id AND NOT EXISTS(SELECT 1 FROM storage.object_tombstones t WHERE t.object_id=v.object_id)))`,
              [entry.s3_key]
            );
            return row.rowCount === 1 && !ref.rowCount;
          });
          if (!safe) return;
          signal.throwIfAborted();
          await options.s3.delete(
            'orphan-gc',
            entry.s3_key,
            AbortSignal.any([signal, AbortSignal.timeout(10_000)])
          );
          signal.throwIfAborted();
          await tx(async (client) => {
            const updated = await client.query(
              'UPDATE storage.orphan_gc SET deleted=true WHERE s3_key=$1 AND NOT deleted RETURNING size::text',
              [entry.s3_key]
            );
            if (updated.rowCount)
              await client.query(
                'UPDATE storage.instance_ledger SET used_bytes=used_bytes-$1 WHERE id=true',
                [entry.size]
              );
          });
        });
      } catch (error) {
        collectionFailure(error, 'Storage orphan deletion pending');
      }
    }
  }
  async function tick() {
    await tx(async (client) => {
      const empty = (
        await client.query<{ space_id: string; upload_id: string }>(
          "SELECT i.space_id,i.upload_id FROM storage.upload_intents i JOIN storage.spaces s ON s.id=i.space_id WHERE i.state='pending' AND i.reserved AND i.lease_expires_at<=to_timestamp($1/1000.0) AND s.mode IN ('open','wrapping') AND NOT EXISTS(SELECT 1 FROM storage.upload_attempts a WHERE a.space_id=i.space_id AND a.upload_id=i.upload_id) ORDER BY i.lease_expires_at,i.space_id,i.upload_id LIMIT 100",
          [now()]
        )
      ).rows;
      for (const entry of empty) {
        await client.query('SELECT id FROM storage.spaces WHERE id=$1 FOR SHARE', [entry.space_id]);
        await client.query(
          'SELECT space_id FROM storage.space_quota WHERE space_id=$1 FOR UPDATE',
          [entry.space_id]
        );
        await client.query(
          "SELECT storage.release_upload(i.space_id,i.upload_id) FROM storage.upload_intents i WHERE i.space_id=$1 AND i.upload_id=$2 AND i.state='pending' AND i.lease_expires_at<=to_timestamp($3/1000.0) AND NOT EXISTS(SELECT 1 FROM storage.upload_attempts a WHERE a.space_id=i.space_id AND a.upload_id=i.upload_id)",
          [entry.space_id, entry.upload_id, now()]
        );
      }
    });
    await sweepExpiredUploads({
      tx,
      withKey,
      s3: options.s3,
      owner: options.owner,
      logger: options.logger,
      now,
      graceMs: STORAGE_RETENTION_BOUNDS.orphanGraceMs,
    });
    await build('age');
    const settings = await options.settings.read();
    await tx(async (client) => {
      await client.query(
        "UPDATE storage.deletion_plans SET earliest_delete_at=GREATEST(earliest_delete_at,warned_at+make_interval(days=>$1)),lead_days=GREATEST(lead_days,$1) WHERE state='warned'",
        [settings.warningLeadDays]
      );
    });
    const candidates = await tx(
      async (client) =>
        (
          await client.query<Candidate>(
            "SELECT c.* FROM storage.deletion_candidates c JOIN storage.deletion_plans p ON p.id=c.plan_id WHERE c.state='deleting' OR (c.state='pending' AND p.state='warned' AND p.earliest_delete_at<=to_timestamp($1/1000.0) AND NOT EXISTS(SELECT 1 FROM storage.read_leases l WHERE l.space_id=c.space_id AND l.expires_at>to_timestamp($1/1000.0))) ORDER BY p.sequence,c.object_id LIMIT 100",
            [now()]
          )
        ).rows
    );
    for (const candidate of candidates) {
      try {
        await deleteCandidate(candidate, settings);
      } catch (error) {
        const failure =
          error instanceof StorageAccessError
            ? error
            : new StorageAccessError(503, 'gc_unavailable');
        options.logger.warn(
          { id: failure.id, code: failure.code, status: failure.status },
          'Storage deletion pending'
        );
      }
    }
    await sweep();
    await tx(async (client) => {
      await client.query(
        'DELETE FROM storage.read_leases WHERE expires_at<=to_timestamp($1/1000.0)',
        [now()]
      );
    });
  }
  function runOnce() {
    running ??= tick().finally(() => {
      running = undefined;
    });
    return running;
  }
  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => {
      void runOnce()
        .catch(() => {
          options.logger.warn(
            { id: randomUUID(), code: 'gc_unavailable', status: 503 },
            'Storage collection pending'
          );
        })
        .finally(schedule);
    }, STORAGE_RETENTION_BOUNDS.intervalMs);
    timer.unref();
  }
  return {
    snapshot: async (client, space) => {
      const setting = await options.settings.read();
      await client.query(
        `INSERT INTO storage.retention_policies(space_id,retention,settings_revision,terminal_at,expires_at) VALUES($1,$2,$3,to_timestamp($4/1000.0),CASE WHEN $2='90d' THEN to_timestamp($4/1000.0)+interval '90 days' ELSE NULL END) ON CONFLICT DO NOTHING`,
        [space, setting.retention, setting.revision, now()]
      );
    },
    pending: async ({ limit = 100, cursor }) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, 'invalid_request');
      let sequence = '0';
      if (cursor !== undefined) {
        if (cursor.length > 64 || !/^[A-Za-z0-9_-]+$/.test(cursor)) fail(400, 'invalid_request');
        sequence = Buffer.from(cursor, 'base64url').toString('utf8');
        if (
          !REV.test(sequence) ||
          BigInt(sequence) > 9223372036854775807n ||
          Buffer.from(sequence).toString('base64url') !== cursor
        )
          fail(400, 'invalid_request');
      }
      return tx(async (client) => {
        await lockPlans(client);
        const rows = (
          await client.query<{
            id: string;
            sequence: string;
            reason: string;
            state: string;
            leadDays: number;
            settingsRevision: string;
            totalBytes: number;
          }>(
            `SELECT id,sequence::text,reason,state,lead_days AS "leadDays",settings_revision::text AS "settingsRevision",total_bytes::float8 AS "totalBytes" FROM storage.deletion_plans WHERE state='pending' AND sequence>$1 ORDER BY sequence LIMIT $2`,
            [sequence, limit + 1]
          )
        ).rows;
        const plans = rows.slice(0, limit);
        await client.query(
          'UPDATE storage.deletion_plans SET exposed_at=COALESCE(exposed_at,to_timestamp($2/1000.0)) WHERE id=ANY($1::text[])',
          [plans.map((plan) => plan.id), now()]
        );
        return {
          plans,
          nextCursor:
            rows.length > limit
              ? Buffer.from(String(plans.at(-1)?.sequence)).toString('base64url')
              : null,
        };
      });
    },
    warningCommitted: async (value) => {
      const raw = record(value);
      fields(raw, ['planId', 'messageId']);
      const planId = id(raw['planId']),
        messageId = id(raw['messageId']);
      return tx(async (client) => {
        const plan = (
          await client.query<{
            state: string;
            message_id: string | null;
            warning_receipt: Record<string, unknown> | null;
            lead_days: number;
          }>('SELECT * FROM storage.deletion_plans WHERE id=$1 FOR UPDATE', [planId])
        ).rows[0];
        if (!plan) fail(404, 'plan_not_found');
        if (plan.message_id) {
          if (plan.message_id !== messageId) fail(409, 'warning_conflict');
          return plan.warning_receipt ?? fail(503, 'catalog_unavailable');
        }
        if (plan.state !== 'pending') fail(409, 'plan_complete');
        const receipt = {
          id: randomUUID(),
          planId,
          messageId,
          earliestDeleteAt: new Date(now() + plan.lead_days * DAY).toISOString(),
        };
        await client.query(
          "UPDATE storage.deletion_plans SET state='warned',message_id=$2,warned_at=to_timestamp($3/1000.0),earliest_delete_at=to_timestamp($4/1000.0),warning_receipt=$5 WHERE id=$1",
          [planId, messageId, now(), now() + plan.lead_days * DAY, receipt]
        );
        return receipt;
      });
    },
    policy: async (value) => {
      const raw = record(value);
      const operation = raw['operation'];
      if (!['pin', 'unpin', 'retention'].includes(String(operation))) fail(400, 'invalid_request');
      fields(
        raw,
        operation === 'retention'
          ? ['space', 'effectKey', 'expectedRevision', 'operation', 'retention']
          : ['space', 'effectKey', 'expectedRevision', 'operation']
      );
      const space = id(raw['space'], true),
        effect = id(raw['effectKey']);
      const revision = raw['expectedRevision'];
      if (
        typeof revision !== 'string' ||
        !REV.test(revision) ||
        BigInt(revision) >= 9223372036854775807n
      )
        fail(400, 'invalid_request');
      if (operation === 'retention' && !['90d', 'forever'].includes(String(raw['retention'])))
        fail(400, 'invalid_request');
      return tx(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,9))', [effect]);
        const old = (
          await client.query<{
            request: Record<string, unknown>;
            receipt: Record<string, unknown>;
          }>('SELECT request,receipt FROM storage.retention_receipts WHERE effect_key=$1', [effect])
        ).rows[0];
        if (old) {
          if (Object.keys(raw).some((k) => old.request[k] !== raw[k])) fail(409, 'effect_conflict');
          return old.receipt;
        }
        const policy = (
          await client.query<{ revision: string; state: string }>(
            'SELECT revision::text,state FROM storage.retention_policies WHERE space_id=$1 FOR UPDATE',
            [space]
          )
        ).rows[0];
        if (!policy) fail(404, 'policy_not_found');
        if (policy.state !== 'retained') fail(409, 'already_deleting');
        if (policy.revision !== revision) fail(409, 'revision_conflict');
        await client.query(
          `UPDATE storage.retention_policies SET revision=revision+1,pinned=CASE WHEN $2='pin' THEN true WHEN $2='unpin' THEN false ELSE pinned END,retention=CASE WHEN $2='retention' THEN $3 ELSE retention END,expires_at=CASE WHEN $2='retention' THEN CASE WHEN $3='90d' THEN terminal_at+interval '90 days' ELSE NULL END ELSE expires_at END WHERE space_id=$1`,
          [space, operation, raw['retention'] ?? null]
        );
        const removed = await client.query<{ plan_id: string }>(
          "UPDATE storage.deletion_candidates SET state='removed' WHERE space_id=$1 AND state='pending' RETURNING plan_id",
          [space]
        );
        await totals(client, [...new Set(removed.rows.map((row) => row.plan_id))]);
        const receipt = {
          id: randomUUID(),
          space,
          effectKey: effect,
          revision: (BigInt(revision) + 1n).toString(),
        };
        await client.query(
          'INSERT INTO storage.retention_receipts(effect_key,request,receipt) VALUES($1,$2,$3)',
          [effect, raw, receipt]
        );
        return receipt;
      });
    },
    reclaim: async (value) => {
      const raw = record(value);
      fields(raw, ['effectKey', 'bytes']);
      const effect = id(raw['effectKey']);
      const bytes = raw['bytes'];
      if (
        typeof bytes !== 'number' ||
        !Number.isSafeInteger(bytes) ||
        bytes < 1 ||
        bytes > 20_000_000_000
      )
        fail(400, 'invalid_request');
      return tx(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,10))', [effect]);
        const saved = (
          await client.query<{ request: { bytes: number }; receipt: Record<string, unknown> }>(
            'SELECT request,receipt FROM storage.reclaim_receipts WHERE effect_key=$1',
            [effect]
          )
        ).rows[0];
        if (saved) {
          if (saved.request.bytes !== bytes) fail(409, 'effect_conflict');
          return saved.receipt;
        }
        const planId = await build('quota', bytes, client);
        const receipt = { id: randomUUID(), effectKey: effect, planId };
        await client.query(
          'INSERT INTO storage.reclaim_receipts(effect_key,request,receipt) VALUES($1,$2,$3)',
          [effect, raw, receipt]
        );
        return receipt;
      });
    },
    runOnce,
    start: schedule,
    check: async (signal) => {
      try {
        if (signal.aborted) return false;
        await tx(async (client) => {
          await client.query(
            'SELECT p.space_id,c.plan_id,r.effect_key,l.id,o.s3_key,t.object_id,rl.id FROM storage.retention_policies p,storage.deletion_candidates c,storage.deletion_plans d,storage.retention_receipts r,storage.instance_ledger l,storage.orphan_gc o,storage.retention_tombstones t,storage.read_leases rl,storage.attempt_gc ag,storage.reclaim_receipts rr WHERE false'
          );
        });
        return !signal.aborted;
      } catch {
        return false;
      }
    },
    close: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running?.catch(() => undefined);
      await pool.end();
    },
  };
}
