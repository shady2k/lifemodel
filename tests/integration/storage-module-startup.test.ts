/** The production module must boot through a refused first PostgreSQL connection. */
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { Pool } from 'pg';
import { workerDatabaseUrl } from '../helpers/test-stores.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createRetentionHarness, sha256 } from '../helpers/storage-retention-harness.js';

let h: Awaited<ReturnType<typeof createRetentionHarness>>;
let bao: ReturnType<typeof createServer>;
let baoAddress: string;
beforeAll(async () => {
  h = await createRetentionHarness('lifemodel-storage');
  bao = createServer((req, res) => {
    req.resume();
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/auth/kubernetes/login')
      res.end(
        JSON.stringify({
          auth: { client_token: 'fixture-token', lease_duration: 3600 },
        })
      );
    else if (req.url === '/v1/lifemodel/data/storage/seaweed')
      res.end(JSON.stringify({ data: { data: h.backend.credentials } }));
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => bao.listen(0, '127.0.0.1', resolve));
  const address = bao.address();
  if (!address || typeof address === 'string') throw Error('Bao fixture failed');
  baoAddress = `http://127.0.0.1:${address.port}`;
  // The health listing is a bucket probe, distinct from the GC listing.
  h.backend.hooks.beforeBucketCheck = () => ({ status: 200 });
}, 30_000);
afterAll(async () => {
  await h?.close();
  bao?.closeAllConnections();
  if (bao) await new Promise<void>((resolve) => bao.close(() => resolve()));
  // This process test adds one database to the bounded store. Release it rather
  // than leaving migrated catalogs behind for the rest of the full suite.
  const database = new URL(workerDatabaseUrl());
  const name = database.pathname.slice(1);
  database.pathname = '/postgres';
  const admin = new Pool({ connectionString: database.toString(), max: 1 });
  try {
    await admin.query(`DROP DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
}, 20_000);

it('stays alive and unready with Postgres refusing connections, then becomes ready and accepts a PUT without restart', async () => {
  h.sqlProxy.drop();
  const child = await h.start({
    baoAddress,
    serviceAccount: dirname(h.identity.options.tokenFile),
  });
  const port = (child.ports as typeof child.ports & { status: number }).status;
  const status = () => fetch(`http://127.0.0.1:${port}/status`);
  expect((await fetch(`http://127.0.0.1:${port}/livez`)).status).toBe(200);
  expect((await status()).status).toBe(503);
  expect(child.process.exitCode).toBeNull();
  const bytes = Buffer.from('no');
  const denied = await h.call('task', 'PUT', '/spaces/not-ready/objects/output', bytes, 'a', {
    'x-storage-name': Buffer.from('output.txt').toString('base64url'),
    'x-storage-length': String(bytes.length),
    'x-storage-sha256': sha256(bytes),
  });
  expect(denied.status).toBe(503);
  expect(['access_unavailable', 'upload_owner_unavailable', 'maintenance_unavailable']).toContain(
    denied.json.error.code
  );
  expect(h.backend.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);

  h.sqlProxy.restore();
  // No readiness/PUT call drives this retry: the owner registers in the background.
  await expect
    .poll(
      async () =>
        Number(
          (await h.stores.postgres.query('SELECT count(*) AS n FROM storage.upload_owners')).rows[0]
            .n
        ),
      { timeout: 15_000 }
    )
    .toBe(1);
  await expect.poll(async () => (await status()).status, { timeout: 10_000 }).toBe(200);
  const space = await h.prepare();
  const result = await h.upload(space);
  expect(h.backend.objects.get(result.key)?.bytes).toEqual(result.bytes);
  expect(child.process.exitCode).toBeNull();
  expect(child.process.signalCode).toBeNull();
}, 40_000);
