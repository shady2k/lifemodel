import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createRetentionHarness,
  DAY,
  TERMINAL,
  gate,
  sha256,
} from '../helpers/storage-retention-harness.js';

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

async function announced() {
  const artifact = await h.artifact();
  await h.clock(TERMINAL + 90 * DAY);
  await h.tick();
  const plans = (await h.pending()).plans;
  expect(plans).toHaveLength(1);
  expect((await h.warn(plans[0].id)).status).toBe(200);
  await h.clock(TERMINAL + 97 * DAY);
  return { artifact, plan: plans[0] };
}

describe('retention GC at real process and backend boundaries', () => {
  it.each(['before', 'after'] as const)(
    'expired-attempt cleanup survives SIGKILL %s backend deletion and does not touch a newer live key',
    async (boundary) => {
      const space = await h.prepare();
      const bytes = Buffer.from('abandoned attempt');
      const digest = sha256(bytes);
      const expiredId = randomUUID();
      const expiredAttempt = randomUUID();
      const expiredKey = `private/${expiredAttempt}`;
      const liveId = randomUUID();
      const liveAttempt = randomUUID();
      const liveKey = `private/${liveAttempt}`;
      for (const [uploadId, objectId, attemptId, key, createdAt, expiresAt] of [
        [
          'abandoned',
          expiredId,
          expiredAttempt,
          expiredKey,
          TERMINAL - 3 * DAY,
          TERMINAL - 3 * DAY,
        ],
        ['live', liveId, liveAttempt, liveKey, TERMINAL, TERMINAL + DAY],
      ] as const) {
        await h.stores.postgres.query('SELECT storage.reserve_upload($1,$2,$3,$4,$5,$6,3600)', [
          space,
          uploadId,
          objectId,
          `a/${uploadId}.txt`,
          bytes.length,
          digest,
        ]);
        await h.stores.postgres.query(
          'INSERT INTO storage.upload_attempts(id,space_id,upload_id,s3_key,created_at) VALUES($1,$2,$3,$4,to_timestamp($5/1000.0))',
          [attemptId, space, uploadId, key, createdAt]
        );
        await h.stores.postgres.query(
          'UPDATE storage.upload_intents SET lease_expires_at=to_timestamp($3/1000.0) WHERE space_id=$1 AND upload_id=$2',
          [space, uploadId, expiresAt]
        );
        h.backend.objects.set(key, { bytes, sha256: digest, lastModified: createdAt });
      }
      const reached = gate();
      const release = gate();
      h.releases.push(release.resolve);
      const hook = boundary === 'before' ? 'beforeDelete' : 'afterDelete';
      h.backend.hooks[hook] = async (record) => {
        if (record.key !== expiredKey) return;
        reached.resolve();
        await release.promise;
        return 'lose-response';
      };
      const ticking = h.tick().catch(() => undefined);
      await reached.promise;
      // Outstanding physical bytes remain counted until the backend confirms removal.
      expect(
        Number(
          (await h.stores.postgres.query('SELECT used_bytes::text FROM storage.instance_ledger'))
            .rows[0].used_bytes
        )
      ).toBe(2 * bytes.length);
      expect(h.backend.objects.has(expiredKey)).toBe(boundary === 'before');
      expect(h.backend.objects.has(liveKey)).toBe(true);
      await h.kill();
      await ticking;
      release.resolve();
      delete h.backend.hooks[hook];
      await h.start();
      await h.tick();
      expect(h.backend.objects.has(expiredKey)).toBe(false);
      expect(h.backend.objects.has(liveKey)).toBe(true);
      expect(
        (await h.stores.postgres.query('SELECT used_bytes::text FROM storage.instance_ledger'))
          .rows[0].used_bytes
      ).toBe(String(bytes.length));
      expect(
        (
          await h.stores.postgres.query(
            'SELECT reserved FROM storage.upload_intents WHERE space_id=$1 AND upload_id=$2',
            [space, 'abandoned']
          )
        ).rows[0].reserved
      ).toBe(false);
      expect(
        (
          await h.stores.postgres.query(
            'SELECT reserved FROM storage.upload_intents WHERE space_id=$1 AND upload_id=$2',
            [space, 'live']
          )
        ).rows[0].reserved
      ).toBe(true);
      const retired = await h.stores.postgres.query(
        'SELECT storage.complete_upload($1,$2,$3) AS result',
        [space, 'abandoned', expiredAttempt]
      );
      expect(['completed', 'already_completed']).not.toContain(retired.rows[0].result);
      expect(
        (
          await h.stores.postgres.query(
            'SELECT count(*)::int AS n FROM storage.object_versions WHERE object_id=$1',
            [expiredId]
          )
        ).rows[0].n
      ).toBe(0);
      expect(
        h.backend.requests.filter((record) => record.method === 'DELETE' && record.key === liveKey)
      ).toHaveLength(0);
    },
    30_000
  );

  it('charges and sweeps a private key recreated after its orphan deletion receipt', async () => {
    const key = `private/${randomUUID()}`;
    const bytes = Buffer.from('orphan bytes');
    h.backend.objects.set(key, { bytes, sha256: sha256(bytes), lastModified: TERMINAL - 3 * DAY });
    await h.tick();
    expect(h.backend.objects.has(key)).toBe(false);
    expect(
      (
        await h.stores.postgres.query('SELECT deleted FROM storage.orphan_gc WHERE s3_key=$1', [
          key,
        ])
      ).rows[0].deleted
    ).toBe(true);
    expect(
      (await h.stores.postgres.query('SELECT used_bytes::text FROM storage.instance_ledger'))
        .rows[0].used_bytes
    ).toBe('0');
    // A backend PUT may complete after an earlier cleanup DELETE of this key.
    h.backend.objects.set(key, { bytes, sha256: sha256(bytes), lastModified: TERMINAL });
    await h.tick();
    expect(h.backend.objects.has(key)).toBe(true);
    expect(
      (
        await h.stores.postgres.query('SELECT deleted FROM storage.orphan_gc WHERE s3_key=$1', [
          key,
        ])
      ).rows[0].deleted
    ).toBe(false);
    expect(
      (await h.stores.postgres.query('SELECT used_bytes::text FROM storage.instance_ledger'))
        .rows[0].used_bytes
    ).toBe(String(bytes.length));
    await h.clock(TERMINAL + 2 * DAY - 1000);
    await h.tick();
    expect(h.backend.objects.has(key)).toBe(true);
    await h.clock(TERMINAL + 2 * DAY + 1000);
    await h.tick();
    expect(h.backend.objects.has(key)).toBe(false);
    expect(
      (await h.stores.postgres.query('SELECT used_bytes::text FROM storage.instance_ledger'))
        .rows[0].used_bytes
    ).toBe('0');
    expect(
      h.backend.requests.filter((record) => record.method === 'DELETE' && record.key === key)
    ).toHaveLength(2);
  }, 30_000);

  it('records historical orphan debt beyond a full ledger, refuses HTTP reservations, and recovers after confirmation', async () => {
    const space = await h.prepare('a');
    const unrelated = await h.prepare('b');
    await h.stores.postgres.query(
      'INSERT INTO storage.space_quota(space_id,charged_bytes) VALUES($1,20000000000) ON CONFLICT(space_id) DO UPDATE SET charged_bytes=20000000000',
      [unrelated]
    );
    const putOne = () =>
      h.call('task', 'PUT', `/spaces/${space}/objects/one-byte`, Buffer.from('x'), 'a', {
        'x-storage-name': Buffer.from('a/one-byte.txt').toString('base64url'),
        'x-storage-length': '1',
        'x-storage-sha256': sha256(Buffer.from('x')),
      });
    const full = await putOne();
    expect(full.status).toBe(507);
    expect(full.json.error.code).toBe('capacity_exhausted');
    expect(h.backend.requests.filter((record) => record.method === 'PUT')).toHaveLength(0);
    const key = `private/${randomUUID()}`;
    const bytes = Buffer.from('unaccounted old bytes');
    h.backend.objects.set(key, { bytes, sha256: sha256(bytes), lastModified: TERMINAL - 3 * DAY });
    const reached = gate();
    const release = gate();
    h.releases.push(release.resolve);
    h.backend.hooks.beforeDelete = async (record) => {
      if (record.key === key) {
        reached.resolve();
        await release.promise;
      }
    };
    const ticking = h.tick();
    void ticking.catch(() => undefined);
    await reached.promise;
    expect(
      (await h.stores.postgres.query('SELECT used_bytes::text FROM storage.instance_ledger'))
        .rows[0].used_bytes
    ).toBe(String(20_000_000_000 + bytes.length));
    expect(
      (
        await h.stores.postgres.query('SELECT deleted FROM storage.orphan_gc WHERE s3_key=$1', [
          key,
        ])
      ).rows[0].deleted
    ).toBe(false);
    const debt = await putOne();
    expect(debt.status).toBe(507);
    expect(debt.json.error.code).toBe('capacity_exhausted');
    release.resolve();
    await ticking;
    delete h.backend.hooks.beforeDelete;
    expect(h.backend.objects.has(key)).toBe(false);
    expect(
      (await h.stores.postgres.query('SELECT used_bytes::text FROM storage.instance_ledger'))
        .rows[0].used_bytes
    ).toBe('20000000000');
    await h.stores.postgres.query(
      'UPDATE storage.space_quota SET charged_bytes=charged_bytes-1 WHERE space_id=$1',
      [unrelated]
    );
    const recovered = await putOne();
    expect(recovered.status, JSON.stringify(recovered.json)).toBe(200);
    expect(
      (await h.stores.postgres.query('SELECT used_bytes::text FROM storage.instance_ledger'))
        .rows[0].used_bytes
    ).toBe('20000000000');
  }, 30_000);

  it('releases an expired abandoned attempt and sweeps its old private bytes without sealing an active space', async () => {
    const space = await h.prepare();
    const objectId = randomUUID();
    const attempt = randomUUID();
    const key = `private/${attempt}`;
    const bytes = Buffer.from('abandoned upload');
    const digest = sha256(bytes);
    await h.stores.postgres.query('SELECT storage.reserve_upload($1,$2,$3,$4,$5,$6,3600)', [
      space,
      'expired-upload',
      objectId,
      'a/expired.txt',
      bytes.length,
      digest,
    ]);
    await h.stores.postgres.query(
      'INSERT INTO storage.upload_attempts(id,space_id,upload_id,s3_key,created_at) VALUES($1,$2,$3,$4,to_timestamp($5/1000.0))',
      [attempt, space, 'expired-upload', key, TERMINAL - 3 * DAY]
    );
    await h.stores.postgres.query(
      'UPDATE storage.upload_intents SET lease_expires_at=to_timestamp($2/1000.0) WHERE space_id=$1',
      [space, TERMINAL - 3 * DAY]
    );
    h.backend.objects.set(key, { bytes, sha256: digest, lastModified: TERMINAL - 3 * DAY });
    expect(
      (await h.stores.postgres.query('SELECT used_bytes::text FROM storage.instance_ledger'))
        .rows[0].used_bytes
    ).toBe(String(bytes.length));
    await h.tick();
    expect(h.backend.objects.has(key)).toBe(false);
    expect(
      (
        await h.stores.postgres.query(
          'SELECT reserved FROM storage.upload_intents WHERE space_id=$1 AND upload_id=$2',
          [space, 'expired-upload']
        )
      ).rows[0].reserved
    ).toBe(false);
    expect(
      (await h.stores.postgres.query('SELECT used_bytes::text FROM storage.instance_ledger'))
        .rows[0].used_bytes
    ).toBe('0');
    expect(
      (
        await h.stores.postgres.query(
          'SELECT count(*)::int AS n FROM storage.object_versions WHERE object_id=$1',
          [objectId]
        )
      ).rows[0].n
    ).toBe(0);
    expect((await h.pending()).plans).toEqual([]);
    const retired = await h.stores.postgres.query(
      'SELECT storage.complete_upload($1,$2,$3) AS result',
      [space, 'expired-upload', attempt]
    );
    expect(['completed', 'already_completed']).not.toContain(retired.rows[0].result);
    expect(
      (
        await h.stores.postgres.query(
          'SELECT count(*)::int AS n FROM storage.object_versions WHERE object_id=$1',
          [objectId]
        )
      ).rows[0].n
    ).toBe(0);
    expect(
      (await h.stores.postgres.query('SELECT used_bytes::text FROM storage.instance_ledger'))
        .rows[0].used_bytes
    ).toBe('0');
    // The same active space still accepts a valid new reservation after cleanup.
    const valid = await h.upload(space, 'a', 'valid-after-expiry');
    expect(h.backend.objects.has(valid.key)).toBe(true);
  }, 30_000);

  it('two module contenders create one batch and cannot delete a concurrently claimed object', async () => {
    const artifact = await h.artifact();
    const first = h.child();
    const second = await h.start();
    await h.clock(TERMINAL + 90 * DAY);
    await Promise.all([h.tick(first), h.tick(second)]);
    const plans = (await h.pending()).plans;
    expect(plans).toHaveLength(1);
    expect(
      (await h.stores.postgres.query('SELECT count(*)::int AS n FROM storage.deletion_candidates'))
        .rows[0].n
    ).toBe(1);
    expect((await h.warn(plans[0].id)).status).toBe(200);
    await h.clock(TERMINAL + 97 * DAY);
    const reached = gate();
    const release = gate();
    h.releases.push(release.resolve);
    h.backend.hooks.beforeDelete = async (record) => {
      if (record.key === artifact.key) {
        reached.resolve();
        await release.promise;
      }
    };
    const deleting = h.tick(first);
    void deleting.catch(() => undefined);
    await reached.promise;
    expect(
      (
        await h.stores.postgres.query(
          'SELECT state FROM storage.deletion_candidates WHERE object_id=$1',
          [artifact.id]
        )
      ).rows[0].state
    ).toBe('deleting');
    await h.tick(second);
    expect(
      h.backend.requests.filter((r) => r.method === 'DELETE' && r.key === artifact.key)
    ).toHaveLength(1);
    const pin = await h.policy(artifact.space, 'pin');
    expect(pin.status).toBe(409);
    expect(pin.json.error.code).toBe('already_deleting');
    release.resolve();
    await deleting;
    expect(h.backend.objects.has(artifact.key)).toBe(false);
    expect(
      (
        await h.stores.postgres.query(
          'SELECT state FROM storage.retention_policies WHERE space_id=$1',
          [artifact.space]
        )
      ).rows[0].state
    ).toBe('deleted');
    expect((await h.pending()).plans).toEqual([]);
  }, 30_000);

  it('rechecks a winning pin under the delete row lock rather than trusting its earlier candidate snapshot', async () => {
    const { artifact } = await announced();
    const client = await h.stores.postgres.connect();
    client.on('error', () => undefined);
    let ticking: Promise<unknown> | undefined;
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT space_id FROM storage.retention_policies WHERE space_id=$1 FOR UPDATE',
        [artifact.space]
      );
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      ticking = h.tick();
      void ticking.catch(() => undefined);
      await expect
        .poll(
          async () =>
            (
              await h.stores.postgres.query(
                'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',
                [pid]
              )
            ).rows[0].n
        )
        .toBeGreaterThan(0);
      // Publish only the flag, retaining the candidate and its matching revision.
      // This isolates the deletion lock's protection check from policy-route cleanup.
      await client.query('UPDATE storage.retention_policies SET pinned=true WHERE space_id=$1', [
        artifact.space,
      ]);
      await client.query('COMMIT');
      await ticking;
      expect(h.backend.objects.has(artifact.key)).toBe(true);
      expect(
        h.backend.requests.filter((r) => r.method === 'DELETE' && r.key === artifact.key)
      ).toHaveLength(0);
      expect(
        (
          await h.stores.postgres.query(
            'SELECT state FROM storage.deletion_candidates WHERE object_id=$1',
            [artifact.id]
          )
        ).rows[0].state
      ).toBe('removed');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      await ticking?.catch(() => undefined);
    }
  }, 30_000);

  it.each(['policy', 'object'] as const)(
    'removes a stale %s revision instead of deleting under an obsolete notice',
    async (revision) => {
      const { artifact, plan } = await announced();
      if (revision === 'policy')
        await h.stores.postgres.query(
          'UPDATE storage.retention_policies SET revision=revision+1 WHERE space_id=$1',
          [artifact.space]
        );
      else
        await h.stores.postgres.query(
          'UPDATE storage.deletion_candidates SET object_revision=object_revision+1 WHERE object_id=$1',
          [artifact.id]
        );
      await h.tick();
      expect(h.backend.objects.has(artifact.key)).toBe(true);
      expect(
        h.backend.requests.filter(
          (record) => record.method === 'DELETE' && record.key === artifact.key
        )
      ).toHaveLength(0);
      expect(
        (
          await h.stores.postgres.query(
            'SELECT state FROM storage.deletion_candidates WHERE plan_id=$1 AND object_id=$2',
            [plan.id, artifact.id]
          )
        ).rows[0].state
      ).toBe('removed');
      expect((await h.pending()).plans).toEqual([]);
      // A later rescan must seek a new warning; it cannot reuse the elapsed notice.
      await h.tick();
      const fresh = (await h.pending()).plans;
      expect(fresh).toHaveLength(1);
      expect(fresh[0].id).not.toBe(plan.id);
      expect(h.backend.objects.has(artifact.key)).toBe(true);
    },
    30_000
  );

  it.each(['before', 'after'] as const)(
    'SIGKILL %s backend DELETE replays durable intent and accounts only confirmed deletion',
    async (boundary) => {
      const { artifact, plan } = await announced();
      const reached = gate();
      const release = gate();
      h.releases.push(release.resolve);
      const hook = boundary === 'before' ? 'beforeDelete' : 'afterDelete';
      h.backend.hooks[hook] = async (record) => {
        if (record.key !== artifact.key) return;
        reached.resolve();
        await release.promise;
        return 'lose-response';
      };
      const ticking = h.tick().catch(() => undefined);
      await reached.promise;
      const candidate = (
        await h.stores.postgres.query(
          'SELECT state FROM storage.deletion_candidates WHERE object_id=$1',
          [artifact.id]
        )
      ).rows[0];
      expect(candidate.state).toBe('deleting');
      expect(
        (
          await h.stores.postgres.query(
            'SELECT charged_bytes::text FROM storage.space_quota WHERE space_id=$1',
            [artifact.space]
          )
        ).rows[0].charged_bytes
      ).toBe(String(artifact.bytes.length));
      expect(h.backend.objects.has(artifact.key)).toBe(boundary === 'before');
      await h.kill();
      await ticking;
      release.resolve();
      delete h.backend.hooks[hook];
      await h.start();
      await h.tick();
      expect(h.backend.objects.has(artifact.key)).toBe(false);
      expect(
        (
          await h.stores.postgres.query(
            'SELECT state FROM storage.deletion_candidates WHERE object_id=$1',
            [artifact.id]
          )
        ).rows[0].state
      ).toBe('deleted');
      expect(
        (
          await h.stores.postgres.query(
            'SELECT charged_bytes::text FROM storage.space_quota WHERE space_id=$1',
            [artifact.space]
          )
        ).rows[0].charged_bytes
      ).toBe('0');
      expect(
        (await h.stores.postgres.query('SELECT count(*)::int AS n FROM storage.deletion_plans'))
          .rows[0].n
      ).toBe(1);
      expect((await h.pending()).plans).toEqual([]);
      expect((await h.warn(plan.id, 'owner-message')).status).toBe(200);
      expect((await h.warn(plan.id, 'second-message')).status).toBe(409);
      expect(
        (await h.call('read', 'GET', `/spaces/${artifact.space}/objects/${artifact.id}`)).status
      ).toBe(404);
    },
    30_000
  );

  it.each(['before', 'after'] as const)(
    'retries a lost %s DELETE response in the same live process without releasing bytes early',
    async (boundary) => {
      const { artifact } = await announced();
      const hook = boundary === 'before' ? 'beforeDelete' : 'afterDelete';
      let lost = false;
      h.backend.hooks[hook] = (record) => {
        if (record.key !== artifact.key || lost) return;
        lost = true;
        return 'lose-response';
      };
      await h.tick().catch(() => undefined);
      expect(lost).toBe(true);
      // One failed bounded tick may leave a durable deleting intent for the next tick.
      await h.tick();
      expect(h.child().process.exitCode).toBeNull();
      expect(h.backend.objects.has(artifact.key)).toBe(false);
      expect(
        (
          await h.stores.postgres.query(
            'SELECT charged_bytes::text FROM storage.space_quota WHERE space_id=$1',
            [artifact.space]
          )
        ).rows[0].charged_bytes
      ).toBe('0');
      expect(
        (
          await h.stores.postgres.query(
            'SELECT state FROM storage.deletion_candidates WHERE object_id=$1',
            [artifact.id]
          )
        ).rows[0].state
      ).toBe('deleted');
    },
    30_000
  );

  it('does not remove the backend object beneath an active core reader', async () => {
    const artifact = await h.artifact('a', Buffer.alloc(4 * 1024 * 1024 + 8, 97));
    await h.clock(TERMINAL + 90 * DAY);
    await h.tick();
    const plan = (await h.pending()).plans[0];
    await h.warn(plan.id);
    await h.clock(TERMINAL + 97 * DAY);
    const reached = gate();
    const release = gate();
    h.releases.push(release.resolve);
    let gets = 0;
    h.backend.hooks.beforeGet = async (record) => {
      if (record.key === artifact.key && ++gets === 2) {
        reached.resolve();
        await release.promise;
      }
    };
    const reading = h.call('read', 'GET', `/spaces/${artifact.space}/objects/${artifact.id}`);
    void reading.catch(() => undefined);
    await reached.promise;
    await h.tick();
    // A completed bounded tick must leave the bytes while the SQL read lease is live.
    expect(h.backend.objects.has(artifact.key)).toBe(true);
    expect(
      h.backend.requests.filter(
        (record) => record.method === 'DELETE' && record.key === artifact.key
      )
    ).toHaveLength(0);
    release.resolve();
    const read = await reading;
    expect(read.status).toBe(200);
    expect(read.body).toEqual(artifact.bytes);
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
    await h.tick();
    expect(h.backend.objects.has(artifact.key)).toBe(false);
    expect(
      (await h.call('read', 'GET', `/spaces/${artifact.space}/objects/${artifact.id}`)).status
    ).toBe(404);
  }, 30_000);

  it('sweeps a late private PUT after seal cleanup but never an old-looking live attempt key', async () => {
    const space = await h.prepare('a');
    const retained = await h.upload(space);
    const reached = gate();
    const release = gate();
    const committed = gate();
    h.releases.push(release.resolve);
    let orphanKey = '';
    h.backend.hooks.beforeCommit = async (record) => {
      orphanKey = record.key;
      reached.resolve();
      await release.promise;
    };
    h.backend.hooks.afterWrite = (record) => {
      if (record.key === orphanKey) committed.resolve();
    };
    const pending = h
      .call(
        'task',
        'PUT',
        `/spaces/${space}/objects/late-put`,
        Buffer.from('late private bytes'),
        'a',
        {
          'x-storage-name': Buffer.from('a/late.txt').toString('base64url'),
          'x-storage-length': String(Buffer.byteLength('late private bytes')),
          'x-storage-sha256': sha256(Buffer.from('late private bytes')),
        }
      )
      .catch(() => undefined);
    await reached.promise;
    const incomplete = (
      await h.stores.postgres.query(
        "SELECT object_id::text FROM storage.upload_intents WHERE space_id=$1 AND upload_id='late-put'",
        [space]
      )
    ).rows[0];
    await h.kill();
    await pending;
    await h.start();
    await h.seal(space);
    release.resolve();
    await committed.promise;
    delete h.backend.hooks.beforeCommit;
    delete h.backend.hooks.afterWrite;
    expect(h.backend.objects.has(orphanKey)).toBe(true);
    h.backend.objects.get(orphanKey)!.lastModified = TERMINAL;
    expect(
      (await h.call('read', 'GET', `/spaces/${space}/objects/${incomplete.object_id}`)).status
    ).toBe(404);

    const liveSpace = await h.prepare('b');
    const liveReached = gate();
    const liveRelease = gate();
    h.releases.push(liveRelease.resolve);
    let liveKey = '';
    h.backend.hooks.afterWrite = async (record) => {
      liveKey = record.key;
      h.backend.objects.get(liveKey)!.lastModified = TERMINAL - 30 * DAY;
      liveReached.resolve();
      await liveRelease.promise;
    };
    const live = h.upload(liveSpace, 'b');
    void live.catch(() => undefined);
    await liveReached.promise;
    await h.stores.postgres.query(
      'UPDATE storage.upload_intents SET lease_expires_at=to_timestamp($2/1000.0) WHERE space_id=$1',
      [liveSpace, TERMINAL + 365 * DAY]
    );
    // A failed sibling can release a reservation while this valid attempt is in flight.
    // Only its live attempt lease (not the ledger hold) may protect this key.
    await h.stores.postgres.query('SELECT storage.release_upload($1,$2)', [liveSpace, 'output']);
    await h.tick();
    const orphan = (
      await h.stores.postgres.query(
        'SELECT s3_key,size::text,deleted FROM storage.orphan_gc WHERE s3_key=$1',
        [orphanKey]
      )
    ).rows[0];
    expect(orphan).toMatchObject({
      s3_key: orphanKey,
      size: String(Buffer.byteLength('late private bytes')),
      deleted: false,
    });
    await h.clock(TERMINAL + 2 * DAY - 1000);
    await h.tick();
    expect(h.backend.objects.has(orphanKey)).toBe(true);
    expect(h.backend.objects.has(liveKey)).toBe(true);
    await h.clock(TERMINAL + 2 * DAY + 1000);
    await h.tick();
    expect(h.backend.objects.has(orphanKey)).toBe(false);
    expect(
      (
        await h.stores.postgres.query('SELECT deleted FROM storage.orphan_gc WHERE s3_key=$1', [
          orphanKey,
        ])
      ).rows[0].deleted
    ).toBe(true);
    expect(h.backend.objects.has(liveKey)).toBe(true);
    expect(
      h.backend.requests.filter((record) => record.method === 'DELETE' && record.key === liveKey)
    ).toHaveLength(0);
    expect(h.backend.objects.has(retained.key)).toBe(true);
    liveRelease.resolve();
    delete h.backend.hooks.afterWrite;
    const published = await live;
    expect(published.key).toBe(liveKey);
    expect(
      (await h.call('read', 'GET', `/spaces/${liveSpace}/objects/${published.id}`)).body
    ).toEqual(published.bytes);
  }, 30_000);
});
