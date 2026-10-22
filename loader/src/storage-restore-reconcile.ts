/** Offline restore pages. Byte classification is not a seal replay or a deletion pass. */
import { createHash } from 'node:crypto';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Client } from 'pg';
import { StorageAccessError } from './storage-access-error.js';
import { createStorageObjectS3, type StorageObjectS3Options } from './storage-object-s3.js';
import { signS3Request } from './storage-s3.js';

export interface StorageRestoreProgress {
  generation: string;
  cursor: string | null;
  complete: boolean;
  unavailable: number;
  /** Versions checked by this call, not a durable total. */
  checked: number;
}
export interface StorageRestoreReconciler {
  begin(generation: string, artifactSha256?: string): Promise<StorageRestoreProgress>;
  reconcile(generation: string): Promise<StorageRestoreProgress>;
  close(): Promise<void>;
}
export interface StorageRestoreReconcileOptions {
  connectionString: string;
  s3: Pick<StorageObjectS3Options, 'endpoint' | 'bucket' | 'custody'>;
  pageSize?: number;
  /** One total page deadline, including SQL and S3, never refreshed by progress. */
  timeoutMs?: number;
}
type Availability = 'available' | 'missing' | 'corrupt';
interface Version {
  object_id: string;
  s3_key: string;
  size: string;
  sha256: string;
}
interface Marked {
  id: string;
  name: string;
  size: number;
  sha256: string;
  mark: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CHUNK = 4 * 1024 * 1024;
const ignore = (): void => undefined;
function fail(code: string, status = 503): never {
  throw new StorageAccessError(status, code);
}
function generationId(generation: string): void {
  if (!UUID.test(generation)) fail('invalid_request', 400);
}
function marked(value: Marked): Marked {
  // JSONB key ordering is not the documented manifest digest ordering.
  return {
    id: value.id,
    name: value.name,
    size: value.size,
    sha256: value.sha256,
    mark: value.mark,
  };
}

export function createStorageRestoreReconciler(
  options: StorageRestoreReconcileOptions
): StorageRestoreReconciler {
  const pageSize = options.pageSize ?? 100;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const endpoint = new URL(options.s3.endpoint);
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 10_000 ||
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash ||
    !/^[a-z0-9][a-z0-9.-]{0,62}$/.test(options.s3.bucket)
  )
    fail('invalid_request', 400);
  let closed = false;
  const active = new Set<AbortController>();
  const inventory = createStorageObjectS3({ ...options.s3, timeoutMs });

