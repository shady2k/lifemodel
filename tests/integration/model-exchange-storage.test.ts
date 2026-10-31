import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCaptureInventory } from '../../loader/src/model-capture-inventory.js';
import { createExchangeCapture } from '../../loader/src/model-exchange-capture.js';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { lockTestMigrationRoles } from '../helpers/apply-test-migrations.js';
import { applyMigrations as applyTestMigrations } from '../../scripts/apply-migrations.js';

describe('gateway capture migration and least privilege', () => {
  let stores: TestStores;
  let roleAbsentDuringMigration = false;
  let unlock: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    stores = await createTestStores();
    // Prevent concurrent worker DBs granting this cluster-global fixture role.
    unlock = await lockTestMigrationRoles(true);
    const roles = await stores.postgres.query(
      "SELECT rolname FROM pg_roles WHERE rolname IN ('lifemodel_capture_writer','lifemodel_capture_reader')"
    );
    expect(roles.rows).toEqual([]);
    const info = vi.spyOn(console, 'info');
    try {
      await applyTestMigrations(stores.postgres);
      expect(info).toHaveBeenCalledExactlyOnceWith(
        'apply-migrations: capture_writer_absent; optional capture grants skipped'
      );
    } finally {
      info.mockRestore();
    }
    await applyTestMigrations(stores.postgres);
    roleAbsentDuringMigration = true;
    const versions = await stores.postgres.query(
      'SELECT version, applied_at FROM public.schema_migrations ORDER BY version'
    );
    const assertGranted = async () => {
      expect(
        (
          await stores.postgres.query(`SELECT
        has_schema_privilege('lifemodel_capture_writer', 'observability', 'USAGE') AS usage,
        has_function_privilege('lifemodel_capture_writer', 'observability.append_model_exchange(text,integer,text,text,text,jsonb,timestamptz)', 'EXECUTE') AS append,
        has_function_privilege('lifemodel_capture_writer', 'observability.prune_model_exchanges()', 'EXECUTE') AS prune
      `)
        ).rows
      ).toEqual([{ usage: true, append: true, prune: true }]);
    };
    // Real startup path: schema first, CNPG role later, then an unchanged
    // migration run repairs the grants. Do not call a grant helper directly.
    await stores.postgres.query('CREATE ROLE lifemodel_capture_writer NOLOGIN');
    await applyTestMigrations(stores.postgres);
    await assertGranted();
    await stores.postgres.query('DROP OWNED BY lifemodel_capture_writer');
    await stores.postgres.query('DROP ROLE lifemodel_capture_writer');
    await stores.postgres.query('CREATE ROLE lifemodel_capture_writer NOLOGIN');
    expect(
      (
        await stores.postgres.query(
          "SELECT has_schema_privilege('lifemodel_capture_writer', 'observability', 'USAGE') AS usage"
        )
      ).rows
    ).toEqual([{ usage: false }]);
    await applyTestMigrations(stores.postgres);
    await assertGranted();
    await applyTestMigrations(stores.postgres);
    expect(
      (
        await stores.postgres.query(
          'SELECT version, applied_at FROM public.schema_migrations ORDER BY version'
        )
      ).rows
    ).toEqual(versions.rows);
  });
  beforeEach(async () => {
    await stores.postgres.query('TRUNCATE observability.model_exchanges');
  });
  afterAll(async () => {
    try {
      await stores.postgres.query('DROP OWNED BY lifemodel_capture_writer');
      await stores.postgres.query('DROP ROLE lifemodel_capture_writer');
    } finally {
      await unlock?.();
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
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
  it('runs migrations before optional grants, repairing a late or recreated writer on the next start', async () => {
    expect(roleAbsentDuringMigration).toBe(true);
    expect(
      (
        await stores.postgres.query(
          "SELECT to_regclass('observability.recent_model_exchanges') AS view"
        )
      ).rows[0].view
    ).toBeNull();
    expect(
      (
        await stores.postgres.query(
          "SELECT rolname FROM pg_roles WHERE rolname='lifemodel_capture_reader'"
        )
      ).rows
    ).toEqual([]);
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
    const rows = await stores.postgres.query('SELECT * FROM observability.model_exchanges');
    expect(rows.rows).toEqual([
      expect.objectContaining({
        call_id: 'call-one',
        exchange: { response: { body: 'redacted' } },
      }),
    ]);
    expect(Number(rows.rows[0].size_bytes)).toBeGreaterThan(0);
    for (const role of ['lifemodel_capture_writer']) {
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
    expect(
      (
        await asRole(
          'lifemodel_capture_writer',
          'SELECT observability.prune_model_exchanges() AS remaining'
        )
      ).rows
    ).toEqual([{ remaining: true }]);
    expect(
      (
        await stores.postgres.query(
          `SELECT proconfig FROM pg_proc WHERE oid='observability.append_model_exchange(text,integer,text,text,text,jsonb,timestamptz)'::regprocedure`
        )
      ).rows[0].proconfig
    ).toEqual(['search_path=pg_catalog']);
  });
  it('returns an empty retention result at startup and after expired-only pruning', async () => {
    const prune = () =>
      asRole(
        'lifemodel_capture_writer',
        'SELECT observability.prune_model_exchanges() AS remaining'
      );
    expect((await prune()).rows).toEqual([{ remaining: false }]);
    await stores.postgres.query(`INSERT INTO observability.model_exchanges(
      call_id,attempt,slot,created_at,exchange,size_bytes
    ) VALUES('expired-only',1,'primary',now()-interval '25 hours','{}',1)`);
    expect((await prune()).rows).toEqual([{ remaining: false }]);
    expect(
      (await stores.postgres.query('SELECT count(*)::int n FROM observability.model_exchanges'))
        .rows
    ).toEqual([{ n: 0 }]);
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
        await stores.postgres.query(
          `SELECT call_id FROM observability.model_exchanges WHERE created_at >= clock_timestamp() - interval '24 hours' AND call_id='expired'`
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
  it('writes until-disabled evidence through the collector and prunes 24-hour age and 100 MiB overflow while still on', async () => {
    let time = Date.now();
    let prunes = 0;
    const inventory = createCaptureInventory({
      setting: {
        current: () => ({ mode: 'until-disabled' }),
        refresh: async () => {},
      },
      now: () => time,
      readSlot: async () => ({ state: 'absent' }),
      passwords: async () => [],
      prune: async () => {
        const result = await asRole(
          'lifemodel_capture_writer',
          'SELECT observability.prune_model_exchanges() AS remaining'
        );
        prunes++;
        return result.rows[0].remaining;
      },
    });
    const capture = createExchangeCapture({
      now: () => time,
      context: (input) => inventory.context(input.sessionId),
      write: async (row) => {
        await asRole('lifemodel_capture_writer', append, [row.callId, row.exchange, row.expiresAt]);
        inventory.noteWrite();
      },
    });
    const count = async () =>
      (await stores.postgres.query('SELECT count(*)::int n FROM observability.model_exchanges'))
        .rows[0].n;
    try {
      await inventory.refresh();
      await expect.poll(() => prunes).toBe(1);
      const attempt = capture.begin({
        callId: 'indefinite',
        attempt: 1,
        slot: 'primary',
        taskId: null,
        sessionId: null,
        inbound: {
          method: 'POST',
          path: '/v1/chat/completions',
          headers: {},
          body: 'personal text',
        },
        upstream: {
          method: 'POST',
          url: 'https://model.test/v1/chat/completions',
          headers: {},
          body: 'personal text',
        },
      });
      expect(attempt).toBeDefined();
      attempt!.response(200, {});
      attempt!.chunk(Buffer.from('reply'));
      attempt!.finish();
      await expect.poll(count).toBe(1);
      expect(
        (
          await stores.postgres.query(
            "SELECT exchange FROM observability.model_exchanges WHERE call_id='indefinite'"
          )
        ).rows[0].exchange.response.body
      ).toBe('reply');
      // Seed AFTER the write: only scheduled maintenance, not append-time pruning, can remove these.
      await stores.postgres
        .query(`INSERT INTO observability.model_exchanges(call_id,attempt,slot,created_at,exchange,size_bytes)
        SELECT 'fixture-'||n,1,'primary',clock_timestamp()-interval '1 minute'*n,'{}',4194304 FROM generate_series(1,26) n`);
      await stores.postgres
        .query(`INSERT INTO observability.model_exchanges(call_id,attempt,slot,created_at,exchange,size_bytes)
        VALUES('expired',1,'primary',now()-interval '25 hours','{}',1)`);
      expect(await count()).toBe(28);
      time += 60_000;
      await inventory.refresh();
      await expect.poll(() => prunes).toBe(2);
      expect(inventory.enabled()).toBe(true);
      expect(
        (
          await stores.postgres.query(
            "SELECT call_id FROM observability.model_exchanges WHERE call_id IN ('expired','fixture-25','fixture-26')"
          )
        ).rows
      ).toEqual([]);
      const retained = await stores.postgres.query(
        'SELECT count(*)::int n, sum(size_bytes)::bigint <= 104857600 AS bounded FROM observability.model_exchanges'
      );
      expect(retained.rows).toEqual([{ n: 25, bounded: true }]);
    } finally {
      capture.close();
      inventory.close();
    }
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
