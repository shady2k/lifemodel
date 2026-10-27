import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createHttpsServer, request } from 'node:https';
import { Pool } from 'pg';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStorageCli } from '../../loader/src/storage-cli.js';
import { runTaskLauncher } from '../../loader/src/task-launcher.js';
import { ScriptedTaskHarness } from '../../loader/src/task-harness.js';
import { createServer as createTcpServer, connect, type Socket } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { createStorageModule } from '../../loader/src/storage-module-app.js';
import { createStorageAccess } from '../../loader/src/storage-access.js';
import { createCatalog } from '../../loader/src/storage-catalog.js';
import { createStorageObjects } from '../../loader/src/storage-objects.js';
import { createStorageObjectS3 } from '../../loader/src/storage-object-s3.js';
import { createRecordingLogger } from '../../loader/src/logger.js';
import { createTestStores, workerDatabaseUrl, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { storageObjectIdentity } from '../helpers/storage-object-identity.js';
import { createFakeStorageS3 } from '../helpers/storage-s3-server.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let stores: TestStores;
let identity: Awaited<ReturnType<typeof storageObjectIdentity>>;
let backend: Awaited<ReturnType<typeof createFakeStorageS3>>;
let app: ReturnType<typeof createStorageModule>;
let objects: ReturnType<typeof createStorageObjects>;
let s3: ReturnType<typeof createStorageObjectS3>;
let access: ReturnType<typeof createStorageAccess>;
let port: number;
async function start() {
  access = createStorageAccess({
    connectionString: workerDatabaseUrl(),
    identity: identity.identity,
  });
  s3 = createStorageObjectS3({
    endpoint: backend.endpoint,
    bucket: 'task-output',
    custody: { read: async () => backend.credentials },
    timeoutMs: 1000,
  });
  objects = createStorageObjects({ connectionString: workerDatabaseUrl(), s3, timeoutMs: 2000 });
  app = createStorageModule({
    bucket: 'task-output',
    catalog: createCatalog({ connectionString: workerDatabaseUrl() }),
    access,
    objects,
    custody: { read: async () => backend.credentials },
    check: async () => ({ ok: true }),
    logger: createRecordingLogger([]),
    tls: { ...identity.certificate, read: async () => identity.certificate },
  });
  await new Promise<void>((resolve) => app.task.server.listen(0, '127.0.0.1', resolve));
  const address = app.task.server.address();
  if (!address || typeof address === 'string') throw Error('no listener');
  port = address.port;
}
async function stop() {
  app.task.close();
  app.control.close();
  app.read.close();
  await objects.close();
  await access.close();
  s3.close();
}
async function call(
  method: string,
  path: string,
  body = Buffer.alloc(0),
  headers: Record<string, string> = {},
  token = 'a'
) {
  return new Promise<{ status: number; body: Buffer; json: any }>((resolve, reject) => {
    const req = request(
      {
        hostname: 'localhost',
        port,
        method,
        path,
        ca: identity.certificate.ca,
        headers: { authorization: `Bearer ${token}`, ...headers },
      },
      (res) => {
        res.on('error', reject);
        const chunks: Buffer[] = [];
        res.on('data', (b) => chunks.push(b));
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          let json;
          try {
            json = JSON.parse(bytes.toString());
          } catch {}
          resolve({ status: res.statusCode!, body: bytes, json });
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}
const put = (
  id: string,
  bytes: Buffer,
  name = `out/${id}.txt`,
  extra: Record<string, string> = {}
) =>
  call('PUT', `/spaces/a/objects/${id}`, bytes, {
    'x-storage-name': Buffer.from(name).toString('base64url'),
    'x-storage-length': String(bytes.length),
    'x-storage-sha256': hash(bytes),
    ...extra,
  });
const list = () => call('GET', '/spaces/a/objects?limit=100');
beforeAll(async () => {
  stores = await createTestStores();
  stores.postgres.on('error', () => undefined);
  await applyTestMigrations(stores.postgres);
  identity = await storageObjectIdentity();
  backend = await createFakeStorageS3({ bucket: 'task-output' });
});
afterAll(async () => {
  await backend.close();
  await identity.close();
  await stores.postgres.end();
  await stores.redis.quit();
  // This file owns this worker's database. Do not retain a whole migrated
  // database until suite exit: the disposable store has a finite tmpfs.
  const database = new URL(workerDatabaseUrl());
  const databaseName = database.pathname.slice(1);
  if (!/^lifemodel_test_worker_[0-9]+$/.test(databaseName)) throw Error('invalid test database');
  database.pathname = '/postgres';
  const admin = new Pool({ connectionString: database.toString(), max: 1 });
  admin.on('error', () => undefined);
  admin.on('connect', (client) => client.on('error', () => undefined));
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await admin.end();
  }
});
beforeEach(async () => {
  await stores.postgres.query(
    'TRUNCATE task_access.projections,task_access.intents,storage.spaces CASCADE'
  );
  for (const id of ['a', 'b']) {
    await stores.postgres.query('INSERT INTO storage.spaces(id) VALUES($1)', [id]);
    await stores.postgres.query(
      "INSERT INTO task_access.intents(task_id,attempt_id,launch_id,revision,mode,soft_due_at,hard_stop_at) VALUES($1,$1,$1,0,'active',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours')",
      [id]
    );
    await stores.postgres.query(
      "INSERT INTO task_access.projections(task_id,attempt_id,launch_id,job_uid,pod_uid,space_id,access_revision,intent_revision,mode,soft_due_at,hard_stop_at) SELECT task_id,attempt_id,launch_id,$2,$3,$1,0,0,'active',soft_due_at,hard_stop_at FROM task_access.intents WHERE task_id=$1",
      [id, `job-${id}`, `pod-${id}`]
    );
  }
  backend.reset();
  identity.setReviewHook(undefined);
  await start();
});
import { afterEach } from 'vitest';
afterEach(stop);
describe('task immutable object API', () => {
  it('puts, reads, lists and marks 32 durable objects; retries lost ACK and survives restart', async () => {
    const receipts = [];
    for (let n = 0; n < 32; n++) {
      const bytes = Buffer.from(`object ${n}`);
      const reply = await put(`upload-${n}`, bytes);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({
        name: `out/upload-${n}.txt`,
        size: bytes.length,
        sha256: hash(bytes),
        mark: null,
      });
      receipts.push(reply.json);
      const marked = await call(
        'POST',
        `/spaces/a/objects/${reply.json.id}/mark`,
        Buffer.from('{"role":"artifact"}')
      );
      expect(marked.status).toBe(200);
      expect((await call('GET', `/spaces/a/objects/${reply.json.id}`)).body).toEqual(bytes);
    }
    const retry = await put('upload-0', Buffer.from('object 0'));
    expect(retry.status).toBe(200);
    expect(retry.json.id).toBe(receipts[0].id);
    await stop();
    await start();
    const page = await list();
    expect(page.status).toBe(200);
    expect(page.json.objects).toHaveLength(32);
    expect(page.json.objects.every((o: any) => o.mark === 'artifact')).toBe(true);
    expect(
      (
        await call(
          'POST',
          `/spaces/a/objects/${receipts[0].id}/mark`,
          Buffer.from('{"role":"artifact"}')
        )
      ).status
    ).toBe(200);
    expect((await put('upload-0', Buffer.from('object 0'))).json.id).toBe(receipts[0].id);
    expect(
      (
        await stores.postgres.query(
          "SELECT reserved_bytes::text,charged_bytes::text FROM storage.space_quota WHERE space_id='a'"
        )
      ).rows[0]
    ).toEqual({
      reserved_bytes: '0',
      charged_bytes: String(
        Array.from({ length: 32 }, (_, n) => Buffer.byteLength(`object ${n}`)).reduce(
          (a, b) => a + b,
          0
        )
      ),
    });
  }, 30_000);
  it.each(['name', 'length', 'hash'])('rejects conflicting uploadId %s', async (field) => {
    const bytes = Buffer.from('same');
    expect((await put('once', bytes)).status).toBe(200);
    const extra =
      field === 'length'
        ? { 'x-storage-length': '5' }
        : field === 'hash'
          ? { 'x-storage-sha256': '0'.repeat(64) }
          : {};
    expect(
      (await put('once', bytes, field === 'name' ? 'other.txt' : 'out/once.txt', extra)).status
    ).toBe(409);
    expect((await list()).json.objects).toHaveLength(1);
  });
  it.each(['\ufeff', '\ufeffreport.txt', 'invoice\u202etxt.exe'])(
    'refuses Unicode format controls without aliasing names %j',
    async (name) => {
      expect((await put('format-name', Buffer.from('named bytes'), name)).status).toBe(400);
      expect((await list()).json.objects).toEqual([]);
      // Refusal never reserves this ID or strips code points into a plain alias.
      const plain = await put('format-name', Buffer.from('named bytes'), 'report.txt');
      expect(plain.status).toBe(200);
      expect(plain.json.name).toBe('report.txt');
      expect((await put('format-name', Buffer.from('named bytes'), name)).status).toBe(400);
    }
  );
  it.each(['short', 'surplus', 'hash'])('does not publish %s bytes', async (failure) => {
    const bytes = Buffer.from('payload');
    const extra =
      failure === 'short'
        ? { 'x-storage-length': '8' }
        : failure === 'surplus'
          ? { 'x-storage-length': '6' }
          : { 'x-storage-sha256': '0'.repeat(64) };
    const rejected = await put('bad', bytes, 'bad.txt', extra);
    expect(rejected.status).toBe(400);
    expect(rejected.json.error.code).toBe(failure === 'hash' ? 'hash_mismatch' : 'length_mismatch');
    expect((await list()).json.objects).toEqual([]);
  });
  it.each([
    '',
    '/absolute',
    '../escape',
    'a/../b',
    'a/./b',
    'a//b',
    'a/',
    'nul\0name',
    'control\nname',
    'a%2fb',
    'a%5Cb',
    'a\\b',
    'e\u0301.txt',
  ])('refuses unsafe display name %j', async (name) => {
    expect((await put('unsafe', Buffer.from('x'), name)).status).toBe(400);
    expect((await list()).json.objects).toEqual([]);
  });
  it('keeps both spaces confined and accepts only completed objects for mark', async () => {
    const reply = await put('own', Buffer.from('bytes'));
    expect(reply.status).toBe(200);
    expect(
      (await call('GET', `/spaces/b/objects/${reply.json.id}`, undefined, {}, 'b')).status
    ).toBe(404);
    expect((await call('GET', '/spaces/b/objects', undefined, {}, 'a')).status).toBe(403);
    expect(
      (await call('POST', '/spaces/a/objects/missing/mark', Buffer.from('{"role":"result"}')))
        .status
    ).toBe(404);
  });
  it('lists only acknowledged own-space metadata across populated-space pagination', async () => {
    const receipts: Record<string, any[]> = { a: [], b: [] };
    const marks = { a: 'artifact', b: 'result' };
    // Interleave global sequences so every page boundary can cross a foreign row.
    for (let n = 0; n < 2; n++) {
      for (const space of ['a', 'b'] as const) {
        const name = `${space}-private-name-${n}.txt`;
        const bytes = Buffer.from(`${space}-private-bytes-${n}`);
        const uploaded = await call(
          'PUT',
          `/spaces/${space}/objects/upload-${n}`,
          bytes,
          {
            'x-storage-name': Buffer.from(name).toString('base64url'),
            'x-storage-length': String(bytes.length),
            'x-storage-sha256': hash(bytes),
          },
          space
        );
        expect(uploaded.status).toBe(200);
        const marked = await call(
          'POST',
          `/spaces/${space}/objects/${uploaded.json.id}/mark`,
          Buffer.from(JSON.stringify({ role: marks[space] })),
          {},
          space
        );
        expect(marked.status).toBe(200);
        expect(marked.json).toEqual({ ...uploaded.json, mark: marks[space] });
        receipts[space].push(marked.json);
      }
    }
    for (const space of ['a', 'b'] as const) {
      const foreign = receipts[space === 'a' ? 'b' : 'a'];
      const assertNoForeignMetadata = (rows: any[]) => {
        for (const other of foreign) {
          expect(rows.map((row) => row.name)).not.toContain(other.name);
          expect(rows.map((row) => row.sha256)).not.toContain(other.sha256);
          expect(rows.map((row) => row.mark)).not.toContain(other.mark);
        }
      };
      const full = await call('GET', `/spaces/${space}/objects?limit=100`, undefined, {}, space);
      expect(full.status).toBe(200);
      assertNoForeignMetadata(full.json.objects);
      expect(full.json.objects.map((row: any) => row.id)).toEqual(
        receipts[space].map((row) => row.id)
      );
      expect(full.json.objects).toEqual(receipts[space]);
      let cursor = '';
      const seen = [];
      // Exactly two one-row pages; the full final page is already terminal.
      for (let pageIndex = 0; pageIndex < 2; pageIndex++) {
        const page = await call(
          'GET',
          `/spaces/${space}/objects?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
          undefined,
          {},
          space
        );
        expect(page.status).toBe(200);
        assertNoForeignMetadata(page.json.objects);
        expect(page.json.objects).toEqual(receipts[space].slice(pageIndex, pageIndex + 1));
        if (pageIndex === 0) {
          expect(typeof page.json.nextCursor).toBe('string');
          expect(page.json.nextCursor).not.toBe(cursor);
          cursor = page.json.nextCursor;
        } else expect(page.json.nextCursor).toBeNull();
        seen.push(...page.json.objects);
      }
      expect(seen.map((row: any) => row.id)).toEqual(receipts[space].map((row) => row.id));
      assertNoForeignMetadata(seen);
    }
  });
  it.each([0, 1, 2, 3])('returns null exactly at the end of a %i-object list', async (count) => {
    const ids = [];
    for (let n = 0; n < count; n++) {
      const uploaded = await put(`end-${n}`, Buffer.alloc(0));
      expect(uploaded.status).toBe(200);
      ids.push(uploaded.json.id);
    }
    const first = await call('GET', '/spaces/a/objects?limit=2');
    expect(first.status).toBe(200);
    expect(first.json.objects.map((row: any) => row.id)).toEqual(ids.slice(0, 2));
    if (count <= 2) expect(first.json.nextCursor).toBeNull();
    else {
      expect(typeof first.json.nextCursor).toBe('string');
      const last = await call('GET', `/spaces/a/objects?limit=2&cursor=${first.json.nextCursor}`);
      expect(last.status).toBe(200);
      expect(last.json.objects.map((row: any) => row.id)).toEqual(ids.slice(2));
      expect(last.json.nextCursor).toBeNull();
      // A valid previous cursor is still usable after its remaining rows disappear.
      await stores.postgres.query('DELETE FROM storage.objects WHERE id=$1', [ids[2]]);
      const empty = await call('GET', `/spaces/a/objects?limit=2&cursor=${first.json.nextCursor}`);
      expect(empty.status).toBe(200);
      expect(empty.json).toEqual({ objects: [], nextCursor: null });
    }
  });

  it.each([
    ...[0, 1, 64, 65].map((count) => ({
      label: `listed ${count}`,
      count,
      outputCount: 0,
      fault: '',
      outcome: 'succeeded' as const,
    })),
    ...[0, 1, 2, 64, 65].map((outputCount) => ({
      label: `outputs ${outputCount}`,
      count: 0,
      outputCount,
      fault: '',
      outcome: 'succeeded' as const,
    })),
    ...[
      'symlink',
      'subdirectory',
      'not_regular',
      'name_invalid',
      'folder_symlink',
      'lost_ack',
      'lost_mark_ack',
    ].map((fault) => ({
      label: fault,
      count: 0,
      outputCount: 1,
      fault,
      outcome: 'succeeded' as const,
    })),
    ...(['failed', 'aborted'] as const).map((outcome) => ({
      label: outcome,
      count: 0,
      outputCount: 2,
      fault: '',
      outcome,
    })),
  ])(
    'launcher collects $label through the real module and Postgres catalog',
    async ({ count, outputCount, fault, outcome }) => {
      // Cross a decimal-width boundary: ordering the selected sequence::text
      // alias lexically would skip/repeat rows despite a correct end marker.
      await stores.postgres.query(
        "SELECT setval(pg_get_serial_sequence('storage.objects','sequence'),90,false)"
      );
      const ids: string[] = [];
      for (let n = 0; n < count; n++) {
        // Escaping expands these legal names enough to force the 64 KiB cut,
        // even though the launcher requests 100 rows and allows 64 artifacts.
        const uploaded = await put(
          `artifact-${n}`,
          Buffer.from(`artifact ${n}`),
          `${n}-${'"'.repeat(1000)}`
        );
        expect(uploaded.status).toBe(200);
        const marked = await call(
          'POST',
          `/spaces/a/objects/${uploaded.json.id}/mark`,
          Buffer.from('{"role":"artifact"}')
        );
        expect(marked.status).toBe(200);
        ids.push(uploaded.json.id);
      }
      const first = await list();
      expect(first.status).toBe(200);
      expect(first.body.length).toBeLessThanOrEqual(64 * 1024);
      if (count >= 64) {
        expect(first.json.objects.length).toBeLessThan(count);
        expect(typeof first.json.nextCursor).toBe('string');
      }

      const directory = await mkdtemp(join(tmpdir(), 'launcher-real-storage-'));
      const taskIds = {
        taskId: `task_${'a'.repeat(64)}`,
        attemptId: `attempt_${'b'.repeat(64)}`,
        launchId: `launch_${'c'.repeat(64)}`,
      };
      const reports: any[] = [];
      let lostAck = false;
      const outputNames = [
        'fib.txt',
        'result.txt',
        ...Array.from({ length: 63 }, (_, n) => `file-${n}.txt`),
      ].slice(0, outputCount);
      const gateway = createHttpsServer(identity.certificate, (req, res) => {
        req.on('error', () => undefined);
        res.on('error', () => undefined);
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const part of req) chunks.push(Buffer.from(part));
          if (req.url?.startsWith('/spaces/')) {
            const forwarded = await call(req.method!, req.url, Buffer.concat(chunks), {
              ...(typeof req.headers['x-storage-name'] === 'string'
                ? { 'x-storage-name': req.headers['x-storage-name'] }
                : {}),
              ...(typeof req.headers['x-storage-length'] === 'string'
                ? { 'x-storage-length': req.headers['x-storage-length'] }
                : {}),
              ...(typeof req.headers['x-storage-sha256'] === 'string'
                ? { 'x-storage-sha256': req.headers['x-storage-sha256'] }
                : {}),
            });
            // Lose the committed artifact PUT or mark ACK, not the operation.
            if (
              !lostAck &&
              forwarded.json?.name === 'fib.txt' &&
              ((fault === 'lost_ack' && req.method === 'PUT') ||
                (fault === 'lost_mark_ack' && req.method === 'POST'))
            ) {
              lostAck = true;
              res.destroy();
              return;
            }
            res.writeHead(forwarded.status, { 'content-type': 'application/json' });
            res.end(forwarded.body);
            return;
          }
          let reply: unknown;
          if (req.url === '/task/identity') reply = taskIds;
          else if (req.url === '/task/start')
            reply = {
              ...taskIds,
              start: true,
              space: 'a',
              softDueAt: new Date(Date.now() + 50_000).toISOString(),
              hardStopAt: new Date(Date.now() + 60_000).toISOString(),
            };
          else if (req.url === '/task/briefing')
            reply = {
              ...taskIds,
              briefing: 'Produce artifacts',
              traceId: taskIds.taskId,
              parentSpanId: null,
            };
          else if (req.url === '/task/trace') reply = { accepted: true };
          else if (req.url === '/task/events') {
            const frame = JSON.parse(Buffer.concat(chunks).toString());
            if (frame.kind === 'terminal') reports.push(frame.payload);
            reply = { ...frame, receivedAt: new Date().toISOString() };
          } else {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(reply));
        })().catch(() => res.destroy());
      });
      try {
        await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
        const address = gateway.address();
        if (!address || typeof address === 'string') throw Error('no gateway listener');
        const caFile = join(directory, 'ca.pem');
        const tokenFile = join(directory, 'token');
        await writeFile(caFile, identity.certificate.ca);
        await writeFile(tokenFile, 'a');
        const env: NodeJS.ProcessEnv = {
          LIFEMODEL_STORAGE_SPACE: 'a',
          LIFEMODEL_STORAGE_ENDPOINT: `https://localhost:${address.port}`,
          LIFEMODEL_STORAGE_CA_FILE: caFile,
          LIFEMODEL_STORAGE_TOKEN_FILE: tokenFile,
        };
        for (const service of ['MODEL', 'CHANNEL']) {
          env[`LIFEMODEL_TASK_${service}_ENDPOINT`] = `https://localhost:${address.port}`;
          env[`LIFEMODEL_TASK_${service}_CA_FILE`] = caFile;
          env[`LIFEMODEL_TASK_${service}_TOKEN_FILE`] = tokenFile;
        }
        const resultText = 'The final answer survives artifact collection.';
        const status = await runTaskLauncher({
          env,
          workDirectory: directory,
          harness: (onEvent) => {
            const scripted = new ScriptedTaskHarness({
              onEvent,
              terminal: { outcome, result: resultText },
            });
            return {
              start: async (briefing) => {
                expect(briefing.text).toContain(`${join(directory, 'outputs')}/`);
                expect(briefing.text.endsWith('\n\nProduce artifacts')).toBe(true);
                const outputs = join(directory, 'outputs');
                // Folder must exist before the agent starts. A file elsewhere
                // must never enter the catalog or owner attachments.
                await writeFile(join(directory, 'outside.txt'), 'not delivered');
                for (const name of outputNames)
                  await writeFile(join(outputs, name), `contents of ${name}`);
                if (fault === 'symlink') await symlink('../outside.txt', join(outputs, 'link'));
                if (fault === 'subdirectory') await mkdir(join(outputs, 'nested'));
                if (fault === 'not_regular') execFileSync('mkfifo', [join(outputs, 'pipe')]);
                if (fault === 'name_invalid')
                  await writeFile(join(outputs, 'bad\u202ename.txt'), 'not delivered');
                if (fault === 'folder_symlink') {
                  await rm(outputs, { recursive: true });
                  await symlink(directory, outputs);
                }
                return scripted.start(briefing);
              },
              abort: () => scripted.abort(),
              intakeReady: scripted.intakeReady,
              steer: (text) => scripted.steer(text),
              wrap: () => scripted.wrap(),
            };
          },
        });
        const reason =
          count === 65
            ? 'artifact_limit'
            : outputCount === 65
              ? 'output_limit'
              : fault && !['lost_ack', 'lost_mark_ack'].includes(fault)
                ? `output_${fault === 'folder_symlink' ? 'symlink' : fault}`
                : undefined;
        expect(status, JSON.stringify(reports)).toBe(reason || outcome !== 'succeeded' ? 1 : 0);
        expect(reports).toHaveLength(1);
        const catalog: any[] = [];
        let next: string | null = null;
        do {
          const page = await call(
            'GET',
            `/spaces/a/objects?limit=100${next ? `&cursor=${next}` : ''}`
          );
          expect(page.status).toBe(200);
          catalog.push(...page.json.objects);
          next = page.json.nextCursor;
        } while (next !== null);
        const uploadedOutputs = catalog.filter(
          (row: any) => row.mark === 'artifact' && outputNames.includes(row.name)
        );
        const expectedOutputs = !reason && outcome === 'succeeded' ? outputNames : [];
        expect(uploadedOutputs.map((row: any) => row.name).sort()).toEqual(
          [...expectedOutputs].sort()
        );
        expect(reports[0]).toMatchObject({
          outcome: reason ? 'failed' : outcome,
          artifactObjectIds:
            reason || outcome !== 'succeeded'
              ? []
              : [...ids, ...uploadedOutputs.map((row: any) => row.id)],
          ...(reason ? { reasonCode: reason } : {}),
        });
        if (!reason && outcome !== 'failed') expect(reports[0]).not.toHaveProperty('reasonCode');
        expect(catalog.some((row: any) => row.name === 'outside.txt')).toBe(false);
        expect(catalog.some((row: any) => row.name.startsWith('launcher_'))).toBe(false);
        expect(catalog.find((row: any) => row.mark === 'result').name).toBe('result.txt');
        expect(catalog.some((row: any) => row.mark === 'log')).toBe(false);
        expect(catalog.some((row: any) => row.name === 'log.jsonl')).toBe(false);
        expect(reports[0]).not.toHaveProperty('logObjectId');
        if (['lost_ack', 'lost_mark_ack'].includes(fault)) {
          expect(lostAck).toBe(true);
          expect(uploadedOutputs).toHaveLength(1);
        }
        for (const row of uploadedOutputs) {
          const downloaded = await call('GET', `/spaces/a/objects/${row.id}`);
          expect(downloaded.body.toString()).toBe(`contents of ${row.name}`);
        }
        expect(typeof reports[0].resultObjectId).toBe('string');
        const resultRow = await stores.postgres.query(
          'SELECT mark FROM storage.objects WHERE id=$1',
          [reports[0].resultObjectId]
        );
        expect(resultRow.rows[0].mark).toBe('result');
        const result = await call('GET', `/spaces/a/objects/${reports[0].resultObjectId}`);
        expect(result.status).toBe(200);
        expect(result.body.toString()).toBe(resultText);
      } finally {
        gateway.closeAllConnections();
        await new Promise<void>((resolve) => gateway.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000
  );

  it('refuses a cursor minted for a different space', async () => {
    for (const id of ['one', 'two']) {
      const reply = await call(
        'PUT',
        `/spaces/b/objects/${id}`,
        Buffer.alloc(0),
        {
          'x-storage-name': Buffer.from(`${id}.txt`).toString('base64url'),
          'x-storage-length': '0',
          'x-storage-sha256': hash(Buffer.alloc(0)),
        },
        'b'
      );
      expect(reply.status).toBe(200);
    }
    const foreign = await call('GET', '/spaces/b/objects?limit=1', undefined, {}, 'b');
    expect(foreign.status).toBe(200);
    expect(typeof foreign.json.nextCursor).toBe('string');
    const reply = await call('GET', `/spaces/a/objects?cursor=${foreign.json.nextCursor}`);
    expect(reply.status).toBe(400);
    expect(reply.json.error.code).toBe('invalid_request');
  });
  it.each([
    ['ten-byte', Buffer.from('0123456789'), 'bytes=0-10'],
    ['empty', Buffer.alloc(0), 'bytes=0-0'],
  ])(
    'refuses an end beyond the %s object before contacting any backend',
    async (id, bytes, range) => {
      const uploaded = await put(id, bytes);
      expect(uploaded.status).toBe(200);
      const before = backend.requests.length;
      // Seaweed clamps oversized range ends; a client error must never reach it.
      backend.hooks.beforeGet = () => ({
        status: 206,
        headers: {
          'content-range': 'bytes 0-9/10',
          'content-length': '10',
        },
      });
      const reply = await call('GET', `/spaces/a/objects/${uploaded.json.id}`, undefined, {
        range,
      });
      expect(reply.status).toBe(416);
      expect(reply.json.error.code).toBe('invalid_range');
      expect(backend.requests.length).toBe(before);
    }
  );
  it('denies foreign tokens for existing and random IDs before catalog or backend reads', async () => {
    const uploaded = await put('private', Buffer.from('private bytes'));
    expect(uploaded.status).toBe(200);
    const before = backend.requests.length;
    for (const id of [uploaded.json.id, '8b5cc2de-ad1a-49de-a774-a5c8d82eece4'])
      expect((await call('GET', `/spaces/a/objects/${id}`, undefined, {}, 'b')).status).toBe(403);
    // Fault the read surface itself, without replacing any adapter or authority.
    // An attempted catalog read would now return 503, not either required 403.
    await stores.postgres.query('ALTER TABLE storage.objects RENAME TO objects_read_forbidden');
    try {
      for (const id of [uploaded.json.id, '8b5cc2de-ad1a-49de-a774-a5c8d82eece4'])
        expect((await call('GET', `/spaces/a/objects/${id}`, undefined, {}, 'b')).status).toBe(403);
      expect(backend.requests.length).toBe(before);
    } finally {
      await stores.postgres.query('ALTER TABLE storage.objects_read_forbidden RENAME TO objects');
    }
  });
  it('bounds ranges, cursors, listing and unknown selectors', async () => {
    const reply = await put('range', Buffer.from('0123456789'));
    expect(reply.status).toBe(200);
    const range = await call('GET', `/spaces/a/objects/${reply.json.id}`, undefined, {
      range: 'bytes=2-5',
    });
    expect(range.status).toBe(206);
    expect(range.body.toString()).toBe('2345');
    for (const range of ['bytes=0-4194304', 'bytes=-5', 'bytes=3-2', 'bytes=0-1,3-4'])
      expect(
        (await call('GET', `/spaces/a/objects/${reply.json.id}`, undefined, { range })).status
      ).toBe(416);
    for (const query of ['limit=101', 'limit=0', 'cursor=bad', 'bucket=other', 'prefix=root'])
      expect((await call('GET', `/spaces/a/objects?${query}`)).status).toBe(400);
    await put('second', Buffer.from('second'));
    const first = await call('GET', '/spaces/a/objects?limit=1');
    expect(first.json.objects).toHaveLength(1);
    expect(typeof first.json.nextCursor).toBe('string');
    const next = await call('GET', `/spaces/a/objects?limit=1&cursor=${first.json.nextCursor}`);
    expect(next.json.objects[0].id).not.toBe(reply.json.id);
  });
  it('reserves transactionally before accepting bytes, rejects quota and exposes tested lease expiry selection', async () => {
    await stores.postgres.query(
      "INSERT INTO storage.space_quota(space_id,limit_bytes) VALUES('a',5)"
    );
    const replies = await Promise.all([
      put('one', Buffer.from('1234')),
      put('two', Buffer.from('5678')),
    ]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 507]);
    expect((await list()).json.objects).toHaveLength(1);
    await stores.postgres.query(
      "UPDATE storage.space_quota SET limit_bytes=100 WHERE space_id='a'"
    );
    await put('incomplete', Buffer.from('x'), 'incomplete', { 'x-storage-length': '2' });
    expect(await objects.expiredUploads()).toEqual([]);
    await stores.postgres.query(
      "UPDATE storage.upload_intents SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE upload_id='incomplete'"
    );
    expect((await objects.expiredUploads()).map((row) => row.uploadId)).toEqual(['incomplete']);
  });

  it('a crash after private S3 write never lists pending intents, and retry uses a fresh immutable key', async () => {
    let written!: () => void;
    const didWrite = new Promise<void>((resolve) => {
      written = resolve;
    });
    backend.hooks.afterWrite = () => {
      written();
      return 'hang';
    };
    const pending = put('crash', Buffer.from('surviving bytes'));
    void pending.catch(() => undefined);
    await didWrite;
    expect((await list()).json.objects).toEqual([]);
    const attempts = await stores.postgres.query(
      "SELECT s3_key FROM storage.upload_attempts WHERE upload_id='crash'"
    );
    expect(attempts.rows).toHaveLength(1);
    expect(backend.objects.has(attempts.rows[0].s3_key)).toBe(true);
    await stop();
    await expect(pending).rejects.toBeDefined();
    delete backend.hooks.afterWrite;
    await start();
    expect((await list()).json.objects).toEqual([]);
    const retry = await put('crash', Buffer.from('surviving bytes'));
    expect(retry.status).toBe(200);
    expect((await list()).json.objects).toHaveLength(1);
    const keys = (
      await stores.postgres.query(
        "SELECT s3_key FROM storage.upload_attempts WHERE upload_id='crash'"
      )
    ).rows.map((row) => row.s3_key);
    expect(new Set(keys).size).toBe(2);
  });
  it('a failed persistence/checksum check cannot publish or ACK', async () => {
    backend.hooks.beforeHead = () => ({
      status: 200,
      headers: { 'x-amz-checksum-sha256': Buffer.alloc(32).toString('base64') },
    });
    const failed = await put('verify', Buffer.from('private bytes'));
    expect(failed.status).toBe(503);
    expect((await list()).json.objects).toEqual([]);
    delete backend.hooks.beforeHead;
    expect((await put('verify', Buffer.from('private bytes'))).status).toBe(200);
  });
  it('a lost application ACK replays exactly the committed receipt without another backend PUT', async () => {
    const bytes = Buffer.from('ack');
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          hostname: 'localhost',
          port,
          method: 'PUT',
          path: '/spaces/a/objects/lost',
          ca: identity.certificate.ca,
          headers: {
            authorization: 'Bearer a',
            'x-storage-name': Buffer.from('lost.txt').toString('base64url'),
            'x-storage-length': String(bytes.length),
            'x-storage-sha256': hash(bytes),
          },
        },
        (res) => {
          res.on('error', () => undefined);
          res.destroy();
          resolve();
        }
      );
      req.on('error', reject);
      req.end(bytes);
    });
    const saved = (
      await stores.postgres.query(
        "SELECT v.receipt FROM storage.object_versions v JOIN storage.upload_intents i ON i.object_id=v.object_id WHERE i.upload_id='lost'"
      )
    ).rows[0].receipt;
    const writes = backend.requests.filter((row) => row.method === 'PUT').length;
    const retry = await put('lost', bytes, 'lost.txt');
    expect(retry.status).toBe(200);
    expect(retry.json).toEqual(saved);
    expect(backend.requests.filter((row) => row.method === 'PUT')).toHaveLength(writes);
  });
  it('rechecks authority on GET dispatch after a backend delay; no denied bytes escape', async () => {
    const bytes = Buffer.from('protected');
    const saved = await put('guarded', bytes);
    expect(saved.status).toBe(200);
    backend.hooks.beforeGet = async () => {
      await stores.postgres.query(
        "UPDATE task_access.intents SET mode='revoked',revision=revision+1 WHERE task_id='a'"
      );
    };
    const read = await call('GET', `/spaces/a/objects/${saved.json.id}`);
    expect(read.status).toBe(403);
    expect(read.body.includes(bytes)).toBe(false);
  });
  it('serializes simultaneous same-upload reservations and returns one receipt', async () => {
    const replies = await Promise.all([
      put('concurrent', Buffer.from('same')),
      put('concurrent', Buffer.from('same')),
    ]);
    expect(replies.map((row) => row.status)).toEqual([200, 200]);
    expect(replies[0].json).toEqual(replies[1].json);
    expect((await list()).json.objects).toHaveLength(1);
    expect(
      (
        await stores.postgres.query(
          "SELECT charged_bytes::text,reserved_bytes::text FROM storage.space_quota WHERE space_id='a'"
        )
      ).rows[0]
    ).toEqual({ charged_bytes: '4', reserved_bytes: '0' });
  });
  it('replays the one receipt when a duplicate PUT loses its attempt to the completing sibling', async () => {
    const bytes = Buffer.from('race');
    const before = identity.reviews;
    let reached: () => void = () => undefined;
    let release: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The initial dispatch, the reservation and the attempt publication are the
    // first three guarded calls. The third one runs before begin_attempt, with
    // the intent read already done and no lock or lease held while it waits.
    identity.setReviewHook(async () => {
      if (identity.reviews - before !== 3) return;
      reached();
      await gate;
    });
    const duplicate = put('race', bytes);
    try {
      await waiting;
      const winner = await put('race', bytes);
      expect(winner.status).toBe(200);
      release();
      const replay = await duplicate;
      expect(replay.status).toBe(200);
      expect(replay.json).toEqual(winner.json);
      // The duplicate never reaches the backend: one transferred object only.
      expect(backend.requests.filter((row) => row.method === 'PUT')).toHaveLength(1);
      expect((await list()).json.objects).toHaveLength(1);
      expect(
        (
          await stores.postgres.query(
            "SELECT charged_bytes::text,reserved_bytes::text FROM storage.space_quota WHERE space_id='a'"
          )
        ).rows[0]
      ).toEqual({ charged_bytes: '4', reserved_bytes: '0' });
      // The replay is not a licence to overwrite: different bytes still conflict.
      const different = await put('race', Buffer.from('other'));
      expect(different.status).toBe(409);
      expect(different.json.error.code).toBe('upload_conflict');
    } finally {
      release();
    }
  }, 20_000);
  it('keeps a genuinely expired upload a retryable conflict, never a replay', async () => {
    const bytes = Buffer.from('expire');
    const name = 'out/expired.txt';
    await stores.postgres.query('SELECT storage.reserve_upload($1,$2,$3,$4,$5,$6,$7)', [
      'a',
      'expired',
      randomUUID(),
      name,
      bytes.length,
      hash(bytes),
      3600,
    ]);
    await stores.postgres.query(
      "UPDATE storage.upload_intents SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE space_id='a' AND upload_id='expired'"
    );
    const expired = await put('expired', bytes);
    expect(expired.status).toBe(409);
    expect(expired.json.error.code).toBe('upload_expired');
    const retried = await put('expired', bytes);
    expect(retried.status).toBe(200);
    expect(retried.json).toMatchObject({ name, size: bytes.length, sha256: hash(bytes) });
  }, 20_000);
  it('bounds request headers and mark body before consuming unbounded input', async () => {
    const reply = await put('body', Buffer.from('a'));
    expect(reply.status).toBe(200);
    expect(
      (await call('POST', `/spaces/a/objects/${reply.json.id}/mark`, Buffer.alloc(129, 32))).status
    ).toBe(413);
    expect((await put('longname', Buffer.from('a'), 'a'.repeat(1025))).status).toBe(400);
    expect(
      (
        await put('invalidutf', Buffer.from('a'), 'name', {
          'x-storage-name': Buffer.from([0xff]).toString('base64url'),
        })
      ).status
    ).toBe(400);
  });

  it('survives a real dropped Postgres TCP connection and reports unavailable, never empty', async () => {
    const upstream = new URL(workerDatabaseUrl());
    const sockets = new Set<Socket>();
    const upstreamHost = upstream.hostname;
    const upstreamPort = Number(upstream.port || 5432);
    let drop = false;
    const proxy = createTcpServer((front) => {
      sockets.add(front);
      front.on('error', () => undefined);
      front.on('close', () => sockets.delete(front));
      const back = connect({ host: upstreamHost, port: upstreamPort });
      sockets.add(back);
      back.on('error', () => front.destroy());
      back.on('close', () => {
        sockets.delete(back);
        front.destroy();
      });
      front.on('data', (bytes) => {
        if (drop) {
          front.destroy();
          back.destroy();
        } else back.write(bytes);
      });
      back.on('data', (bytes) => front.write(bytes));
    });
    proxy.on('error', () => undefined);
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (!address || typeof address === 'string') throw Error('no proxy');
    upstream.hostname = '127.0.0.1';
    upstream.port = String(address.port);
    const broken = createStorageObjects({
      connectionString: upstream.toString(),
      s3,
      timeoutMs: 200,
    });
    try {
      expect(await broken.expiredUploads()).toEqual([]);
      drop = true;
      await expect(broken.expiredUploads()).rejects.toMatchObject({
        status: 503,
        code: 'catalog_unavailable',
        id: expect.any(String),
      });
      expect((await list()).status).toBe(200);
    } finally {
      await broken.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it('streams a large GET across bounded guarded chunks without losing a drain event', async () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 17, 97);
    const saved = await put('large', bytes);
    expect(saved.status).toBe(200);
    const before = identity.reviews;
    const read = await call('GET', `/spaces/a/objects/${saved.json.id}`);
    expect(read.status).toBe(200);
    expect(read.body.length).toBe(bytes.length);
    expect(hash(read.body)).toBe(hash(bytes));
    expect(identity.reviews - before).toBeGreaterThan(2);
  }, 30_000);
  it('revoke cancels a stalled mark body rather than waiting for the client', async () => {
    const saved = await put('stalled', Buffer.from('a'));
    expect(saved.status).toBe(200);
    const before = identity.reviews;
    const requestBody = new Promise<void>((resolve, reject) => {
      const req = request(
        {
          hostname: 'localhost',
          port,
          method: 'POST',
          path: `/spaces/a/objects/${saved.json.id}/mark`,
          ca: identity.certificate.ca,
          headers: { authorization: 'Bearer a', 'content-length': '10' },
        },
        (res) => {
          res.on('error', () => undefined);
          res.resume();
          res.on('end', () => reject(Error('unexpected ACK')));
        }
      );
      req.on('error', () => resolve());
      req.write('{');
      void (async () => {
        await expect.poll(() => identity.reviews).toBeGreaterThan(before);
        await access.revoke('a', '0', 'stalled-mark');
      })().catch(reject);
    });
    await requestBody;
  });

  it('readiness requires object DDL, including publication functions', async () => {
    expect(await objects.check(new AbortController().signal)).toBe(true);
    await stores.postgres.query(
      'ALTER FUNCTION storage.complete_upload(text,text,uuid) RENAME TO unavailable_complete_upload'
    );
    try {
      expect(await objects.check(new AbortController().signal)).toBe(false);
    } finally {
      await stores.postgres.query(
        'ALTER FUNCTION storage.unavailable_complete_upload(text,text,uuid) RENAME TO complete_upload'
      );
    }
  });
  it('rejects cursor overflow as input error, not a failed catalog', async () => {
    const cursor = Buffer.from(JSON.stringify(['a', '9999999999999999999'])).toString('base64url');
    expect((await call('GET', `/spaces/a/objects?cursor=${cursor}`)).status).toBe(400);
  });

  it('the shipped CLI puts, lists, marks and gets through the real module and catalog', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'storage-cli-module-'));
    try {
      await writeFile(join(directory, 'token'), 'a');
      await writeFile(join(directory, 'ca'), identity.certificate.ca);
      await writeFile(join(directory, 'input.txt'), 'cli bytes');
      let output = '';
      let error = '';
      const options = {
        cwd: directory,
        env: {
          LIFEMODEL_STORAGE_ENDPOINT: `https://localhost:${port}`,
          LIFEMODEL_STORAGE_SPACE: 'a',
          LIFEMODEL_STORAGE_TOKEN_FILE: join(directory, 'token'),
          LIFEMODEL_STORAGE_CA_FILE: join(directory, 'ca'),
        },
        stdout: (text: string) => {
          output = text;
        },
        stderr: (text: string) => {
          error = text;
        },
      };
      expect(await runStorageCli(['put', 'input.txt', '--upload-id', 'cli'], options), error).toBe(
        0
      );
      const receipt = JSON.parse(output);
      expect(await runStorageCli(['mark', receipt.id, 'result'], options), error).toBe(0);
      expect(await runStorageCli(['list'], options), error).toBe(0);
      expect(JSON.parse(output).objects).toEqual([{ ...receipt, mark: 'result' }]);
      expect(await runStorageCli(['get', receipt.id, 'download.txt'], options), error).toBe(0);
      expect(JSON.parse(output)).toEqual({
        id: receipt.id,
        size: receipt.size,
        sha256: receipt.sha256,
      });
      expect(await readFile(join(directory, 'download.txt'), 'utf8')).toBe('cli bytes');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('no second GET chunk dispatches after revoke ACK', async () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 17, 120);
    const saved = await put('mid-read', bytes);
    expect(saved.status).toBe(200);
    let reads = 0;
    backend.hooks.beforeGet = async () => {
      reads++;
      if (reads === 2) await access.revoke('a', '0', 'get-after-first');
    };
    const seen: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          hostname: 'localhost',
          port,
          method: 'GET',
          path: `/spaces/a/objects/${saved.json.id}`,
          ca: identity.certificate.ca,
          headers: { authorization: 'Bearer a' },
        },
        (res) => {
          res.on('data', (part) => seen.push(Buffer.from(part)));
          res.on('error', () => resolve());
          res.on('aborted', () => resolve());
          res.on('end', resolve);
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(reads).toBe(2);
    expect(Buffer.concat(seen).length).toBe(4 * 1024 * 1024);
  }, 30_000);

  it('coalesces incoming TCP fragments into bounded PUT authorization chunks', async () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 17, 121);
    const before = identity.reviews;
    const saved = await put('bounded-put', bytes);
    expect(saved.status).toBe(200);
    // Initial operation, reservation, attempt, two chunks, publication, ACK.
    expect(identity.reviews - before).toBe(7);
  }, 30_000);

  it('supports an empty immutable object and never turns its display name into a backend key', async () => {
    const saved = await put('empty', Buffer.alloc(0), 'quote".txt');
    expect(saved.status).toBe(200);
    expect((await call('GET', `/spaces/a/objects/${saved.json.id}`)).body).toEqual(Buffer.alloc(0));
    expect([...backend.objects.keys()].every((key) => /^private\/[0-9a-f-]+$/.test(key))).toBe(
      true
    );
    expect(
      (await call('POST', `/spaces/a/objects/${saved.json.id}/mark`, Buffer.from('{"role":"log"}')))
        .status
    ).toBe(200);
    expect(
      (
        await call(
          'POST',
          `/spaces/a/objects/${saved.json.id}/mark`,
          Buffer.from('{"role":"result"}')
        )
      ).status
    ).toBe(409);
  });
});
