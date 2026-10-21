/** Module-owned allocation, verified binding and replayable seal. No caller SQL. */
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import {
  StorageAccessError,
  STORAGE_AUDIENCES,
  type StorageAccess,
  type StorageTaskStream,
} from './storage-access.js';
import type { StorageObjectS3 } from './storage-object-s3.js';
import type { StorageRetention } from './storage-retention.js';

interface Options {
  connectionString: string;
  s3: StorageObjectS3;
  access: StorageAccess;
  retention?: StorageRetention;
  now?: () => number;
}
interface Allocate {
  taskId: string;
  launchId: string;
  effectKey: string;
  retentionRevision: string;
}
interface Bind {
  space: string;
  taskId: string;
  attemptId: string;
  launchId: string;
  effectKey: string;
}
interface Seal {
  space: string;
  effectKey: string;
  expectedRevision: string;
  outcome: 'completed' | 'failed' | 'stopped';
}
interface Marked {
  id: string;
  name: string;
  size: number;
  sha256: string;
  mark: string;
}
interface Candidate extends Marked {
  s3_key: string;
}
interface Operation extends QueryResultRow {
  space_id: string;
  effect_key: string;
  request: Seal;
  receipt_id: string;
  manifest_id: string;
  revision: string;
  outcome: Seal['outcome'];
  state: string;
  candidates: Candidate[];
  checksum_recovery: boolean;
}
export interface StorageSeal {
  allocate(input: unknown): Promise<Record<string, unknown>>;
  bind(input: unknown): Promise<Record<string, unknown>>;
  seal(input: unknown): Promise<Record<string, unknown>>;
  openCoreStream(input: {
    token: string;
    space: string;
    objectId?: string;
    signal?: AbortSignal;
  }): StorageTaskStream;
  check(signal: AbortSignal): Promise<boolean>;
  close(): Promise<void>;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SPACE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REV = /^(0|[1-9][0-9]{0,18})$/;
const MAX = 9223372036854775807n;
function fail(status: number, code: string): never {
  throw new StorageAccessError(status, code);
}
function input(value: unknown, keys: string[]): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_request');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((k) => typeof row[k] !== 'string'))
    fail(400, 'invalid_request');
  for (const key of keys) {
    const v = row[key] as string;
    if (key === 'expectedRevision') {
      if (!REV.test(v) || BigInt(v) >= MAX) fail(400, 'invalid_request');
    } else if (key === 'outcome') {
      if (!['completed', 'failed', 'stopped'].includes(v)) fail(400, 'invalid_request');
    } else if (!(key === 'space' ? SPACE : ID).test(v)) fail(400, 'invalid_request');
  }
  return row as Record<string, string>;
}
function required<T>(value: T | undefined): T {
  if (value === undefined) return fail(503, 'catalog_unavailable');
  return value;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function createStorageSeal(options: Options): StorageSeal {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: 4,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    statement_timeout: 5000,
    lock_timeout: 5000,
    application_name: 'lifemodel-storage-seal',
  });
  pool.on('error', () => undefined);
  pool.on('connect', (client) => client.on('error', () => undefined));
  async function tx<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient | undefined;
    let broken = false;
    const onError = () => {
      broken = true;
    };
    try {
      client = await pool.connect();
      client.on('error', onError);
      await client.query('BEGIN');
      const result = await run(client);
      if (broken) fail(503, 'catalog_unavailable');
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => undefined);
      if (error instanceof StorageAccessError) throw error;
      return fail(503, 'catalog_unavailable');
    } finally {
      client?.removeListener('error', onError);
      client?.release(broken);
    }
  }
  async function key(
    client: PoolClient,
    operation: 'allocate' | 'bind' | 'seal',
    effect: string,
    space?: string
  ) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      JSON.stringify([operation, space ?? null, effect]),
    ]);
  }
  async function replay(
    client: PoolClient,
    table: 'allocate_receipts' | 'bind_receipts',
    effect: string,
    request: unknown
  ) {
    const row = (
      await client.query<{ request: unknown; receipt: Record<string, unknown> }>(
        `SELECT request,receipt FROM storage.${table} WHERE effect_key=$1`,
        [effect]
      )
    ).rows[0];
    // JSONB normalizes key order; compare structural fields rather than string order.
    if (row) {
      if (!equal(row.request, request)) fail(409, 'effect_conflict');
      return row.receipt;
    }
    return undefined;
  }
  function equal(a: unknown, b: unknown): boolean {
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a === b;
    const aa = a as Record<string, unknown>,
      bb = b as Record<string, unknown>;
    const keys = Object.keys(aa).sort();
    return same(keys, Object.keys(bb).sort()) && keys.every((k) => equal(aa[k], bb[k]));
  }
  async function operation(client: PoolClient, request: Seal): Promise<Operation> {
    await key(client, 'seal', request.effectKey, request.space);
    const old = (
      await client.query<Operation>(
        'SELECT * FROM storage.seal_operations WHERE space_id=$1 AND effect_key=$2',
        [request.space, request.effectKey]
      )
    ).rows[0];
    if (old) {
      if (!equal(old.request, request)) fail(409, 'effect_conflict');
      return old;
    }
    const space = (
      await client.query<{ access_revision: string; mode: string }>(
        'SELECT access_revision::text,mode FROM storage.spaces WHERE id=$1 FOR UPDATE',
        [request.space]
      )
    ).rows[0];
    if (!space) fail(404, 'space_not_found');
    if (space.access_revision !== request.expectedRevision) fail(409, 'revision_conflict');
    const previous = (
      await client.query<Operation>(
        'SELECT * FROM storage.seal_operations WHERE space_id=$1 FOR UPDATE',
        [request.space]
      )
    ).rows[0];
    if (previous) {
      if (
        space.mode !== 'frozen' ||
        previous.state !== 'frozen' ||
        request.outcome === 'completed' ||
        (
          await client.query('SELECT 1 FROM storage.seal_manifests WHERE space_id=$1', [
            request.space,
          ])
        ).rowCount
      )
        fail(409, 'seal_conflict');
      // Explicit failed/stopped recovery changes the outcome, never the frozen
      // candidate set or access revision. Old requests cannot publish over it.
      return required(
        (
          await client.query<Operation>(
            'UPDATE storage.seal_operations SET effect_key=$2,request=$3,outcome=$4,checksum_recovery=true WHERE space_id=$1 RETURNING *',
            [request.space, request.effectKey, request, request.outcome]
          )
        ).rows[0]
      );
    }
    if (!['open', 'wrapping', 'revoked'].includes(space.mode)) fail(409, 'seal_conflict');
    const revision = (BigInt(space.access_revision) + 1n).toString();
    // This row lock is the bounded quiescence barrier: every publication/mark
    // holds FOR SHARE through commit. Hard stop does not await any byte stream.
    await client.query("UPDATE storage.spaces SET mode='frozen',access_revision=$2 WHERE id=$1", [
      request.space,
      revision,
    ]);
    await options.retention?.snapshot(client, request.space);
    const candidates = (
      await client.query<Candidate>(
        `SELECT o.id::text,o.name,o.size::float8 AS size,o.sha256,o.mark,a.s3_key FROM storage.objects o JOIN storage.object_versions v ON v.object_id=o.id JOIN storage.upload_attempts a ON a.id=v.attempt_id WHERE o.space_id=$1 AND o.mark IS NOT NULL ORDER BY o.id`,
        [request.space]
      )
    ).rows;
    if (
      request.outcome === 'completed' &&
      !candidates.some((candidate) => candidate.mark === 'result')
    )
      fail(409, 'missing_result');
    const result = await client.query<Operation>(
      `INSERT INTO storage.seal_operations(space_id,effect_key,request,receipt_id,manifest_id,revision,outcome,state,candidates) VALUES($1,$2,$3,$4,$5,$6,$7,'frozen',$8) RETURNING *`,
      [
        request.space,
        request.effectKey,
        request,
        randomUUID(),
        randomUUID(),
        revision,
        request.outcome,
        JSON.stringify(candidates),
      ]
    );
    return required(result.rows[0]);
  }
  return {
    allocate: async (value) => {
      const raw = input(value, ['taskId', 'launchId', 'effectKey', 'retentionRevision']);
      const request = {
        taskId: required(raw['taskId']),
        launchId: required(raw['launchId']),
        effectKey: required(raw['effectKey']),
        retentionRevision: required(raw['retentionRevision']),
      } satisfies Allocate;
      return tx(async (client) => {
        await key(client, 'allocate', request.effectKey);
        const saved = await replay(client, 'allocate_receipts', request.effectKey, request);
        if (saved) return saved;
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))', [
          request.launchId,
        ]);
        let allocation = (
          await client.query<{ task_id: string; space_id: string; retention_revision: string }>(
            'SELECT * FROM storage.allocations WHERE launch_id=$1',
            [request.launchId]
          )
        ).rows[0];
        if (
          allocation &&
          (allocation.task_id !== request.taskId ||
            allocation.retention_revision !== request.retentionRevision)
        )
          fail(409, 'launch_conflict');
        if (!allocation) {
          const space = randomUUID();
          await client.query('INSERT INTO storage.spaces(id) VALUES($1)', [space]);
          await client.query(
            'INSERT INTO storage.allocations(launch_id,task_id,space_id,retention_revision) VALUES($1,$2,$3,$4)',
            [request.launchId, request.taskId, space, request.retentionRevision]
          );
          allocation = {
            task_id: request.taskId,
            space_id: space,
            retention_revision: request.retentionRevision,
          };
        }
        const receipt = {
          id: randomUUID(),
          space: allocation.space_id,
          effectKey: request.effectKey,
        };
        await client.query(
          'INSERT INTO storage.allocate_receipts(effect_key,request,receipt,space_id) VALUES($1,$2,$3,$4)',
          [request.effectKey, request, receipt, allocation.space_id]
        );
        return receipt;
      });
    },
    bind: async (value) => {
      const raw = input(value, ['space', 'taskId', 'attemptId', 'launchId', 'effectKey']);
      const request = {
        space: required(raw['space']),
        taskId: required(raw['taskId']),
        attemptId: required(raw['attemptId']),
        launchId: required(raw['launchId']),
        effectKey: required(raw['effectKey']),
      } satisfies Bind;
      // Receipt replay is independent of later Pod death; it grants no new access.
      const saved = await tx(async (client) => {
        await key(client, 'bind', request.effectKey);
        const saved = await replay(client, 'bind_receipts', request.effectKey, request);
        if (saved) return saved;
        const bound = (
          await client.query<{ task_id: string; attempt_id: string; launch_id: string }>(
            'SELECT * FROM storage.bindings WHERE space_id=$1',
            [request.space]
          )
        ).rows[0];
        if (
          bound &&
          (bound.task_id !== request.taskId ||
            bound.attempt_id !== request.attemptId ||
            bound.launch_id !== request.launchId)
        )
          fail(409, 'binding_conflict');
        return undefined;
      });
      if (saved) return saved;
      const projection = await tx(
        async (client) =>
          (
            await client.query<{
              pod_name: string;
              job_name: string;
              pod_uid: string;
              job_uid: string;
              access_revision: string;
            }>(
              `SELECT p.* FROM task_access.projections p JOIN task_access.intents i USING(task_id,attempt_id,launch_id) WHERE p.space_id=$1 AND p.task_id=$2 AND p.attempt_id=$3 AND p.launch_id=$4 AND i.mode<>'revoked' AND p.mode<>'revoked' AND p.intent_revision<=i.revision AND clock_timestamp()<i.hard_stop_at`,
              [request.space, request.taskId, request.attemptId, request.launchId]
            )
          ).rows[0]
      );
      if (!projection?.pod_name || !projection.job_name) fail(403, 'binding_denied');
      await options.access.identity.verifyBinding({
        podName: projection.pod_name,
        jobName: projection.job_name,
        podUid: projection.pod_uid,
        jobUid: projection.job_uid,
      });
      return tx(async (client) => {
        await key(client, 'bind', request.effectKey);
        const saved = await replay(client, 'bind_receipts', request.effectKey, request);
        if (saved) return saved;
        const proof = await client.query(
          `SELECT p.space_id FROM task_access.intents i JOIN task_access.projections p USING(task_id,attempt_id,launch_id) WHERE p.space_id=$1 AND p.task_id=$2 AND p.attempt_id=$3 AND p.launch_id=$4 AND p.pod_uid=$5 AND p.job_uid=$6 AND p.pod_name=$7 AND p.job_name=$8 AND i.mode<>'revoked' AND p.mode<>'revoked' AND p.intent_revision<=i.revision AND clock_timestamp()<i.hard_stop_at FOR SHARE OF i,p`,
          [
            request.space,
            request.taskId,
            request.attemptId,
            request.launchId,
            projection.pod_uid,
            projection.job_uid,
            projection.pod_name,
            projection.job_name,
          ]
        );
        if (proof.rowCount !== 1) fail(403, 'binding_denied');
        const space = (
          await client.query<{ access_revision: string; mode: string }>(
            'SELECT access_revision::text,mode FROM storage.spaces WHERE id=$1 FOR UPDATE',
            [request.space]
          )
        ).rows[0];
        if (!space || !['open', 'wrapping'].includes(space.mode)) fail(409, 'binding_conflict');
        if (space.access_revision !== projection.access_revision) fail(403, 'binding_denied');
        const current = (
          await client.query(
            `SELECT 1 FROM task_access.projections p JOIN task_access.intents i USING(task_id,attempt_id,launch_id) WHERE p.space_id=$1 AND p.task_id=$2 AND p.attempt_id=$3 AND p.launch_id=$4 AND p.access_revision=$5 AND p.intent_revision<=i.revision AND i.mode<>'revoked' AND p.mode<>'revoked' AND clock_timestamp()<i.hard_stop_at`,
            [
              request.space,
              request.taskId,
              request.attemptId,
              request.launchId,
              space.access_revision,
            ]
          )
        ).rowCount;
        if (current !== 1) fail(403, 'binding_denied');
        const allocation = (
          await client.query(
            'SELECT 1 FROM storage.allocations WHERE space_id=$1 AND task_id=$2 AND launch_id=$3',
            [request.space, request.taskId, request.launchId]
          )
        ).rowCount;
        if (!allocation) fail(409, 'binding_conflict');
        const old = (
          await client.query<Record<string, string>>(
            'SELECT * FROM storage.bindings WHERE space_id=$1',
            [request.space]
          )
        ).rows[0];
        if (
          old &&
          (old['task_id'] !== request.taskId ||
            old['attempt_id'] !== request.attemptId ||
            old['launch_id'] !== request.launchId ||
            old['pod_uid'] !== projection.pod_uid ||
            old['job_uid'] !== projection.job_uid)
        )
          fail(409, 'binding_conflict');
        await client.query(
          'INSERT INTO storage.bindings(space_id,task_id,attempt_id,launch_id,pod_uid,job_uid) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
          [
            request.space,
            request.taskId,
            request.attemptId,
            request.launchId,
            projection.pod_uid,
            projection.job_uid,
          ]
        );
        const receipt = {
          id: randomUUID(),
          space: request.space,
          effectKey: request.effectKey,
          revision: space.access_revision,
        };
        await client.query(
          'INSERT INTO storage.bind_receipts(effect_key,request,receipt,space_id) VALUES($1,$2,$3,$4)',
          [request.effectKey, request, receipt, request.space]
        );
        return receipt;
      });
    },
    seal: async (value) => {
      const raw = input(value, ['space', 'effectKey', 'expectedRevision', 'outcome']);
      const request = {
        space: required(raw['space']),
        effectKey: required(raw['effectKey']),
        expectedRevision: required(raw['expectedRevision']),
        outcome: required(raw['outcome']) as Seal['outcome'],
      };
      const savedReceipt = await tx(async (client) => {
        await key(client, 'seal', request.effectKey, request.space);
        const saved = (
          await client.query<{ request: Seal; receipt: Record<string, unknown> }>(
            'SELECT o.request,r.receipt FROM storage.seal_operations o JOIN storage.seal_receipts r ON r.space_id=o.space_id AND r.effect_key=o.effect_key WHERE o.space_id=$1 AND o.effect_key=$2',
            [request.space, request.effectKey]
          )
        ).rows[0];
        if (saved && !equal(saved.request, request)) fail(409, 'effect_conflict');
        return saved?.receipt;
      });
      if (savedReceipt) return savedReceipt;
      if (request.outcome !== 'stopped') await options.access.quiesceSpace(request.space);
      let op = await tx((client) => operation(client, request));
      await options.access.settleSpace(request.space);
      await options.s3.settle(request.space, AbortSignal.timeout(5000));
      if (op.state === 'frozen') {
        const objects: Marked[] = [];
        const excluded: (Marked & { reason: 'checksum_mismatch' })[] = [];
        for (const candidate of op.candidates) {
          const key = candidate.s3_key;
          // JSONB normalizes field order; rebuild the documented digest order.
          const marked: Marked = {
            id: candidate.id,
            name: candidate.name,
            size: candidate.size,
            sha256: candidate.sha256,
            mark: candidate.mark,
          };
          try {
            await options.s3.verify(
              request.space,
              key,
              candidate.size,
              candidate.sha256,
              AbortSignal.timeout(10_000)
            );
            objects.push(marked);
          } catch (error) {
            if (
              !op.checksum_recovery ||
              request.outcome === 'completed' ||
              !(error instanceof StorageAccessError) ||
              error.code !== 'checksum_mismatch'
            )
              throw error;
            excluded.push({ ...marked, reason: 'checksum_mismatch' });
          }
        }
        const hasResult = objects.some((o) => o.mark === 'result');
        if (request.outcome === 'completed' && !hasResult) fail(409, 'missing_result');
        const reason = excluded.length
          ? 'checksum_mismatch'
          : request.outcome === 'completed'
            ? null
            : request.outcome === 'failed'
              ? hasResult
                ? 'partial_output'
                : 'missing_result'
              : hasResult
                ? 'stopped_partial_output'
                : 'stopped_missing_result';
        const sha256 = createHash('sha256')
          .update(JSON.stringify({ version: 1, objects, ...(excluded.length ? { excluded } : {}) }))
          .digest('hex');
        op = await tx(async (client) => {
          await key(client, 'seal', request.effectKey, request.space);
          const current = required(
            (
              await client.query<Operation>(
                'SELECT * FROM storage.seal_operations WHERE space_id=$1 FOR UPDATE',
                [request.space]
              )
            ).rows[0]
          );
          if (!equal(current.request, request)) fail(409, 'effect_conflict');
          if (current.state !== 'frozen') return current;
          await client.query(
            'INSERT INTO storage.seal_manifests(space_id,id,version,sha256,objects,excluded,reason) VALUES($1,$2,1,$3,$4,$5,$6)',
            [
              request.space,
              current.manifest_id,
              sha256,
              JSON.stringify(objects),
              JSON.stringify(excluded),
              reason,
            ]
          );
          return required(
            (
              await client.query<Operation>(
                "UPDATE storage.seal_operations SET state='manifest-committed' WHERE space_id=$1 RETURNING *",
                [request.space]
              )
            ).rows[0]
          );
        });
      }
      if (op.state === 'manifest-committed' || op.state === 'cleanup') {
        await tx(async (client) => {
          await key(client, 'seal', request.effectKey, request.space);
          await client.query(
            `INSERT INTO storage.seal_gc(space_id,attempt_id,s3_key) SELECT a.space_id,a.id,a.s3_key FROM storage.upload_attempts a WHERE a.space_id=$1 AND NOT EXISTS(SELECT 1 FROM storage.object_versions v JOIN storage.objects o ON o.id=v.object_id WHERE v.attempt_id=a.id AND o.id::text IN (SELECT item->>'id' FROM storage.seal_manifests m CROSS JOIN LATERAL jsonb_array_elements(m.objects) item WHERE m.space_id=$1)) ON CONFLICT DO NOTHING`,
            [request.space]
          );
          await client.query(
            "UPDATE storage.seal_operations SET state='cleanup' WHERE space_id=$1 AND state='manifest-committed'",
            [request.space]
          );
        });
        const entries = await tx(
          async (client) =>
            (
              await client.query<{ attempt_id: string; s3_key: string }>(
                'SELECT attempt_id,s3_key FROM storage.seal_gc WHERE space_id=$1 AND NOT deleted ORDER BY attempt_id',
                [request.space]
              )
            ).rows
        );
        for (const entry of entries) {
          try {
            await options.s3.delete(request.space, entry.s3_key, AbortSignal.timeout(10_000));
          } catch {
            fail(503, 'cleanup_pending');
          }
          await tx(async (client) => {
            await client.query(
              'UPDATE storage.seal_gc SET deleted=true WHERE space_id=$1 AND attempt_id=$2',
              [request.space, entry.attempt_id]
            );
          });
        }
        await tx(async (client) => {
          await key(client, 'seal', request.effectKey, request.space);
          if (
            (
              await client.query(
                'SELECT 1 FROM storage.seal_gc WHERE space_id=$1 AND NOT deleted LIMIT 1',
                [request.space]
              )
            ).rowCount
          )
            fail(503, 'cleanup_pending');
          await client.query(
            `INSERT INTO storage.object_tombstones(object_id,space_id,reason) SELECT id,space_id,'seal_unmarked' FROM storage.objects WHERE space_id=$1 AND id::text NOT IN (SELECT item->>'id' FROM storage.seal_manifests m CROSS JOIN LATERAL jsonb_array_elements(m.objects) item WHERE m.space_id=$1) ON CONFLICT DO NOTHING`,
            [request.space]
          );
          // Keep catalog object/version/upload identities as tombstones. Reads exclude
          // them and quota is charged only for manifest-retained immutable bytes.
          await client.query(`UPDATE storage.upload_intents SET reserved=false WHERE space_id=$1`, [
            request.space,
          ]);
          await client.query(
            `UPDATE storage.space_quota SET reserved_bytes=0,charged_bytes=(SELECT COALESCE(sum(size),0) FROM storage.objects WHERE space_id=$1 AND id::text IN (SELECT item->>'id' FROM storage.seal_manifests m CROSS JOIN LATERAL jsonb_array_elements(m.objects) item WHERE m.space_id=$1)) WHERE space_id=$1`,
            [request.space]
          );
          await client.query("UPDATE storage.spaces SET mode='sealed' WHERE id=$1", [
            request.space,
          ]);
          await client.query(
            "UPDATE storage.seal_operations SET state='sealed' WHERE space_id=$1",
            [request.space]
          );
        });
      }
      return tx(async (client) => {
        await key(client, 'seal', request.effectKey, request.space);
        const saved = (
          await client.query<{ receipt: Record<string, unknown> }>(
            'SELECT receipt FROM storage.seal_receipts WHERE space_id=$1 AND effect_key=$2',
            [request.space, request.effectKey]
          )
        ).rows[0];
        if (saved) return saved.receipt;
        const manifest = required(
          (
            await client.query<{
              id: string;
              version: string;
              sha256: string;
              objects: Marked[];
              excluded: (Marked & { reason: 'checksum_mismatch' })[];
              reason: string | null;
            }>('SELECT * FROM storage.seal_manifests WHERE space_id=$1', [request.space])
          ).rows[0]
        );
        const receipt = {
          id: op.receipt_id,
          space: request.space,
          effectKey: request.effectKey,
          revision: op.revision,
          outcome: op.outcome,
          state: 'sealed',
          reason: manifest.reason,
          manifest: {
            id: manifest.id,
            version: Number(manifest.version),
            sha256: manifest.sha256,
            objects: manifest.objects,
            ...(manifest.excluded.length ? { excluded: manifest.excluded } : {}),
          },
        };
        await client.query(
          'INSERT INTO storage.seal_receipts(effect_key,space_id,receipt) VALUES($1,$2,$3)',
          [request.effectKey, request.space, receipt]
        );
        return receipt;
      });
    },
    openCoreStream: ({ token, space, objectId, signal: parent }) => {
      if (!SPACE.test(space)) fail(400, 'invalid_request');
      const lease = randomUUID();
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, ...(parent ? [parent] : [])]);
      return {
        signal,
        close: () => {
          controller.abort();
          if (options.retention)
            void tx(async (client) => {
              await client.query('DELETE FROM storage.read_leases WHERE id=$1', [lease]);
            }).catch(() => undefined);
        },
        publish: () => Promise.reject(new StorageAccessError(403, 'read_only')),
        chunk: async (bytes, dispatch) => {
          if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 4 * 1024 * 1024)
            fail(400, 'invalid_chunk');
          signal.throwIfAborted();
          const identity = await options.access.identity.verify(
            token,
            [STORAGE_AUDIENCES.read[0]],
            signal
          );
          if (identity.role !== 'core') fail(403, 'identity_denied');
          await tx(async (client) => {
            const row = (
              await client.query<{ id: string; revision: string; mode: string }>(
                'SELECT id,access_revision::text AS revision,mode FROM storage.spaces WHERE id=$1 FOR SHARE',
                [space]
              )
            ).rows[0];
            if (!row) fail(404, 'space_not_found');
            if (options.retention) {
              const policy = (
                await client.query<{ state: string }>(
                  'SELECT state FROM storage.retention_policies WHERE space_id=$1',
                  [space]
                )
              ).rows[0];
              if (policy && policy.state !== 'retained') fail(404, 'object_not_found');
              await client.query(
                'INSERT INTO storage.read_leases(id,space_id,expires_at) VALUES($1,$2,to_timestamp($3/1000.0)) ON CONFLICT(id) DO UPDATE SET expires_at=EXCLUDED.expires_at',
                [lease, space, (options.now ?? Date.now)() + 30000]
              );
            }
            if (
              objectId &&
              !(
                await client.query(
                  `SELECT 1 FROM storage.objects o WHERE o.space_id=$1 AND o.id::text=$2 AND o.mark IS NOT NULL AND NOT EXISTS(SELECT 1 FROM storage.object_tombstones t WHERE t.object_id=o.id)`,
                  [space, objectId]
                )
              ).rowCount
            )
              fail(404, 'object_not_found');
            signal.throwIfAborted();
            if (dispatch.constructor.name === 'AsyncFunction')
              fail(500, 'async_dispatch_forbidden');
            if (
              (dispatch as (value: unknown) => unknown)({
                space,
                revision: row.revision,
                mode: row.mode,
              }) !== undefined
            )
              fail(500, 'async_dispatch_forbidden');
          });
        },
      };
    },
    check: async (signal) => {
      try {
        if (signal.aborted) return false;
        await tx(async (client) => {
          await client.query(
            'SELECT r.receipt FROM storage.seal_receipts r,storage.allocations a,storage.allocate_receipts ar,storage.bindings b,storage.bind_receipts br,storage.seal_operations o,storage.seal_manifests m,storage.seal_gc g,storage.object_tombstones t WHERE false'
          );
        });
        return !signal.aborted;
      } catch {
        return false;
      }
    },
    close: () => pool.end(),
  };
}
