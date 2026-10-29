import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';

describe('gateway capture migration and least privilege', () => {
  let stores: TestStores;
  beforeAll(async () => {
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
    await applyTestMigrations(stores.postgres);
  });
  beforeEach(async () => {
    await stores.postgres.query('TRUNCATE observability.model_exchanges');
  });
  afterAll(async () => {
    await Promise.all([stores.postgres.end(), stores.redis.quit()]);
  });
  const append = `SELECT observability.append_model_exchange($1,1,'primary',NULL,NULL,$2,$3)`;
  async function asRole(role: string, sql: string, values: unknown[] = []) {
    const client = await stores.postgres.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
      const result = await client.query(sql, values);
      await client.query('COMMIT');
      return result;
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
  it('allows append/prune only to writer and view SELECT only to reader', async () => {
    const expiry = new Date(Date.now() + 60000);
    await asRole('lifemodel_capture_writer', append, [
      'call-one',
      { response: { body: 'redacted' } },
      expiry,
    ]);
    await asRole('lifemodel_capture_writer', append, [
      'call-one',
      { response: { body: 'duplicate' } },
      expiry,
    ]);
    const rows = await asRole(
      'lifemodel_capture_reader',
      'SELECT * FROM observability.recent_model_exchanges'
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({
        call_id: 'call-one',
        exchange: { response: { body: 'redacted' } },
      }),
    ]);
    expect(Number(rows.rows[0].size_bytes)).toBeGreaterThan(0);
    for (const role of ['lifemodel_capture_writer', 'lifemodel_capture_reader']) {
      await expect(
        asRole(role, 'SELECT * FROM observability.model_exchanges')
      ).rejects.toMatchObject({ code: '42501' });
      await expect(asRole(role, 'DELETE FROM observability.model_exchanges')).rejects.toMatchObject(
        { code: '42501' }
      );
      await expect(
        asRole(
          role,
          `INSERT INTO observability.model_exchanges(call_id,attempt,slot,exchange,size_bytes) VALUES('bad',1,'primary','{}',1)`
        )
      ).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      asRole('lifemodel_capture_writer', 'SELECT * FROM observability.recent_model_exchanges')
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asRole('lifemodel_capture_reader', append, ['bad', {}, expiry])
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asRole('lifemodel_capture_reader', 'SELECT observability.prune_model_exchanges()')
    ).rejects.toMatchObject({ code: '42501' });
    await asRole('lifemodel_capture_writer', 'SELECT observability.prune_model_exchanges()');
    expect(
      (
        await stores.postgres.query(
          `SELECT proconfig FROM pg_proc WHERE oid='observability.append_model_exchange(text,integer,text,text,text,jsonb,timestamptz)'::regprocedure`
        )
      ).rows[0].proconfig
    ).toEqual(['search_path=pg_catalog']);
  });
  it('rejects invalid and oversized rows and ignores expired queue entries', async () => {
    await asRole('lifemodel_capture_writer', append, ['expired', {}, new Date(Date.now() - 1)]);
    expect(
      (await stores.postgres.query('SELECT count(*)::int n FROM observability.model_exchanges'))
        .rows[0].n
    ).toBe(0);
    await expect(
      asRole('lifemodel_capture_writer', append, [
        'oversized',
        { body: 'x'.repeat(4194304) },
        new Date(Date.now() + 60000),
      ])
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      asRole('lifemodel_capture_writer', append, [
        'bad-shape',
        JSON.stringify([]),
        new Date(Date.now() + 60000),
      ])
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('hides expired text while off and prunes age and oldest size overflow', async () => {
    await stores.postgres
      .query(`INSERT INTO observability.model_exchanges(call_id,attempt,slot,created_at,exchange,size_bytes)
      SELECT 'fixture-'||n,1,'primary',clock_timestamp()-interval '1 minute'*n,'{}',4194304 FROM generate_series(1,26) n`);
    await stores.postgres
      .query(`INSERT INTO observability.model_exchanges(call_id,attempt,slot,created_at,exchange,size_bytes)
      VALUES('expired',1,'primary',now()-interval '25 hours','{}',1)`);
    expect(
      (
        await asRole(
          'lifemodel_capture_reader',
          `SELECT call_id FROM observability.recent_model_exchanges WHERE call_id='expired'`
        )
      ).rows
    ).toEqual([]);
    await asRole('lifemodel_capture_writer', 'SELECT observability.prune_model_exchanges()');
    const result = await stores.postgres.query(
      'SELECT count(*)::int n,sum(size_bytes)::text bytes FROM observability.model_exchanges'
    );
    expect(result.rows[0]).toEqual({ n: 25, bytes: '104857600' });
    expect(
      (
        await stores.postgres.query(
          `SELECT call_id FROM observability.model_exchanges WHERE call_id IN ('expired','fixture-26')`
        )
      ).rows
    ).toEqual([]);
  });
  it('serializes concurrent appends without dropping attempts', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        asRole('lifemodel_capture_writer', append, [
          `concurrent-${n}`,
          {},
          new Date(Date.now() + 60000),
        ])
      )
    );
    expect(
      (await stores.postgres.query('SELECT count(*)::int n FROM observability.model_exchanges'))
        .rows[0].n
    ).toBe(10);
  });
});
