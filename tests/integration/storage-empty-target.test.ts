/** The exact operator SQL accepts a normally bootstrapped, stopped destination.
 * Real entry point/listeners, owner heartbeat, maintenance hold and PostgreSQL.
 */
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRetentionHarness } from '../helpers/storage-retention-harness.js';

const emptyTargetSql = await readFile(
  new URL('../../deploy/platform/storage-empty-target.sql', import.meta.url),
  'utf8'
);
let h: Awaited<ReturnType<typeof createRetentionHarness>>;
let bao: ReturnType<typeof createServer>;
beforeAll(async () => {
  h = await createRetentionHarness('lifemodel-storage');
  bao = createServer((req, res) => {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    req.resume();
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/auth/kubernetes/login')
      res.end(JSON.stringify({ auth: { client_token: 'fixture-token', lease_duration: 3600 } }));
    else if (req.url === '/v1/lifemodel/data/storage/seaweed')
      res.end(JSON.stringify({ data: { data: h.backend.credentials } }));
    else {
      res.writeHead(404);
      res.end();
    }
  });
  bao.on('error', () => undefined);
  await new Promise<void>((resolve) => bao.listen(0, '127.0.0.1', resolve));
  const address = bao.address();
  if (!address || typeof address === 'string') throw Error('Bao fixture failed');
  h.backend.hooks.beforeBucketCheck = () => ({ status: 200 });
  const child = await h.start({
    baoAddress: `http://127.0.0.1:${address.port}`,
    serviceAccount: dirname(h.identity.options.tokenFile),
  });
  const port = (child.ports as typeof child.ports & { status: number }).status;
  await vi.waitFor(
    async () => {
      expect((await fetch(`http://127.0.0.1:${port}/status`)).status).toBe(200);
    },
    { timeout: 15_000 }
  );
  const held = await h.call('control', 'POST', '/maintenance/begin', { effectKey: 'empty-target' });
  expect(held.status).toBe(200);
  expect(held.json.state).toBe('held');
  const exited = once(child.process, 'exit', { signal: AbortSignal.timeout(20_000) });
  expect(child.process.kill('SIGTERM')).toBe(true);
  expect(await exited).toEqual([0, null]);
}, 40_000);
afterAll(async () => {
  await h?.close();
  bao?.closeAllConnections();
  if (bao) await new Promise<void>((resolve) => bao.close(() => resolve()));
}, 20_000);

