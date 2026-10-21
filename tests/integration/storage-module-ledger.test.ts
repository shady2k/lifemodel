import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createTestStores, workerDatabaseUrl, type TestStores } from '../helpers/test-stores.js';

const LIMIT = 20_000_000_000;
const HASH = 'a'.repeat(64);
let stores: TestStores;

async function used() {
  const result = await stores.postgres.query(
    'SELECT id,limit_bytes::text,used_bytes::text FROM storage.instance_ledger'
  );
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ id: true, limit_bytes: String(LIMIT) });
  return Number(result.rows[0].used_bytes);
}

async function reserve(space: string, upload: string, size: number) {
  const object = randomUUID();
  await stores.postgres.query('SELECT storage.reserve_upload($1,$2,$3,$4,$5,$6,60)', [
    space,
    upload,
    object,
    `${upload}.bin`,
    size,
    HASH,
  ]);
  return object;
}

async function publish(space: string, upload: string, size: number) {
  const object = await reserve(space, upload, size);
  const attempt = randomUUID();
  await stores.postgres.query(
    'INSERT INTO storage.upload_attempts(id,space_id,upload_id,s3_key) VALUES($1,$2,$3,$4)',
    [attempt, space, upload, `private/${attempt}`]
  );
  const result = await stores.postgres.query('SELECT storage.complete_upload($1,$2,$3) AS state', [
    space,
    upload,
    attempt,
  ]);
  expect(result.rows[0].state).toBe('completed');
  return object;
}

beforeAll(async () => {
  stores = await createTestStores();
  stores.postgres.on('error', () => undefined);
  stores.postgres.on('connect', (client) => client.on('error', () => undefined));
  await applyTestMigrations(stores.postgres);
});

beforeEach(async () => {
  await stores.postgres.query('TRUNCATE storage.spaces CASCADE');
  await stores.postgres.query('UPDATE storage.instance_ledger SET used_bytes=0');
  await stores.postgres.query("INSERT INTO storage.spaces(id) VALUES('a'),('b'),('c')");
});

