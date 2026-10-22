/** Restore evidence uses real catalog SQL and an independently verified SigV4 HTTP boundary. */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createStorageRestoreReconciler } from '../../loader/src/storage-restore-reconcile.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createTestStores, workerDatabaseUrl, type TestStores } from '../helpers/test-stores.js';
import { createSealS3 } from '../helpers/storage-seal-s3.js';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
let stores: TestStores;
let backend: Awaited<ReturnType<typeof createSealS3>>;
let generation: string;
const helpers: ReturnType<typeof createStorageRestoreReconciler>[] = [];
function helper(pageSize = 100, timeoutMs = 3000) {
  const result = createStorageRestoreReconciler({
    connectionString: workerDatabaseUrl(),
    s3: {
      endpoint: backend.endpoint,
      bucket: backend.bucket,
      custody: { read: async () => backend.credentials },
    },
    pageSize,
    timeoutMs,
  });
  helpers.push(result);
  return result;
}
async function publish(bytes = Buffer.from('restored output'), space = 'a') {
  const id = randomUUID(),
    attempt = randomUUID(),
    key = `private/${attempt}`;
  await stores.postgres.query('SELECT storage.reserve_upload($1,$2,$3,$4,$5,$6,3600)', [
    space,
    id,
    id,
    'output.txt',
    bytes.length,
    hash(bytes),
  ]);
  await stores.postgres.query(
    'INSERT INTO storage.upload_attempts(id,space_id,upload_id,s3_key) VALUES($1,$2,$3,$4)',
    [attempt, space, id, key]
  );
  await stores.postgres.query('SELECT storage.complete_upload($1,$2,$3)', [space, id, attempt]);
  backend.objects.set(key, { bytes, sha256: hash(bytes) });
  return { id, key, bytes, space };
}
async function statuses() {
  return (
    await stores.postgres.query(
      'SELECT object_id,status FROM storage.version_availability ORDER BY object_id'
    )
  ).rows;
}
async function plan(object: Awaited<ReturnType<typeof publish>>) {
  await stores.postgres.query(
    `INSERT INTO storage.retention_policies(space_id,retention,settings_revision,terminal_at,expires_at) VALUES($1,'90d',1,'2030-01-01','2030-04-01')`,
    [object.space]
  );
  await stores.postgres.query(
    `INSERT INTO storage.deletion_plans(id,reason,state,lead_days,settings_revision,warned_at,earliest_delete_at,message_id,warning_receipt,total_bytes)
    VALUES('original-plan','age','warned',7,1,'2030-04-01','2030-04-08','original-message',$1,$2)`,
    [
      {
        id: 'original-receipt',
        planId: 'original-plan',
        messageId: 'original-message',
        earliestDeleteAt: '2030-04-08T00:00:00.000Z',
      },
      object.bytes.length,
    ]
  );
  await stores.postgres.query(
    `INSERT INTO storage.deletion_candidates(plan_id,space_id,policy_revision,object_id,object_revision,s3_key,size)
    SELECT 'original-plan',space_id,0,id,sequence,$2,size FROM storage.objects WHERE id=$1`,
    [object.id, object.key]
  );
}
async function seal(object: Awaited<ReturnType<typeof publish>>) {
  await stores.postgres.query("UPDATE storage.objects SET mark='result' WHERE id=$1", [object.id]);
  const objects = [
    {
      id: object.id,
      name: 'output.txt',
      size: object.bytes.length,
      sha256: hash(object.bytes),
      mark: 'result',
    },
  ];
  await stores.postgres.query(
    `INSERT INTO storage.seal_operations(space_id,effect_key,request,receipt_id,manifest_id,revision,outcome,candidates,state)
    VALUES($1,'original-seal','{}','original-seal-receipt','original-manifest',0,'completed',$2,'sealed')`,
    [object.space, JSON.stringify(objects)]
  );
  await stores.postgres.query(
    `INSERT INTO storage.seal_manifests(space_id,id,version,sha256,objects) VALUES($1,'original-manifest',1,$2,$3)`,
    [object.space, hash(JSON.stringify({ version: 1, objects })), JSON.stringify(objects)]
  );
  await stores.postgres.query("UPDATE storage.spaces SET mode='sealed' WHERE id=$1", [
    object.space,
  ]);
  await stores.postgres.query(
    `INSERT INTO storage.seal_receipts(effect_key,space_id,receipt)
    SELECT op.effect_key,op.space_id,jsonb_build_object('id',op.receipt_id,'space',op.space_id,'effectKey',op.effect_key,
      'revision',op.revision::text,'outcome',op.outcome,'state','sealed','reason',m.reason,
      'manifest',jsonb_build_object('id',m.id,'version',m.version,'sha256',m.sha256,'objects',m.objects))
    FROM storage.seal_operations op JOIN storage.seal_manifests m USING(space_id) WHERE op.space_id=$1`,
    [object.space]
  );
}
beforeAll(async () => {
  stores = await createTestStores();
  stores.postgres.on('error', () => undefined);
  stores.postgres.on('connect', (client) => client.on('error', () => undefined));
  await applyTestMigrations(stores.postgres);
  backend = await createSealS3();
});
beforeEach(async () => {
  for (const item of helpers.splice(0)) await item.close();
  await stores.postgres.query(
    'TRUNCATE storage.spaces,storage.deletion_plans,storage.orphan_gc,storage.restore_progress CASCADE'
  );
  await stores.postgres.query('UPDATE storage.instance_ledger SET used_bytes=0');
  await stores.postgres.query("INSERT INTO storage.spaces(id) VALUES('a'),('b')");
  generation = randomUUID();
  await stores.postgres.query(
    "UPDATE storage.maintenance SET generation=$1,purpose='restore',state='held' WHERE id",
    [generation]
  );
  backend.reset();
  backend.hooks.beforeGet = (request) => {
    const object = backend.objects.get(request.key);
    return object
      ? {
          status: 200,
          headers: { 'content-length': String(object.bytes.length) },
          body: object.bytes.toString(),
        }
      : undefined;
  };
});
afterAll(async () => {
  for (const item of helpers.splice(0)) await item.close();
  await backend?.close();
  await stores?.postgres.end();
  await stores?.redis.quit();
});

