/** Bounded reclamation of abandoned uploads. Publication checks attempt_gc before
 * it can expose any retired attempt. Reservation bytes remain held until DELETE
 * is confirmed, and a renewed upload lease always wins over quota release. */
import type { PoolClient } from 'pg';
import type { StorageObjectS3 } from './storage-object-s3.js';

interface Attempt {
  attempt_id: string;
  space_id: string;
  upload_id: string;
  s3_key: string;
}
export interface ExpiredUploadSweepOptions {
  tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T>;
  /** Own the session advisory hashtextextended(key,8) across work. Skip a
   * contended key. Destroy, rather than pool, a session whose unlock fails. */
  withKey<T>(key: string, work: () => Promise<T>): Promise<T | undefined>;
  s3: StorageObjectS3;
  now(): number;
  graceMs: number;
}
const MIN_GRACE_MS = 172_800_000;

export async function sweepExpiredUploads(options: ExpiredUploadSweepOptions): Promise<void> {
  if (!Number.isFinite(options.graceMs) || options.graceMs < MIN_GRACE_MS) {
    throw new RangeError('Upload reclamation grace must be at least two days');
  }
  const now = options.now();
  const attempts = await options.tx(
    async (client) =>
      (
        await client.query<Attempt>(
          `SELECT a.id AS attempt_id,a.space_id,a.upload_id,a.s3_key
       FROM storage.upload_attempts a
       JOIN storage.upload_intents i USING(space_id,upload_id)
       LEFT JOIN storage.attempt_gc g ON g.attempt_id=a.id
       WHERE a.created_at<=to_timestamp($2/1000.0)
         AND NOT EXISTS(SELECT 1 FROM storage.object_versions v WHERE v.attempt_id=a.id)
         AND NOT EXISTS(SELECT 1 FROM storage.seal_gc sg WHERE sg.attempt_id=a.id)
         AND ((g.attempt_id IS NOT NULL AND NOT g.deleted)
           OR (g.attempt_id IS NULL AND i.state='pending'
               AND i.lease_expires_at<=to_timestamp($1/1000.0)))
       ORDER BY a.created_at,a.id LIMIT 100`,
          [now, now - options.graceMs]
        )
      ).rows
  );
  for (const attempt of attempts) {
    const retired = await options.tx(async (client) => {
      const space = (
        await client.query<{ mode: string }>(
          'SELECT mode FROM storage.spaces WHERE id=$1 FOR SHARE',
          [attempt.space_id]
        )
      ).rows[0];
      if (!space) return false;
      // Same order as reserve/complete/release. The marker and publication's
      // decision are exclusive, without holding SQL locks during S3 requests.
      await client.query('SELECT space_id FROM storage.space_quota WHERE space_id=$1 FOR UPDATE', [
        attempt.space_id,
      ]);
      const intent = (
        await client.query<{ state: string; expired: boolean }>(
          'SELECT state,lease_expires_at<=to_timestamp($3/1000.0) AS expired FROM storage.upload_intents WHERE space_id=$1 AND upload_id=$2 FOR UPDATE',
          [attempt.space_id, attempt.upload_id, options.now()]
        )
      ).rows[0];
      if (!intent) return false;
      if (
        (
          await client.query('SELECT 1 FROM storage.object_versions WHERE attempt_id=$1', [
            attempt.attempt_id,
          ])
        ).rowCount
      )
        return false;
      // Seal owns every key it has claimed, including unconfirmed deletions.
      if (
        (
          await client.query('SELECT 1 FROM storage.seal_gc WHERE attempt_id=$1', [
            attempt.attempt_id,
          ])
        ).rowCount
      )
        return false;
      const prior = (
        await client.query<{ deleted: boolean }>(
          'SELECT deleted FROM storage.attempt_gc WHERE attempt_id=$1 FOR UPDATE',
          [attempt.attempt_id]
        )
      ).rows[0];
      if (prior) return !prior.deleted;
      if (
        !['open', 'wrapping'].includes(space.mode) ||
        intent.state !== 'pending' ||
        !intent.expired
      )
        return false;
      if (
        (
          await client.query('SELECT 1 FROM storage.seal_operations WHERE space_id=$1', [
            attempt.space_id,
          ])
        ).rowCount
      )
        return false;
      const inserted = await client.query(
        `INSERT INTO storage.attempt_gc(attempt_id,space_id,s3_key,size)
         SELECT a.id,a.space_id,a.s3_key,i.size FROM storage.upload_attempts a
         JOIN storage.upload_intents i USING(space_id,upload_id)
         WHERE a.id=$1 AND a.created_at<=to_timestamp($2/1000.0)
           AND i.state='pending' AND i.lease_expires_at<=to_timestamp($3/1000.0)
           AND NOT EXISTS(SELECT 1 FROM storage.object_versions v WHERE v.attempt_id=a.id)
           AND NOT EXISTS(SELECT 1 FROM storage.seal_gc sg WHERE sg.attempt_id=a.id)
         ON CONFLICT DO NOTHING RETURNING attempt_id`,
        [attempt.attempt_id, now - options.graceMs, options.now()]
      );
      return inserted.rowCount === 1;
    });
    if (!retired) continue;
    await options.withKey(attempt.s3_key, async () => {
      // Another sweeper or the orphan worker can finish while this worker waits
      // for the shared key lock. Retirement itself remains a terminal marker.
      const ready = await options.tx(async (client) =>
        Boolean(
          (
            await client.query(
              `SELECT 1 FROM storage.attempt_gc g WHERE g.attempt_id=$1 AND NOT g.deleted
           AND NOT EXISTS(SELECT 1 FROM storage.object_versions v WHERE v.attempt_id=g.attempt_id)
           AND NOT EXISTS(SELECT 1 FROM storage.seal_gc sg WHERE sg.attempt_id=g.attempt_id)`,
              [attempt.attempt_id]
            )
          ).rowCount
        )
      );
      if (!ready) return;
      await options.s3.delete(attempt.space_id, attempt.s3_key, AbortSignal.timeout(10_000));
      await options.tx(async (client) => {
        await client.query('SELECT id FROM storage.spaces WHERE id=$1 FOR SHARE', [
          attempt.space_id,
        ]);
        await client.query(
          'SELECT space_id FROM storage.space_quota WHERE space_id=$1 FOR UPDATE',
          [attempt.space_id]
        );
        await client.query(
          'SELECT upload_id FROM storage.upload_intents WHERE space_id=$1 AND upload_id=$2 FOR UPDATE',
          [attempt.space_id, attempt.upload_id]
        );
        const changed = await client.query(
          'UPDATE storage.attempt_gc SET deleted=true WHERE attempt_id=$1 AND NOT deleted RETURNING attempt_id',
          [attempt.attempt_id]
        );
        if (!changed.rowCount) return;
        // Clear independent orphan debt only after the same confirmed DELETE.
        const orphan = await client.query<{ size: string }>(
          'UPDATE storage.orphan_gc SET deleted=true WHERE s3_key=$1 AND NOT deleted RETURNING size::text',
          [attempt.s3_key]
        );
        if (orphan.rowCount)
          await client.query(
            'UPDATE storage.instance_ledger SET used_bytes=used_bytes-$1 WHERE id',
            [orphan.rows[0]?.size]
          );
        await client.query(
          `SELECT storage.release_upload(i.space_id,i.upload_id)
           FROM storage.upload_intents i
           WHERE i.space_id=$1 AND i.upload_id=$2 AND i.state='pending'
             AND i.lease_expires_at<=to_timestamp($3/1000.0)
             AND NOT EXISTS(
               SELECT 1 FROM storage.upload_attempts a
               WHERE a.space_id=i.space_id AND a.upload_id=i.upload_id
                 AND NOT EXISTS(SELECT 1 FROM storage.attempt_gc g WHERE g.attempt_id=a.id AND g.deleted)
                 AND NOT EXISTS(SELECT 1 FROM storage.seal_gc sg WHERE sg.attempt_id=a.id AND sg.deleted)
             )`,
          [attempt.space_id, attempt.upload_id, options.now()]
        );
      });
    });
  }
}
