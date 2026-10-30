/** Web service identity has one artifact read, never generic space access. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { request } from 'node:https';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageTaskArtifactReader } from '../../src/storage/task-artifact-reader.js';
import { createTaskService } from '../../src/core/task-service.js';
import type { TaskRecord } from '../../src/ports/tasks.js';
import { createRetentionHarness, gate } from '../helpers/storage-retention-harness.js';

let h: Awaited<ReturnType<typeof createRetentionHarness>>;
beforeAll(async () => {
  h = await createRetentionHarness();
}, 30_000);
beforeEach(async () => {
  await h.reset();
}, 20_000);
afterEach(async () => {
  await h.cleanup();
}, 20_000);
afterAll(async () => {
  await h?.close();
}, 20_000);

const artifactPath = (id: string) => `/artifacts/${id}`;

describe('narrow storage read listener artifact operation', () => {
  it('reads a delivered file with the real core audience on the sealed-space route, never the web route', async () => {
    const space = await h.prepare();
    const bytes = Buffer.from('verified delivered content: ' + 'x'.repeat(9000));
    const artifact = await h.upload(space, 'a', 'output', bytes);
    // A flat delivered name is valid input to cognition; task storage also
    // accepts names with paths, which this deliberately narrower surface refuses.
    await h.stores.postgres.query('UPDATE storage.objects SET name=$2 WHERE id=$1', [
      artifact.id,
      'output.txt',
    ]);
    const sealReceipt = await h.seal(space);
    const directory = await mkdtemp(join(tmpdir(), 'core-task-file-'));
    const tokenFile = join(directory, 'token');
    const caFile = join(directory, 'ca');
    await writeFile(tokenFile, 'coreRead');
    await writeFile(caFile, h.identity.certificate.ca);
    const reader = new StorageTaskArtifactReader({
      endpoint: `https://localhost:${h.child().ports.read}`,
      tokenFile,
      caFile,
      requestTimeoutMs: 5000,
    });
    const task = { id: 'a', state: 'done', sealReceipt } as TaskRecord;
    const service = createTaskService({
      tasks: { read: async () => task } as never,
      mailbox: {} as never,
      artifactReader: reader,
    });
    try {
      expect(await service.readFile('a', 'output.txt')).toEqual({
        name: 'output.txt',
        size: bytes.length,
        bytesRead: 8192,
        truncated: true,
        text: bytes.subarray(0, 8192).toString('utf8'),
      });
      await expect(
        reader.openTaskArtifact(artifact.id, 'bytes=0-7', AbortSignal.timeout(5000))
      ).rejects.toMatchObject({ status: 503 });
      // A web identity cannot silently substitute for the core space capability.
      await writeFile(tokenFile, 'web');
      await expect(service.readFile('a', 'output.txt')).rejects.toMatchObject({
        code: 'file_unavailable',
      });
      await writeFile(tokenFile, 'coreRead');
      h.identity.deadPods.add('core');
      await expect(service.readFile('a', 'output.txt')).rejects.toMatchObject({
        code: 'file_unavailable',
      });
    } finally {
      reader.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('resolves a marked UUID server-side, with bounded ranges and no web space/list/write access', async () => {
    const a = await h.artifact('a');
    const b = await h.artifact('b');
    for (const artifact of [a, b]) {
      const reply = await h.call('read', 'GET', artifactPath(artifact.id), undefined, 'web');
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual(artifact.bytes);
      const range = await h.call('read', 'GET', artifactPath(artifact.id), undefined, 'web', {
        range: 'bytes=1-4',
      });
      expect(range.status).toBe(206);
      expect(range.body).toEqual(artifact.bytes.subarray(1, 5));
      for (const path of [
        `/spaces/${artifact.space}/objects`,
        `/spaces/${artifact.space}/objects/${artifact.id}`,
      ])
        expect((await h.call('read', 'GET', path, undefined, 'web')).status).toBe(403);
      for (const token of ['coreRead', 'core', 'a'])
        expect(
          (await h.call('read', 'GET', artifactPath(artifact.id), undefined, token)).status
        ).toBe(403);
      for (const listener of ['control', 'task'] as const)
        expect(
          (await h.call(listener, 'GET', artifactPath(artifact.id), undefined, 'web')).status
        ).toBe(404);
      expect((await h.call('read', 'POST', artifactPath(artifact.id), {}, 'web')).status).toBe(404);
      for (const range of ['bytes=0-', 'bytes=-4', 'bytes=0-1,3-4', 'bytes=4-1', 'bytes=0-4194304'])
        expect(
          (await h.call('read', 'GET', artifactPath(artifact.id), undefined, 'web', { range }))
            .status
        ).toBe(416);
    }
    for (const path of [
      '/artifacts',
      '/artifacts/../identity',
      `/artifacts/%2e%2e%2f${a.id}`,
      `/artifacts/${a.id}/extra`,
      `/artifacts/${a.id}?space=${b.space}`,
    ])
      expect((await h.call('read', 'GET', path, undefined, 'web')).status).toBe(404);
    expect((await h.call('read', 'GET', artifactPath(randomUUID()), undefined, 'web')).status).toBe(
      404
    );
  }, 30_000);

  it('refuses unmarked, tombstoned, unavailable and deleted-policy artifacts, and rechecks web Pod liveness', async () => {
    const space = await h.prepare();
    const artifact = await h.upload(space);
    await h.stores.postgres.query('UPDATE storage.objects SET mark=NULL WHERE id=$1', [
      artifact.id,
    ]);
    expect((await h.call('read', 'GET', artifactPath(artifact.id), undefined, 'web')).status).toBe(
      404
    );
    await h.stores.postgres.query("UPDATE storage.objects SET mark='result' WHERE id=$1", [
      artifact.id,
    ]);
    await h.seal(space);
    h.identity.deadPods.add('web');
    expect((await h.call('read', 'GET', artifactPath(artifact.id), undefined, 'web')).status).toBe(
      403
    );
    h.identity.deadPods.clear();
    await h.stores.postgres.query(
      "INSERT INTO storage.object_tombstones(object_id,space_id,reason) VALUES($1,$2,'seal_unmarked')",
      [artifact.id, space]
    );
    expect((await h.call('read', 'GET', artifactPath(artifact.id), undefined, 'web')).status).toBe(
      404
    );
    await h.stores.postgres.query('DELETE FROM storage.object_tombstones WHERE object_id=$1', [
      artifact.id,
    ]);
    await h.stores.postgres.query(
      "INSERT INTO storage.version_availability(object_id,generation,status) VALUES($1,$2,'missing')",
      [artifact.id, randomUUID()]
    );
    expect((await h.call('read', 'GET', artifactPath(artifact.id), undefined, 'web')).status).toBe(
      404
    );
    await h.stores.postgres.query(
      "UPDATE storage.version_availability SET status='available' WHERE object_id=$1",
      [artifact.id]
    );
    await h.stores.postgres.query(
      "UPDATE storage.retention_policies SET state='deleting' WHERE space_id=$1",
      [space]
    );
    expect((await h.call('read', 'GET', artifactPath(artifact.id), undefined, 'web')).status).toBe(
      404
    );
  }, 30_000);

  it.each(['tombstone', 'deleting', 'dead-web'] as const)(
    'ends an in-flight artifact response without completion after %s',
    async (failure) => {
      const chunkBytes = 4 * 1024 * 1024;
      const artifact = await h.artifact('a', Buffer.alloc(chunkBytes + 64, 97));
      const blocked = gate();
      const release = gate();
      const firstBytes = gate();
      h.releases.push(release.resolve);
      h.backend.hooks.beforeGet = async (read) => {
        if (
          read.key === artifact.key &&
          read.headers.range === `bytes=${chunkBytes}-${chunkBytes + 63}`
        ) {
          blocked.resolve();
          await release.promise;
        }
      };
      const downloaded = new Promise<{ complete: boolean; received: number }>((resolve, reject) => {
        const req = request(
          {
            hostname: 'localhost',
            port: h.child().ports.read,
            path: artifactPath(artifact.id),
            ca: h.identity.certificate.ca,
            agent: false,
            headers: { authorization: 'Bearer web' },
          },
          (res) => {
            let received = 0;
            res.on('error', () => undefined);
            res.on('data', (bytes: Buffer) => {
              received += bytes.length;
              firstBytes.resolve();
            });
            res.on('close', () => resolve({ complete: res.complete, received }));
          }
        );
        req.on('error', reject);
        req.on('socket', (socket) => socket.on('error', () => undefined));
        req.setTimeout(15_000, () => req.destroy(Error('artifact test deadline')));
        req.end();
      });
      // Install rejection handling before awaiting other independently arriving events.
      void downloaded.catch(() => undefined);
      await Promise.all([blocked.promise, firstBytes.promise]);
      expect(
        (
          await h.stores.postgres.query(
            'SELECT count(*)::int AS n FROM storage.read_leases WHERE space_id=$1',
            [artifact.space]
          )
        ).rows[0].n
      ).toBe(1);
      if (failure === 'tombstone') {
        await h.stores.postgres.query(
          "INSERT INTO storage.object_tombstones(object_id,space_id,reason) VALUES($1,$2,'seal_unmarked')",
          [artifact.id, artifact.space]
        );
      } else if (failure === 'deleting') {
        // A collector may claim deletion after a stalled reader's lease expired.
        await h.stores.postgres.query(
          "UPDATE storage.read_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE space_id=$1",
          [artifact.space]
        );
        await h.stores.postgres.query(
          "UPDATE storage.retention_policies SET state='deleting' WHERE space_id=$1",
          [artifact.space]
        );
      } else h.identity.deadPods.add('web');
      release.resolve();
      const result = await downloaded;
      expect(result.complete).toBe(false);
      expect(result.received).toBeGreaterThan(0);
      expect(result.received).toBeLessThan(artifact.bytes.length);
      await expect
        .poll(
          async () =>
            (
              await h.stores.postgres.query(
                'SELECT count(*)::int AS n FROM storage.read_leases WHERE space_id=$1',
                [artifact.space]
              )
            ).rows[0].n
        )
        .toBe(0);
    },
    30_000
  );
});