describe('checkpointed storage restore reconciliation', () => {
  it('seeds every version unavailable atomically and resumes bounded pages without rehashing completed pages', async () => {
    for (let n = 0; n < 3; n++) await publish(Buffer.from(`object-${n}`));
    const first = helper(2);
    await first.begin(generation);
    expect((await statuses()).map((row) => row.status)).toEqual([
      'unverified',
      'unverified',
      'unverified',
    ]);
    expect(await first.reconcile(generation)).toMatchObject({
      complete: false,
      checked: 2,
      unavailable: 0,
    });
    expect(
      backend.requests.filter((row) => row.method === 'GET' && row.key.startsWith('private/'))
    ).toHaveLength(2);
    const resumed = helper(2);
    await resumed.begin(generation);
    expect(await resumed.reconcile(generation)).toMatchObject({
      complete: true,
      checked: 1,
      unavailable: 0,
    });
    expect(await resumed.reconcile(generation)).toMatchObject({ complete: true, checked: 0 });
    expect(
      backend.requests.filter((row) => row.method === 'GET' && row.key.startsWith('private/'))
    ).toHaveLength(3);
    expect(backend.requests.every((row) => row.authorized)).toBe(true);
    expect((await statuses()).every((row) => row.status === 'available')).toBe(true);
  });
  it('rehashes actual multi-chunk and empty bytes rather than trusting original HEAD checksums', async () => {
    const large = await publish(Buffer.alloc(4 * 1024 * 1024 + 31, 'a'));
    const empty = await publish(Buffer.alloc(0), 'b');
    const reconcile = helper();
    await reconcile.begin(generation);
    expect(await reconcile.reconcile(generation)).toMatchObject({
      complete: true,
      unavailable: 0,
      checked: 2,
    });
    expect(backend.requests.map((row) => [row.method, row.key])).toEqual(
      expect.arrayContaining([
        ['GET', large.key],
        ['GET', empty.key],
      ])
    );
    expect(backend.requests.some((row) => row.method === 'HEAD')).toBe(false);
  });
  it('records confirmed missing and corrupt versions without deleting their marks, receipts or charges', async () => {
    const missing = await publish();
    const corrupt = await publish(Buffer.from('same length'), 'b');
    const emptyMissing = await publish(Buffer.alloc(0), 'b');
    backend.objects.delete(missing.key);
    backend.objects.delete(emptyMissing.key);
    backend.objects.get(corrupt.key)!.bytes = Buffer.from('wrong bytes');
    await seal(missing);
    const before = (
      await stores.postgres.query('SELECT * FROM storage.object_versions ORDER BY object_id')
    ).rows;
    const reconcile = helper();
    await reconcile.begin(generation);
    expect(await reconcile.reconcile(generation)).toMatchObject({ complete: true, unavailable: 3 });
    expect(await statuses()).toEqual(
      expect.arrayContaining([
        { object_id: missing.id, status: 'missing' },
        { object_id: corrupt.id, status: 'corrupt' },
        { object_id: emptyMissing.id, status: 'missing' },
      ])
    );
    expect(
      (await stores.postgres.query('SELECT * FROM storage.object_versions ORDER BY object_id')).rows
    ).toEqual(before);
    expect(
      (await stores.postgres.query('SELECT used_bytes::int AS n FROM storage.instance_ledger'))
        .rows[0].n
    ).toBe(missing.bytes.length + corrupt.bytes.length);
  });
  it.each([403, 500, 503])(
    'keeps HTTP %i retryable, not missing/corrupt, and does not advance its checkpoint',
    async (status) => {
      await publish();
      const reconcile = helper();
      await reconcile.begin(generation);
      backend.hooks.beforeGet = () => ({ status });
      await expect(reconcile.reconcile(generation)).rejects.toMatchObject({
        code: 'object_store_unavailable',
      });
      expect((await statuses())[0].status).toBe('unverified');
      expect(
        (await stores.postgres.query('SELECT cursor,complete FROM storage.restore_progress'))
          .rows[0]
      ).toMatchObject({ cursor: null, complete: false });
      backend.hooks.beforeGet = (request) => {
        const object = backend.objects.get(request.key)!;
        return { status: 200, body: object.bytes.toString() };
      };
      expect(await reconcile.reconcile(generation)).toMatchObject({
        complete: true,
        unavailable: 0,
      });
    }
  );
  it('bounds a stalled request and leaves its version unverified', async () => {
    await publish();
    const reconcile = helper(100, 100);
    await reconcile.begin(generation);
    backend.hooks.beforeGet = () => 'hang';
    await expect(reconcile.reconcile(generation)).rejects.toMatchObject({
      code: 'object_store_unavailable',
    });
    expect((await statuses())[0].status).toBe('unverified');
  });
  it('rejects a wrong or replaced generation before durable progress', async () => {
    await publish();
    const reconcile = helper();
    await expect(reconcile.begin(randomUUID())).rejects.toMatchObject({
      code: 'restore_generation_conflict',
    });
    await reconcile.begin(generation);
    backend.hooks.beforeGet = async (request) => {
      await stores.postgres.query('UPDATE storage.maintenance SET generation=$1 WHERE id', [
        randomUUID(),
      ]);
      return { status: 200, body: backend.objects.get(request.key)!.bytes.toString() };
    };
    await expect(reconcile.reconcile(generation)).rejects.toMatchObject({
      code: 'restore_generation_conflict',
    });
    expect((await statuses())[0].status).toBe('unverified');
  });
  it('repairs derivable quota totals with orphan debt without treating absent bytes as released charges', async () => {
    const object = await publish();
    await publish(Buffer.from('another'), 'b');
    await stores.postgres.query(
      "INSERT INTO storage.orphan_gc(s3_key,size,first_seen_at,last_modified) VALUES('private/orphan',9,clock_timestamp(),clock_timestamp())"
    );
    await stores.postgres.query('UPDATE storage.space_quota SET charged_bytes=0');
    await stores.postgres.query('UPDATE storage.instance_ledger SET used_bytes=0');
    backend.objects.delete(object.key);
    const reconcile = helper();
    await reconcile.begin(generation);
    expect(await reconcile.reconcile(generation)).toMatchObject({ complete: true, unavailable: 1 });
    expect(
      (await stores.postgres.query('SELECT used_bytes::int AS n FROM storage.instance_ledger'))
        .rows[0].n
    ).toBe(object.bytes.length + 7 + 9);
  });
  it('repairs a damaged instance ledger even when correct per-space charges already exist', async () => {
    const object = await publish();
    await stores.postgres.query('UPDATE storage.instance_ledger SET used_bytes=0');
    const reconcile = helper();
    await reconcile.begin(generation);
    expect(await reconcile.reconcile(generation)).toMatchObject({ complete: true });
    expect(
      (await stores.postgres.query('SELECT used_bytes::int AS n FROM storage.instance_ledger'))
        .rows[0].n
    ).toBe(object.bytes.length);
  });
  it('preserves deletion identities, warning receipts and deadlines; malformed membership stays pending', async () => {
    const object = await publish();
    await plan(object);
    const before = (await stores.postgres.query('SELECT * FROM storage.deletion_plans')).rows;
    const reconcile = helper();
    await reconcile.begin(generation);
    await stores.postgres.query(
      'UPDATE storage.deletion_candidates SET object_revision=object_revision+1'
    );
    await expect(reconcile.reconcile(generation)).rejects.toMatchObject({
      code: 'restore_pending',
    });
    expect(
      (await stores.postgres.query('SELECT complete FROM storage.restore_progress')).rows[0]
        .complete
    ).toBe(false);
    await stores.postgres.query(
      'UPDATE storage.deletion_candidates SET object_revision=object_revision-1'
    );
    expect(await reconcile.reconcile(generation)).toMatchObject({ complete: true });
    expect((await stores.postgres.query('SELECT * FROM storage.deletion_plans')).rows).toEqual(
      before
    );
  });
  it('inventories backend-only private residue as durable orphan debt before completion', async () => {
    await publish();
    const orphanKey = `private/${randomUUID()}`;
    const bytes = Buffer.from('private residue');
    backend.objects.set(orphanKey, { bytes, sha256: hash(bytes), lastModified: Date.now() });
    const reconcile = helper();
    await reconcile.begin(generation);
    expect(await reconcile.reconcile(generation)).toMatchObject({ complete: true });
    expect(
      (
        await stores.postgres.query(
          'SELECT s3_key,size::int AS size,deleted FROM storage.orphan_gc'
        )
      ).rows
    ).toEqual([{ s3_key: orphanKey, size: bytes.length, deleted: false }]);
    expect(
      (await stores.postgres.query('SELECT used_bytes::int AS n FROM storage.instance_ledger'))
        .rows[0].n
    ).toBe(Buffer.byteLength('restored output') + bytes.length);
    expect(backend.objects.has(orphanKey)).toBe(true);
  });
  it('counts expired attempt bytes once, preserves reservations, and never deletes under the restore hold', async () => {
    const output = await publish();
    const keys: string[] = [];
    for (const reserved of [true, false]) {
      const upload = randomUUID(),
        attempt = randomUUID(),
        key = `private/${attempt}`;
      keys.push(key);
      const bytes = Buffer.from('expired residue');
      await stores.postgres.query('SELECT storage.reserve_upload($1,$2,$3,$4,$5,$6,3600)', [
        'b',
        upload,
        upload,
        'partial.txt',
        bytes.length,
        hash(bytes),
      ]);
      await stores.postgres.query(
        "INSERT INTO storage.upload_attempts(id,space_id,upload_id,s3_key,created_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '3 days')",
        [attempt, 'b', upload, key]
      );
      await stores.postgres.query(
        "UPDATE storage.upload_intents SET lease_expires_at=clock_timestamp()-interval '3 days' WHERE upload_id=$1",
        [upload]
      );
      if (!reserved) {
        await stores.postgres.query('SELECT storage.release_upload($1,$2)', ['b', upload]);
        await stores.postgres.query(
          'INSERT INTO storage.attempt_gc(attempt_id,space_id,s3_key,size) VALUES($1,$2,$3,$4)',
          [attempt, 'b', key, bytes.length]
        );
      }
      backend.objects.set(key, {
        bytes,
        sha256: hash(bytes),
        lastModified: Date.now() - 3 * 86400000,
      });
    }
    const reconcile = helper();
    await reconcile.begin(generation);
    expect(await reconcile.reconcile(generation)).toMatchObject({ complete: true });
    expect(
      (await stores.postgres.query('SELECT used_bytes::int AS n FROM storage.instance_ledger'))
        .rows[0].n
    ).toBe(output.bytes.length + 2 * Buffer.byteLength('expired residue'));
    expect(
      (
        await stores.postgres.query(
          'SELECT count(*)::int AS n FROM storage.orphan_gc WHERE NOT deleted'
        )
      ).rows[0].n
    ).toBe(1);
    expect(backend.requests.filter((request) => request.method === 'DELETE')).toEqual([]);
    expect(keys.every((key) => backend.objects.has(key))).toBe(true);
  });
  it('accounts unreserved residue despite a fresh upload lease without deleting its bytes', async () => {
    const upload = randomUUID(),
      attempt = randomUUID(),
      key = `private/${attempt}`,
      bytes = Buffer.from('fresh canceled residue');
    await stores.postgres.query('SELECT storage.reserve_upload($1,$2,$3,$4,$5,$6,3600)', [
      'a',
      upload,
      upload,
      'canceled.txt',
      bytes.length,
      hash(bytes),
    ]);
    await stores.postgres.query(
      'INSERT INTO storage.upload_attempts(id,space_id,upload_id,s3_key) VALUES($1,$2,$3,$4)',
      [attempt, 'a', upload, key]
    );
    await stores.postgres.query('SELECT storage.release_upload($1,$2)', ['a', upload]);
    backend.objects.set(key, { bytes, sha256: hash(bytes), lastModified: Date.now() });
    const reconcile = helper();
    await reconcile.begin(generation);
    expect(await reconcile.reconcile(generation)).toMatchObject({ complete: true });
    expect(
      (await stores.postgres.query('SELECT used_bytes::int AS n FROM storage.instance_ledger'))
        .rows[0].n
    ).toBe(bytes.length);
    expect(backend.objects.has(key)).toBe(true);
    expect(backend.requests.some((row) => row.method === 'DELETE')).toBe(false);
  });
  it('refuses a changed seal receipt or deletion plan total without minting replacements', async () => {
    const object = await publish();
    await seal(object);
    await plan(object);
    const reconcile = helper();
    await reconcile.begin(generation);
    await stores.postgres.query(
      "UPDATE storage.seal_receipts SET receipt=jsonb_set(receipt,'{manifest,sha256}',to_jsonb(repeat('a',64)))"
    );
    await expect(reconcile.reconcile(generation)).rejects.toMatchObject({
      code: 'restore_pending',
    });
    await stores.postgres.query('DELETE FROM storage.seal_receipts');
    await stores.postgres.query('UPDATE storage.deletion_plans SET total_bytes=total_bytes+1');
    await expect(reconcile.reconcile(generation)).rejects.toMatchObject({
      code: 'restore_pending',
    });
    await stores.postgres.query('UPDATE storage.deletion_plans SET total_bytes=total_bytes-1');
    expect(await reconcile.reconcile(generation)).toMatchObject({ complete: true });
  });
  it('refuses a damaged seal manifest even when all actual bytes validate', async () => {
    const object = await publish();
    await seal(object);
    const reconcile = helper();
    await reconcile.begin(generation);
    await stores.postgres.query("UPDATE storage.seal_manifests SET sha256=repeat('a',64)");
    await expect(reconcile.reconcile(generation)).rejects.toMatchObject({
      code: 'restore_pending',
    });
    expect(
      (await stores.postgres.query('SELECT complete FROM storage.restore_progress')).rows[0]
        .complete
    ).toBe(false);
  });
});