afterAll(async () => {
  await stores.postgres.end();
  await stores.redis.quit();
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

describe('instance storage capacity ledger', () => {
  it('fixes the singleton decimal 20 GB bound and forbids invalid accounting', async () => {
    expect(await used()).toBe(0);
    await expect(
      stores.postgres.query('INSERT INTO storage.instance_ledger(id) VALUES(false)')
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      stores.postgres.query('INSERT INTO storage.instance_ledger DEFAULT VALUES')
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      stores.postgres.query('UPDATE storage.instance_ledger SET limit_bytes=20000000001')
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      stores.postgres.query('UPDATE storage.instance_ledger SET limit_bytes=19999999999')
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      stores.postgres.query('UPDATE storage.instance_ledger SET used_bytes=-1')
    ).rejects.toMatchObject({ code: '23514' });
    expect(await used()).toBe(0);
  });

  it('truthfully charges discovered orphan debt while refusing growth and allowing partial recovery', async () => {
    await reserve('a', 'full', LIMIT - 1);
    await reserve('b', 'partial', 1);
    expect(await used()).toBe(LIMIT);
    // A late remote PUT already exists. Its discovery cannot be rejected or
    // erased merely because no new byte may now be admitted.
    await stores.postgres.query('UPDATE storage.instance_ledger SET used_bytes=used_bytes+3');
    expect(await used()).toBe(LIMIT + 3);
    await expect(reserve('c', 'blocked', 1)).rejects.toMatchObject({ code: '53000' });
    // Releasing one byte must succeed even though the instance stays overfull.
    await stores.postgres.query("SELECT storage.release_upload('b','partial')");
    expect(await used()).toBe(LIMIT + 2);
    await expect(reserve('c', 'blocked', 1)).rejects.toMatchObject({ code: '53000' });
    // Only confirmed orphan deletion removes the separately tracked debt.
    await stores.postgres.query('UPDATE storage.instance_ledger SET used_bytes=used_bytes-3');
    expect(await used()).toBe(LIMIT - 1);
    await reserve('c', 'blocked', 1);
    expect(await used()).toBe(LIMIT);
    await expect(reserve('b', 'next-byte', 1)).rejects.toMatchObject({ code: '53000' });
  });

  it('counts 100 published metadata rows plus reservations at limit minus one, exactly, and plus one', async () => {
    for (let n = 0; n < 100; n++) await publish('a', `object-${n}`, 199_999_999);
    expect(
      (await stores.postgres.query('SELECT count(*)::int AS n FROM storage.objects')).rows[0].n
    ).toBe(100);
    expect(await used()).toBe(LIMIT - 100);
    await reserve('b', 'minus-one', 99);
    expect(await used()).toBe(LIMIT - 1);
    await reserve('c', 'exact', 1);
    expect(await used()).toBe(LIMIT);
    await expect(reserve('b', 'one-too-many', 1)).rejects.toMatchObject({ code: '53000' });
    expect(await used()).toBe(LIMIT);
    expect(
      (
        await stores.postgres.query(
          "SELECT count(*)::int AS n FROM storage.upload_intents WHERE upload_id='one-too-many'"
        )
      ).rows[0].n
    ).toBe(0);
    await stores.postgres.query("SELECT storage.release_upload('b','minus-one')");
    expect(await used()).toBe(LIMIT - 99);
    await reserve('b', 'one-too-many', 99);
    expect(await used()).toBe(LIMIT);
  }, 30_000);

  it('serializes concurrent reservations across spaces and atomically rejects the losing byte', async () => {
    await reserve('a', 'base', LIMIT - 1);
    const outcomes = await Promise.allSettled([
      reserve('b', 'racer-b', 1),
      reserve('c', 'racer-c', 1),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: { code: '53000' } });
    expect(await used()).toBe(LIMIT);
    expect(
      (
        await stores.postgres.query(
          "SELECT count(*)::int AS n FROM storage.upload_intents WHERE upload_id LIKE 'racer-%'"
        )
      ).rows[0].n
    ).toBe(1);
    expect(
      (
        await stores.postgres.query(
          'SELECT sum(reserved_bytes + charged_bytes)::text AS n FROM storage.space_quota'
        )
      ).rows[0].n
    ).toBe(String(LIMIT));
  });

  it('rolls ledger deltas back with their transaction and counts direct insert, update, delete and cascade', async () => {
    const client = await stores.postgres.connect();
    client.on('error', () => undefined);
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO storage.space_quota(space_id,charged_bytes) VALUES('a',40)");
      expect(
        (await client.query('SELECT used_bytes::text AS n FROM storage.instance_ledger')).rows[0].n
      ).toBe('40');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await used()).toBe(0);
    await stores.postgres.query(
      "INSERT INTO storage.space_quota(space_id,charged_bytes,reserved_bytes) VALUES('a',40,2),('b',8,0)"
    );
    expect(await used()).toBe(50);
    await stores.postgres.query(
      "UPDATE storage.space_quota SET charged_bytes=45,reserved_bytes=0 WHERE space_id='a'"
    );
    expect(await used()).toBe(53);
    await stores.postgres.query("DELETE FROM storage.space_quota WHERE space_id='b'");
    expect(await used()).toBe(45);
    await stores.postgres.query("DELETE FROM storage.spaces WHERE id='a'");
    expect(await used()).toBe(0);
  });

  it('does not double-count publication or retries and releases only pending reservations', async () => {
    await publish('a', 'published', 30);
    await reserve('a', 'published', 30);
    await stores.postgres.query("SELECT storage.release_upload('a','published')");
    expect(await used()).toBe(30);
    await reserve('b', 'pending', 12);
    expect(await used()).toBe(42);
    await stores.postgres.query("SELECT storage.release_upload('b','pending')");
    await stores.postgres.query("SELECT storage.release_upload('b','pending')");
    expect(await used()).toBe(30);
    await reserve('b', 'pending', 12);
    expect(await used()).toBe(42);
  });

  it('truncating quota through the space cascade releases quota but preserves separately tracked orphan bytes', async () => {
    await publish('a', 'published', 30);
    await stores.postgres.query('UPDATE storage.instance_ledger SET used_bytes=used_bytes+7');
    expect(await used()).toBe(37);
    await stores.postgres.query('TRUNCATE storage.spaces CASCADE');
    expect(await used()).toBe(7);
  });
});