  async function run<T>(
    generation: string,
    work: (client: Client, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    generationId(generation);
    if (closed) fail('catalog_unavailable');
    const controller = new AbortController();
    active.add(controller);
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    timer.unref();
    const client = new Client({
      connectionString: options.connectionString,
      connectionTimeoutMillis: timeoutMs,
      query_timeout: timeoutMs,
      statement_timeout: timeoutMs,
      lock_timeout: timeoutMs,
      application_name: 'lifemodel-storage-restore',
    });
    // A lost SQL session must also terminate the associated S3 transport.
    client.on('error', () => {
      controller.abort();
    });
    const abort = (): void => {
      void client.end().catch(ignore);
    };
    controller.signal.addEventListener('abort', abort, { once: true });
    try {
      await client.connect();
      const lock = await client.query<{ held: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1,653740017)) AS held',
        [generation]
      );
      if (!lock.rows[0]?.held) fail('restore_pending');
      return await work(client, controller.signal);
    } catch (error) {
      if (error instanceof StorageAccessError) throw error;
      fail('catalog_unavailable');
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
      active.delete(controller);
      await client.end().catch(ignore);
    }
  }
  async function guard(client: Client, generation: string): Promise<void> {
    const row = (
      await client.query<{ generation: string; purpose: string; state: string }>(
        'SELECT generation,purpose,state FROM storage.maintenance WHERE id FOR UPDATE'
      )
    ).rows[0];
    if (
      row?.generation !== generation ||
      row.purpose !== 'restore' ||
      !['held', 'reconciling'].includes(row.state)
    )
      fail('restore_generation_conflict', 409);
  }
  async function progress(
    client: Client,
    generation: string,
    checked = 0
  ): Promise<StorageRestoreProgress> {
    const row = (
      await client.query<{ cursor: string | null; complete: boolean; unavailable: number }>(
        'SELECT cursor,complete,unavailable::float8 AS unavailable FROM storage.restore_progress WHERE generation=$1',
        [generation]
      )
    ).rows[0];
    if (!row) fail('restore_pending');
    return {
      generation,
      cursor: row.cursor,
      complete: row.complete,
      unavailable: row.unavailable,
      checked,
    };
  }
  async function transaction<T>(client: Client, work: () => Promise<T>): Promise<T> {
    await client.query('BEGIN');
    try {
      const value = await work();
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(ignore);
      throw error;
    }
  }
  async function verify(version: Version, signal: AbortSignal): Promise<Availability> {
    if (!/^private\/[0-9a-f-]{36}$/.test(version.s3_key)) fail('restore_pending');
    const url = new URL(`/${options.s3.bucket}/${version.s3_key}`, endpoint);
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    const abort = (): void => {
      request?.destroy();
      response?.destroy();
    };
    signal.addEventListener('abort', abort, { once: true });
    // Custody is external I/O as well; it must not outlive the page deadline.
    function wait<T>(promise: Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const canceled = (): void => {
          reject(new StorageAccessError(503, 'object_store_unavailable'));
        };
        signal.addEventListener('abort', canceled, { once: true });
        void promise.then(
          (value) => {
            signal.removeEventListener('abort', canceled);
            if (signal.aborted) canceled();
            else resolve(value);
          },
          (_error: unknown) => {
            signal.removeEventListener('abort', canceled);
            reject(new StorageAccessError(503, 'object_store_unavailable'));
          }
        );
        if (signal.aborted) canceled();
      });
    }
    try {
      const credentials = await wait(options.s3.custody.read());
      const headers = signS3Request({
        method: 'GET',
        url,
        credentials,
        now: new Date(),
        headers: {},
      });
      response = await wait(
        new Promise<IncomingMessage>((resolve, reject) => {
          request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
            url,
            { method: 'GET', headers, agent: false },
            (res) => {
              res.on('error', ignore);
              response = res;
              resolve(res);
            }
          );
          request.on('error', reject);
          request.on('socket', (socket) => socket.on('error', ignore));
          request.on('close', () => {
            if (!response) reject(new Error('closed'));
          });
          if (signal.aborted) request.destroy();
          else request.end();
        })
      );
      if (response.statusCode === 404) return 'missing';
      if (response.statusCode !== 200) fail('object_store_unavailable');
      const digest = createHash('sha256');
      let bytes = 0;
      const iterator = response[Symbol.asyncIterator]();
      for (;;) {
        const next = await wait(iterator.next());
        if (next.done) break;
        const chunk: unknown = next.value;
        if (!Buffer.isBuffer(chunk)) fail('object_store_unavailable');
        // Never aggregate the body. Even unusually large transport chunks are
        // presented to the digest in at most 4 MiB slices.
        for (let offset = 0; offset < chunk.length; offset += MAX_CHUNK) {
          const part = chunk.subarray(offset, offset + MAX_CHUNK);
          bytes += part.length;
          digest.update(part);
        }
        if (bytes > 20_000_000_000) return 'corrupt';
      }
      if (signal.aborted) fail('object_store_unavailable');
      return bytes === Number(version.size) && digest.digest('hex') === version.sha256
        ? 'available'
        : 'corrupt';
    } catch {
      fail('object_store_unavailable');
    } finally {
      signal.removeEventListener('abort', abort);
      abort();
    }
  }

  async function validate(client: Client): Promise<void> {
    // Never regenerate plan IDs, receipts, tombstones, marks or warning clocks.
    const broken = await client.query(`SELECT 1 WHERE
      EXISTS(SELECT 1 FROM storage.objects o LEFT JOIN storage.object_versions v ON v.object_id=o.id WHERE v.object_id IS NULL) OR
      EXISTS(SELECT 1 FROM storage.object_versions v JOIN storage.objects o ON o.id=v.object_id JOIN storage.upload_attempts a ON a.id=v.attempt_id JOIN storage.upload_intents i ON i.space_id=a.space_id AND i.upload_id=a.upload_id
        WHERE o.space_id<>a.space_id OR i.object_id<>o.id OR i.state<>'completed' OR i.size<>o.size OR i.sha256<>o.sha256) OR
      EXISTS(SELECT 1 FROM storage.object_tombstones t LEFT JOIN storage.objects o ON o.id=t.object_id WHERE o.id IS NULL OR o.space_id<>t.space_id) OR
      EXISTS(SELECT 1 FROM storage.seal_operations op LEFT JOIN storage.seal_manifests m USING(space_id)
        WHERE (op.state<>'frozen' AND (m.id IS NULL OR m.id<>op.manifest_id)) OR (op.state='frozen' AND m.id IS NOT NULL)) OR
      EXISTS(SELECT 1 FROM storage.spaces s WHERE s.mode='sealed' AND NOT EXISTS(SELECT 1 FROM storage.seal_operations op WHERE op.space_id=s.id AND op.state='sealed')) OR
      EXISTS(SELECT 1 FROM storage.deletion_candidates c JOIN storage.objects o ON o.id=c.object_id
        JOIN storage.retention_policies p ON p.space_id=c.space_id LEFT JOIN storage.object_versions v ON v.object_id=o.id LEFT JOIN storage.upload_attempts a ON a.id=v.attempt_id
        WHERE c.state<>'removed' AND (c.space_id<>o.space_id OR c.object_revision<>o.sequence OR c.policy_revision>p.revision OR c.size<>o.size OR c.s3_key IS DISTINCT FROM a.s3_key)) OR
      EXISTS(SELECT 1 FROM storage.retention_tombstones t LEFT JOIN storage.deletion_candidates c ON c.plan_id=t.plan_id AND c.object_id=t.object_id
        WHERE c.object_id IS NULL OR c.space_id<>t.space_id OR c.state<>t.state) OR
      EXISTS(SELECT 1 FROM storage.deletion_candidates c WHERE c.state IN ('deleting','deleted') AND NOT EXISTS(
        SELECT 1 FROM storage.retention_tombstones t WHERE t.plan_id=c.plan_id AND t.object_id=c.object_id AND t.state=c.state)) OR
      EXISTS(SELECT 1 FROM storage.seal_receipts r JOIN storage.seal_operations op USING(space_id) JOIN storage.seal_manifests m USING(space_id)
        WHERE r.effect_key<>op.effect_key OR r.receipt IS DISTINCT FROM jsonb_build_object(
          'id',op.receipt_id,'space',op.space_id,'effectKey',op.effect_key,'revision',op.revision::text,
          'outcome',op.outcome,'state','sealed','reason',m.reason,
          'manifest',jsonb_build_object('id',m.id,'version',m.version,'sha256',m.sha256,'objects',m.objects)
            || CASE WHEN jsonb_array_length(m.excluded)>0 THEN jsonb_build_object('excluded',m.excluded) ELSE '{}'::jsonb END)) OR
      EXISTS(SELECT 1 FROM storage.deletion_plans p WHERE p.total_bytes<>(SELECT COALESCE(sum(c.size),0) FROM storage.deletion_candidates c WHERE c.plan_id=p.id AND c.state<>'removed')) OR
      EXISTS(SELECT 1 FROM storage.deletion_plans p WHERE
        (p.state='warned' AND p.warning_receipt IS NULL) OR
        (p.warning_receipt IS NOT NULL AND (p.warning_receipt->>'id' IS NULL OR p.warning_receipt->>'planId' IS DISTINCT FROM p.id OR
        p.warning_receipt->>'messageId' IS DISTINCT FROM p.message_id OR p.earliest_delete_at<p.warned_at+make_interval(days=>p.lead_days) OR
        (p.warning_receipt->>'earliestDeleteAt')::timestamptz>p.earliest_delete_at)))`);
    if (broken.rowCount) fail('restore_pending');
    let cursor = '';
    for (;;) {
      const manifests = (
        await client.query<{
          space_id: string;
          sha256: string;
          objects: Marked[];
          excluded: (Marked & { reason: string })[];
        }>('SELECT * FROM storage.seal_manifests WHERE space_id>$1 ORDER BY space_id LIMIT 100', [
          cursor,
        ])
      ).rows;
      for (const manifest of manifests) {
        if (!Array.isArray(manifest.objects) || !Array.isArray(manifest.excluded))
          fail('restore_pending');
        const objects = manifest.objects.map(marked);
        const excluded = (manifest.excluded as (Marked & { reason: string })[]).map((value) => ({
          ...marked(value),
          reason: value.reason,
        }));
        const digest = createHash('sha256')
          .update(JSON.stringify({ version: 1, objects, ...(excluded.length ? { excluded } : {}) }))
          .digest('hex');
        if (
          digest !== manifest.sha256 ||
          new Set([...objects, ...excluded].map((value) => value.id)).size !==
            objects.length + excluded.length
        )
          fail('restore_pending');
        const mismatch = await client.query(
          `SELECT 1 FROM jsonb_array_elements($2::jsonb) item LEFT JOIN storage.objects o ON o.id::text=item->>'id'
          WHERE o.id IS NULL OR o.space_id<>$1 OR o.name IS DISTINCT FROM item->>'name' OR o.size IS DISTINCT FROM (item->>'size')::bigint
            OR o.sha256 IS DISTINCT FROM item->>'sha256' OR o.mark IS DISTINCT FROM item->>'mark' LIMIT 1`,
          [manifest.space_id, JSON.stringify([...objects, ...excluded])]
        );
        if (mismatch.rowCount) fail('restore_pending');
        const missingMember = await client.query(
          `SELECT 1 FROM storage.objects o JOIN storage.seal_operations op ON op.space_id=o.space_id
          WHERE o.space_id=$1 AND op.state='sealed' AND NOT EXISTS(SELECT 1 FROM storage.object_tombstones t WHERE t.object_id=o.id)
            AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements($2::jsonb) item WHERE item->>'id'=o.id::text) LIMIT 1`,
          [manifest.space_id, JSON.stringify(objects)]
        );
        if (missingMember.rowCount) fail('restore_pending');
        cursor = manifest.space_id;
      }
      if (manifests.length < 100) break;
    }
    // SQL accounting is derived from retained catalog identities, not presence
    // of bytes. A missing/corrupt version keeps exactly the original charge.
    await client.query(
      `INSERT INTO storage.space_quota(space_id) SELECT id FROM storage.spaces ON CONFLICT DO NOTHING`
    );
    // Normalize the starting ledger first: a damaged low ledger would reject
    // trigger-driven reductions of otherwise correct existing space charges.
    await client.query(
      `UPDATE storage.instance_ledger SET used_bytes=(SELECT COALESCE(sum(reserved_bytes+charged_bytes),0) FROM storage.space_quota) WHERE id`
    );
    // Decrease first: quota triggers enforce instance capacity on increases.
    await client.query(`UPDATE storage.space_quota q SET reserved_bytes=0,charged_bytes=0`);
    await client.query(`UPDATE storage.instance_ledger SET used_bytes=0 WHERE id`);
    await client.query(`UPDATE storage.space_quota q SET
      reserved_bytes=(SELECT COALESCE(sum(i.size),0) FROM storage.upload_intents i WHERE i.space_id=q.space_id AND i.state='pending' AND i.reserved),
      charged_bytes=(SELECT COALESCE(sum(o.size),0) FROM storage.objects o WHERE o.space_id=q.space_id AND NOT EXISTS(SELECT 1 FROM storage.object_tombstones t WHERE t.object_id=o.id))`);
    await client.query(
      `UPDATE storage.instance_ledger SET used_bytes=used_bytes+(SELECT COALESCE(sum(size),0) FROM storage.orphan_gc WHERE NOT deleted) WHERE id`
    );
  }

  return {
    begin: (generation, artifactSha256) => {
      if (artifactSha256 !== undefined && !/^[0-9a-f]{64}$/.test(artifactSha256))
        fail('invalid_request', 400);
      return run(generation, (client) =>
        transaction(client, async () => {
          await guard(client, generation);
          const saved = (
            await client.query<{ artifact_sha256: string | null }>(
              'SELECT artifact_sha256 FROM storage.restore_progress WHERE generation=$1',
              [generation]
            )
          ).rows[0];
          if (
            saved &&
            artifactSha256 !== undefined &&
            saved.artifact_sha256 !== null &&
            saved.artifact_sha256 !== artifactSha256
          )
            fail('restore_generation_conflict', 409);
          await client.query(
            'INSERT INTO storage.restore_progress(generation,artifact_sha256) VALUES($1,$2) ON CONFLICT(generation) DO NOTHING',
            [generation, artifactSha256 ?? null]
          );
          await client.query(
            `INSERT INTO storage.version_availability(object_id,generation,status)
          SELECT object_id,$1,'unverified' FROM storage.object_versions ON CONFLICT(object_id) DO UPDATE SET generation=EXCLUDED.generation,status='unverified',checked_at=NULL
          WHERE storage.version_availability.generation<>EXCLUDED.generation`,
            [generation]
          );
          await client.query("UPDATE storage.maintenance SET state='reconciling' WHERE id");
          return progress(client, generation);
        })
      );
    },
    reconcile: (generation) =>
      run(generation, async (client, signal) => {
        const saved = await transaction(client, async () => {
          await guard(client, generation);
          return progress(client, generation);
        });
        if (saved.complete) return saved;
        const inventoryState = (
          await client.query<{ backend_cursor: string | null; inventory_complete: boolean }>(
            'SELECT backend_cursor,inventory_complete FROM storage.restore_progress WHERE generation=$1',
            [generation]
          )
        ).rows[0];
        if (!inventoryState) fail('restore_pending');
        const listing = inventoryState.inventory_complete
          ? undefined
          : await inventory.listPrivate(inventoryState.backend_cursor ?? undefined, signal);
        const rows = (
          await client.query<Version>(
            `SELECT v.object_id,a.s3_key,o.size::text,o.sha256 FROM storage.object_versions v
        JOIN storage.objects o ON o.id=v.object_id JOIN storage.upload_attempts a ON a.id=v.attempt_id
        WHERE ($1::uuid IS NULL OR v.object_id>$1::uuid) ORDER BY v.object_id LIMIT $2`,
            [saved.cursor, pageSize]
          )
        ).rows;
        const results: { objectId: string; status: Availability }[] = [];
        for (const row of rows)
          results.push({ objectId: row.object_id, status: await verify(row, signal) });
        return transaction(client, async () => {
          await guard(client, generation);
          // Inventory only. Existing retention GC owns deletion after release,
          // including its normal grace, owner and reservation checks.
          if (listing) {
            for (const entry of listing.objects) {
              const owned = await client.query(
                `SELECT 1 FROM storage.upload_attempts a JOIN storage.upload_intents i USING(space_id,upload_id)
                 WHERE a.s3_key=$1 AND (i.reserved OR
                   EXISTS(SELECT 1 FROM storage.object_versions v WHERE v.attempt_id=a.id AND NOT EXISTS(SELECT 1 FROM storage.object_tombstones t WHERE t.object_id=v.object_id)))`,
                [entry.key]
              );
              if (!owned.rowCount)
                await client.query(
                  `INSERT INTO storage.orphan_gc(s3_key,size,first_seen_at,last_modified) VALUES($1,$2,clock_timestamp(),to_timestamp($3/1000.0))
                   ON CONFLICT(s3_key) DO UPDATE SET size=EXCLUDED.size,last_modified=EXCLUDED.last_modified,deleted=false,deleted_at=NULL
                   WHERE storage.orphan_gc.deleted`,
                  [entry.key, entry.size, entry.lastModified]
                );
            }
            await client.query(
              'UPDATE storage.restore_progress SET backend_cursor=$2,inventory_complete=$3 WHERE generation=$1',
              [generation, listing.nextCursor, listing.nextCursor === null]
            );
          }
          for (const result of results) {
            const updated = await client.query(
              'UPDATE storage.version_availability SET status=$3,checked_at=clock_timestamp() WHERE object_id=$1 AND generation=$2',
              [result.objectId, generation, result.status]
            );
            if (updated.rowCount !== 1) fail('restore_pending');
          }
          const cursor = rows.at(-1)?.object_id ?? saved.cursor;
          const remaining = await client.query(
            'SELECT 1 FROM storage.object_versions WHERE ($1::uuid IS NULL OR object_id>$1::uuid) LIMIT 1',
            [cursor]
          );
          const complete =
            remaining.rowCount === 0 &&
            (listing ? listing.nextCursor === null : inventoryState.inventory_complete);
          if (complete) {
            const unverified = await client.query(
              `SELECT 1 FROM storage.object_versions v LEFT JOIN storage.version_availability a ON a.object_id=v.object_id
            WHERE a.generation IS DISTINCT FROM $1::uuid OR a.status IS NULL OR a.status='unverified' LIMIT 1`,
              [generation]
            );
            if (unverified.rowCount) fail('restore_pending');
            await validate(client);
          }
          await client.query(
            `UPDATE storage.restore_progress SET cursor=$2,complete=$3,unavailable=(SELECT count(*) FROM storage.version_availability a
          WHERE a.generation=$1 AND a.status IN ('missing','corrupt') AND NOT EXISTS(SELECT 1 FROM storage.object_tombstones t WHERE t.object_id=a.object_id)
            AND NOT EXISTS(SELECT 1 FROM storage.retention_tombstones t WHERE t.object_id=a.object_id)) WHERE generation=$1`,
            [generation, cursor, complete]
          );
          return progress(client, generation, rows.length);
        });
      }),
    close: () => {
      closed = true;
      for (const controller of active) controller.abort();
      inventory.close();
      return Promise.resolve();
    },
  };
}