/** Roll back even a rejected DO block; no dirty fixture can mask another case. */
async function rejectDirty(sql: string, message: string, isolateCatalogRow = false) {
  const client = await h.stores.postgres.connect();
  try {
    await client.query('BEGIN');
    // Deliberately isolate one dirty table, including crash/corruption residue.
    // Otherwise a required FK parent could mask an accidentally skipped child.
    // Only this test connection disables FK/accounting triggers, never the gate.
    if (isolateCatalogRow) await client.query("SET LOCAL session_replication_role='replica'");
    await client.query(sql);
    if (isolateCatalogRow) await client.query("SET LOCAL session_replication_role='origin'");
    await expect(client.query(emptyTargetSql)).rejects.toMatchObject({ message });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

// Each row satisfies its column/check constraints. FK dependencies are purposely
// absent so every storage data table is independently covered by the exact gate.
const catalogRows: Array<[string, string]> = [
  ['spaces', "INSERT INTO storage.spaces(id) VALUES('dirty')"],
  ['revoke_receipts', "INSERT INTO storage.revoke_receipts VALUES('effect','dirty',0,1,'receipt')"],
  ['space_quota', "INSERT INTO storage.space_quota(space_id) VALUES('dirty')"],
  [
    'upload_intents',
    "INSERT INTO storage.upload_intents(space_id,upload_id,object_id,name,size,sha256,lease_expires_at) VALUES('dirty','upload','00000000-0000-4000-8000-000000000001','output',0,repeat('a',64),clock_timestamp())",
  ],
  [
    'upload_attempts',
    "INSERT INTO storage.upload_attempts(id,space_id,upload_id,s3_key) VALUES('00000000-0000-4000-8000-000000000001','dirty','upload','private/dirty')",
  ],
  [
    'objects',
    "INSERT INTO storage.objects(id,space_id,name,size,sha256) VALUES('00000000-0000-4000-8000-000000000001','dirty','output',0,repeat('a',64))",
  ],
  [
    'object_versions',
    "INSERT INTO storage.object_versions(object_id,attempt_id,receipt) VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','{}')",
  ],
  ['allocations', "INSERT INTO storage.allocations VALUES('launch','task','dirty','revision')"],
  ['allocate_receipts', "INSERT INTO storage.allocate_receipts VALUES('effect','dirty','{}','{}')"],
  [
    'bindings',
    "INSERT INTO storage.bindings VALUES('dirty','task','attempt','launch','pod','job')",
  ],
  ['bind_receipts', "INSERT INTO storage.bind_receipts VALUES('effect','dirty','{}','{}')"],
  [
    'seal_operations',
    "INSERT INTO storage.seal_operations(space_id,effect_key,request,receipt_id,manifest_id,revision,outcome,candidates,state) VALUES('dirty','effect','{}','receipt','manifest',0,'completed','[]','frozen')",
  ],
  [
    'seal_manifests',
    "INSERT INTO storage.seal_manifests(space_id,id,version,sha256,objects) VALUES('dirty','manifest',1,repeat('a',64),'[]')",
  ],
  [
    'seal_gc',
    "INSERT INTO storage.seal_gc(space_id,attempt_id,s3_key) VALUES('dirty','00000000-0000-4000-8000-000000000001','private/dirty')",
  ],
  [
    'object_tombstones',
    "INSERT INTO storage.object_tombstones VALUES('00000000-0000-4000-8000-000000000001','dirty','seal_unmarked')",
  ],
  ['seal_receipts', "INSERT INTO storage.seal_receipts VALUES('effect','dirty','{}')"],
  [
    'retention_policies',
    "INSERT INTO storage.retention_policies(space_id,retention,settings_revision,terminal_at) VALUES('dirty','90d',1,clock_timestamp())",
  ],
  [
    'deletion_plans',
    "INSERT INTO storage.deletion_plans(id,reason,lead_days,settings_revision) VALUES('dirty','age',7,1)",
  ],
  [
    'deletion_candidates',
    "INSERT INTO storage.deletion_candidates(plan_id,space_id,policy_revision,object_id,object_revision,s3_key,size) VALUES('plan','dirty',0,'00000000-0000-4000-8000-000000000001',0,'private/dirty',0)",
  ],
  ['retention_receipts', "INSERT INTO storage.retention_receipts VALUES('effect','{}','{}')"],
  ['reclaim_receipts', "INSERT INTO storage.reclaim_receipts VALUES('effect','{}','{}')"],
  [
    'retention_tombstones',
    "INSERT INTO storage.retention_tombstones VALUES('00000000-0000-4000-8000-000000000001','dirty','plan','deleted')",
  ],
  [
    'read_leases',
    "INSERT INTO storage.read_leases VALUES('00000000-0000-4000-8000-000000000001','dirty',clock_timestamp())",
  ],
  [
    'orphan_gc',
    "INSERT INTO storage.orphan_gc(s3_key,size,first_seen_at,last_modified) VALUES('private/dirty',0,clock_timestamp(),clock_timestamp())",
  ],
  [
    'attempt_gc',
    "INSERT INTO storage.attempt_gc(attempt_id,space_id,s3_key,size) VALUES('00000000-0000-4000-8000-000000000001','dirty','private/dirty',0)",
  ],
  [
    'version_availability',
    "INSERT INTO storage.version_availability(object_id,generation,status) VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','missing')",
  ],
  [
    'restore_progress',
    "INSERT INTO storage.restore_progress(generation) VALUES('00000000-0000-4000-8000-000000000001')",
  ],
];

describe('operator empty-destination SQL', () => {
  it('accepts the boot-only heartbeat after a real fresh module becomes ready, holds and stops', async () => {
    expect(
      (await h.stores.postgres.query('SELECT count(*)::int AS n FROM storage.upload_owners'))
        .rows[0].n
    ).toBe(1);
    const before = (await h.stores.postgres.query('SELECT * FROM storage.upload_owners')).rows;
    await h.stores.postgres.query(emptyTargetSql);
    expect((await h.stores.postgres.query('SELECT * FROM storage.upload_owners')).rows).toEqual(
      before
    );
  });
  it('covers every existing non-operational storage table', async () => {
    const tables = (
      await h.stores.postgres.query(
        "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='storage' AND tablename NOT IN ('maintenance','instance_ledger','upload_owners') ORDER BY tablename"
      )
    ).rows.map((row) => row.tablename);
    expect(tables).toEqual(catalogRows.map(([table]) => table).sort());
  });
  it.each(catalogRows)(
    'rejects a row in %s even when no other catalog table is populated',
    async (_table, sql) => {
      await rejectDirty(sql, 'destination_not_empty', true);
    }
  );
  it('rejects populated future tables instead of silently allowlisting known catalog data', async () => {
    await rejectDirty(
      "CREATE TABLE storage.future_catalog(value text); INSERT INTO storage.future_catalog VALUES('dirty')",
      'destination_not_empty'
    );
  });
  it.each([
    ['missing maintenance singleton', 'DELETE FROM storage.maintenance'],
    ['missing ledger singleton', 'DELETE FROM storage.instance_ledger'],
    ['charged ledger', 'UPDATE storage.instance_ledger SET used_bytes=1'],
    ['normal maintenance', "UPDATE storage.maintenance SET state='normal'"],
    ['draining maintenance', "UPDATE storage.maintenance SET state='draining'"],
    ['restore hold', "UPDATE storage.maintenance SET purpose='restore'"],
    ['missing purpose', 'UPDATE storage.maintenance SET purpose=NULL'],
    ['missing generation', 'UPDATE storage.maintenance SET generation=NULL'],
    [
      'invalid generation',
      "UPDATE storage.maintenance SET generation='00000000-0000-0000-0000-000000000000'",
    ],
    ['missing effect key', 'UPDATE storage.maintenance SET effect_key=NULL'],
    ['empty effect key', "UPDATE storage.maintenance SET effect_key=''"],
    ['invalid effect key', "UPDATE storage.maintenance SET effect_key='not valid'"],
    ['missing cut', 'UPDATE storage.maintenance SET cut_at=NULL'],
    ['infinite cut', "UPDATE storage.maintenance SET cut_at='infinity'"],
    ['negative infinite cut', "UPDATE storage.maintenance SET cut_at='-infinity'"],
    ['future cut', "UPDATE storage.maintenance SET cut_at=clock_timestamp()+interval '1 day'"],
    ['ancient cut', "UPDATE storage.maintenance SET cut_at='1900-01-01'"],
    [
      'invalid boot identity',
      "UPDATE storage.upload_owners SET boot_id='00000000-0000-0000-0000-000000000000'",
    ],
    ['infinite heartbeat', "UPDATE storage.upload_owners SET heartbeat_at='infinity'"],
    ['negative infinite heartbeat', "UPDATE storage.upload_owners SET heartbeat_at='-infinity'"],
    [
      'future heartbeat',
      "UPDATE storage.upload_owners SET heartbeat_at=clock_timestamp()+interval '1 day'",
    ],
    ['ancient heartbeat', "UPDATE storage.upload_owners SET heartbeat_at='1900-01-01'"],
  ])('rejects malformed operational rows: %s', async (_name, sql) => {
    await rejectDirty(sql, 'destination_not_pristine');
  });
});
