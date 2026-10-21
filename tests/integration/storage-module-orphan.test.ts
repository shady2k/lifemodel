import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createRetentionHarness,
  DAY,
  TERMINAL,
  sha256,
} from '../helpers/storage-retention-harness.js';
let h: Awaited<ReturnType<typeof createRetentionHarness>>;
beforeAll(async () => {
  h = await createRetentionHarness();
}, 30000);
beforeEach(async () => {
  await h.reset();
}, 20000);
afterEach(async () => {
  await h.cleanup();
}, 20000);
afterAll(async () => {
  await h?.close();
}, 20000);
describe('orphan accounting and expired attempt recovery', () => {
  it('accounts orphan debt above full admission and retries an orphan key recreated after confirmation', async () => {
    await h.stores.postgres.query("INSERT INTO storage.spaces(id) VALUES('capacity')");
    await h.stores.postgres.query(
      "INSERT INTO storage.space_quota(space_id,charged_bytes) VALUES('capacity',20000000000)"
    );
    const key = `private/${randomUUID()}`;
    const bytes = Buffer.from('orphan debt');
    h.backend.objects.set(key, { bytes, sha256: sha256(bytes), lastModified: TERMINAL });
    await h.tick();
    expect(
      (await h.stores.postgres.query('SELECT used_bytes::text FROM storage.instance_ledger'))
        .rows[0].used_bytes
    ).toBe(String(20000000000 + bytes.length));
    await h.clock(TERMINAL + 2 * DAY + 1000);
    await h.tick();
    expect(h.backend.objects.has(key)).toBe(false);
    expect(
      (await h.stores.postgres.query('SELECT used_bytes::text FROM storage.instance_ledger'))
        .rows[0].used_bytes
    ).toBe('20000000000');
    h.backend.objects.set(key, { bytes, sha256: sha256(bytes), lastModified: TERMINAL });
    await h.tick();
    expect(h.backend.objects.has(key)).toBe(false);
    expect(
      (await h.stores.postgres.query('SELECT used_bytes::text FROM storage.instance_ledger'))
        .rows[0].used_bytes
    ).toBe('20000000000');
  }, 30000);
  it('returns capacity_exhausted on the next real HTTP byte and admits it after confirmed release', async () => {
    const space = await h.prepare();
    await h.stores.postgres.query("INSERT INTO storage.spaces(id) VALUES('capacity')");
    await h.stores.postgres.query(
      "INSERT INTO storage.space_quota(space_id,charged_bytes) VALUES('capacity',20000000000)"
    );
    const bytes = Buffer.from('x');
    const headers = {
      'x-storage-name': Buffer.from('x.txt').toString('base64url'),
      'x-storage-length': '1',
      'x-storage-sha256': sha256(bytes),
    };
    const denied = await h.call(
      'task',
      'PUT',
      `/spaces/${space}/objects/one-byte`,
      bytes,
      'a',
      headers
    );
    expect(denied.status).toBe(507);
    expect(denied.json.error.code).toBe('capacity_exhausted');
    await h.stores.postgres.query(
      "UPDATE storage.space_quota SET charged_bytes=charged_bytes-1 WHERE space_id='capacity'"
    );
    expect(
      (await h.call('task', 'PUT', `/spaces/${space}/objects/one-byte`, bytes, 'a', headers)).status
    ).toBe(200);
  }, 30000);
  it('retires an expired old attempt before backend removal, releases quota after confirmation, and fences late publication', async () => {
    const space = await h.prepare();
    const object = randomUUID(),
      attempt = randomUUID(),
      key = `private/${randomUUID()}`;
    const bytes = Buffer.from('expired upload');
    await h.stores.postgres.query('SELECT storage.reserve_upload($1,$2,$3,$4,$5,$6,3600)', [
      space,
      'expired',
      object,
      'expired.txt',
      bytes.length,
      sha256(bytes),
    ]);
    await h.stores.postgres.query(
      "INSERT INTO storage.upload_attempts(id,space_id,upload_id,s3_key,created_at) VALUES($1,$2,'expired',$3,to_timestamp($4/1000.0))",
      [attempt, space, key, TERMINAL - 3 * DAY]
    );
    await h.stores.postgres.query(
      'UPDATE storage.upload_intents SET lease_expires_at=to_timestamp($2/1000.0) WHERE space_id=$1',
      [space, TERMINAL - DAY]
    );
    h.backend.objects.set(key, { bytes, sha256: sha256(bytes), lastModified: TERMINAL - 3 * DAY });
    await h.tick();
    expect(h.backend.objects.has(key)).toBe(false);
    expect(
      (
        await h.stores.postgres.query(
          'SELECT reserved_bytes::text FROM storage.space_quota WHERE space_id=$1',
          [space]
        )
      ).rows[0].reserved_bytes
    ).toBe('0');
    expect(
      (
        await h.stores.postgres.query('SELECT storage.complete_upload($1,$2,$3) AS result', [
          space,
          'expired',
          attempt,
        ])
      ).rows[0].result
    ).toBe('attempt_expired');
    expect(
      (
        await h.stores.postgres.query(
          'SELECT count(*)::int AS n FROM storage.objects WHERE id=$1',
          [object]
        )
      ).rows[0].n
    ).toBe(0);
  }, 30000);
  it('releases a reservation abandoned before attempt creation and rejects its stale begin', async () => {
    const space = await h.prepare();
    await h.stores.postgres.query('SELECT storage.reserve_upload($1,$2,$3,$4,$5,$6,3600)', [
      space,
      'no-attempt',
      randomUUID(),
      'missing.txt',
      1,
      sha256(Buffer.from('x')),
    ]);
    await h.stores.postgres.query(
      'UPDATE storage.upload_intents SET lease_expires_at=to_timestamp($2/1000.0) WHERE space_id=$1',
      [space, TERMINAL - DAY]
    );
    await h.tick();
    expect(
      (
        await h.stores.postgres.query(
          'SELECT reserved_bytes::text FROM storage.space_quota WHERE space_id=$1',
          [space]
        )
      ).rows[0].reserved_bytes
    ).toBe('0');
    expect(
      (
        await h.stores.postgres.query('SELECT storage.begin_attempt($1,$2,$3,$4,$5) AS accepted', [
          randomUUID(),
          space,
          'no-attempt',
          `private/${randomUUID()}`,
          randomUUID(),
        ])
      ).rows[0].accepted
    ).toBe(false);
  }, 30000);
  it('collects more than one bounded page from a sealed space without losing remaining output', async () => {
    const artifacts = await h.batch(101);
    await h.clock(TERMINAL + 90 * DAY);
    await h.tick();
    const first = (await h.pending()).plans[0];
    await h.warn(first.id);
    await h.clock(TERMINAL + 97 * DAY);
    await h.tick();
    expect(h.backend.objects.size).toBe(1);
    const second = (await h.pending()).plans;
    expect(second).toHaveLength(1);
    expect(second[0].id).not.toBe(first.id);
    await h.warn(second[0].id, 'second-page');
    await h.clock(TERMINAL + 104 * DAY);
    await h.tick();
    for (const artifact of artifacts) expect(h.backend.objects.has(artifact.key)).toBe(false);
  }, 45000);

  it('survives real dropped catalog TCP sockets and accepts the same warning after recovery', async () => {
    await h.artifact();
    await h.clock(TERMINAL + 90 * DAY);
    await h.tick();
    const plan = (await h.pending()).plans[0];
    h.sqlProxy.drop();
    await expect.poll(async () => (await h.warn(plan.id)).status).toBe(503);
    expect(h.child().process.exitCode).toBeNull();
    h.sqlProxy.restore();
    await expect.poll(async () => (await h.warn(plan.id)).status, { timeout: 10000 }).toBe(200);
    expect(h.child().process.exitCode).toBeNull();
  }, 30000);
  it('seal and retired-attempt cleanup may confirm the same key without double-releasing quota', async () => {
    const space = await h.prepare();
    const attempt = randomUUID(),
      key = `private/${randomUUID()}`,
      bytes = Buffer.from('retired');
    await h.stores.postgres.query('SELECT storage.reserve_upload($1,$2,$3,$4,$5,$6,3600)', [
      space,
      'expired-seal',
      randomUUID(),
      'old.txt',
      bytes.length,
      sha256(bytes),
    ]);
    await h.stores.postgres.query(
      "INSERT INTO storage.upload_attempts(id,space_id,upload_id,s3_key,created_at) VALUES($1,$2,'expired-seal',$3,to_timestamp($4/1000.0))",
      [attempt, space, key, TERMINAL - 3 * DAY]
    );
    await h.stores.postgres.query(
      'UPDATE storage.upload_intents SET lease_expires_at=to_timestamp($2/1000.0) WHERE space_id=$1',
      [space, TERMINAL - DAY]
    );
    h.backend.objects.set(key, { bytes, sha256: sha256(bytes), lastModified: TERMINAL - 3 * DAY });
    let release!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>((r) => {
      reached = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    h.releases.push(() => release());
    let calls = 0;
    h.backend.hooks.beforeDelete = async (record) => {
      if (record.key === key && ++calls === 1) {
        reached();
        await held;
      }
    };
    const ticking = h.tick();
    void ticking.catch(() => undefined);
    await waiting;
    const sealed = await h.call('control', 'POST', '/seal', {
      space,
      effectKey: 'seal-overlap',
      expectedRevision: '0',
      outcome: 'stopped',
    });
    // Seal's same-space transport barrier reports bounded cleanup pending;
    // it never acknowledges completion while the older delete is unsettled.
    expect(sealed.status).toBe(503);
    expect(sealed.json.error.code).toBe('cleanup_pending');
    release();
    await ticking;
    const replay = await h.call('control', 'POST', '/seal', {
      space,
      effectKey: 'seal-overlap',
      expectedRevision: '0',
      outcome: 'stopped',
    });
    expect(replay.status).toBe(200);
    expect(h.backend.objects.has(key)).toBe(false);
    expect(
      (await h.stores.postgres.query('SELECT used_bytes::text FROM storage.instance_ledger'))
        .rows[0].used_bytes
    ).toBe('0');
    expect(
      (
        await h.stores.postgres.query(
          'SELECT reserved_bytes::text,charged_bytes::text FROM storage.space_quota WHERE space_id=$1',
          [space]
        )
      ).rows[0]
    ).toEqual({ reserved_bytes: '0', charged_bytes: '0' });
  }, 30000);
});
