/** Durable write admission. Session locks span effects, never SQL row transactions. */
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { StorageAccessError } from './storage-access-error.js';
const LOCK = '653740016';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface MaintenanceStatus {
  generation: string | null;
  purpose: 'backup' | 'restore' | null;
  state: 'normal' | 'draining' | 'held' | 'reconciling';
  cutAt: string | null;
}
export interface StorageMaintenance {
  status(): Promise<MaintenanceStatus>;
  begin(input: unknown): Promise<MaintenanceStatus>;
  release(input: unknown): Promise<MaintenanceStatus>;
  releaseDegraded(input: unknown): Promise<MaintenanceStatus>;
  prepareRestore(input: { generation: string; artifactSha256: string }): Promise<MaintenanceStatus>;
  enter(parent?: AbortSignal): Promise<{ signal: AbortSignal; close(): Promise<void> }>;
  run<T>(work: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T>;
  close(): Promise<void>;
}
function fail(code: string, status = 503): never {
  throw new StorageAccessError(status, code);
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_request', 400);
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((k) => !Object.hasOwn(row, k)))
    fail('invalid_request', 400);
  return row;
}
export function createStorageMaintenance(options: {
  connectionString: string;
  drainMs?: number;
  settleMs?: number;
}): StorageMaintenance {
  const live = new Set<{ controller: AbortController; client: Client }>();
  let closed = false;
  function client(timeout = 5000) {
    const c = new Client({
      connectionString: options.connectionString,
      connectionTimeoutMillis: 5000,
      query_timeout: timeout,
      statement_timeout: timeout,
      lock_timeout: timeout,
      application_name: 'lifemodel-storage-maintenance',
    });
    c.on('error', () => undefined);
    return c;
  }
  async function connected<T>(work: (c: Client) => Promise<T>, timeout = 5000) {
    const c = client(timeout);
    try {
      await c.connect();
      return await work(c);
    } catch (error) {
      if (error instanceof StorageAccessError) throw error;
      fail('maintenance_unavailable');
    } finally {
      await c.end().catch(() => undefined);
    }
  }
  async function status(c?: Client): Promise<MaintenanceStatus> {
    if (!c) return connected(status);
    const row = (
      await c.query<Omit<MaintenanceStatus, 'cutAt'> & { cutAt: Date | null }>(
        'SELECT generation,purpose,state,cut_at AS "cutAt" FROM storage.maintenance WHERE id=true'
      )
    ).rows[0];
    if (!row) fail('maintenance_unavailable');
    return { ...row, cutAt: row.cutAt?.toISOString() ?? null };
  }
  async function enter(parent?: AbortSignal) {
    if (closed) fail('maintenance_unavailable');
    const c = client();
    const controller = new AbortController();
    const failed = () => {
      controller.abort();
    };
    c.on('error', failed);
    c.on('end', failed);
    const signal = AbortSignal.any([controller.signal, ...(parent ? [parent] : [])]);
    const item = { client: c, controller };
    live.add(item);
    let ended: Promise<void> | undefined;
    const close = () =>
      (ended ??= (async () => {
        live.delete(item);
        await c.end().catch(() => undefined);
      })());
    try {
      signal.throwIfAborted();
      await c.connect();
      // Never queue behind a draining hold's exclusive lock while an admitted
      // effect is still settling. The row fence below resolves admission races.
      const admitted = await c.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock_shared(${LOCK}) AS locked`
      );
      if (!admitted.rows[0]?.locked) fail('storage_held');
      await c.query('BEGIN');
      await c.query('SELECT id FROM storage.maintenance WHERE id=true FOR SHARE');
      if ((await status(c)).state !== 'normal') fail('storage_held');
      signal.throwIfAborted();
      await c.query('COMMIT');
      return { signal, close };
    } catch (error) {
      await close();
      if (error instanceof StorageAccessError) throw error;
      fail('maintenance_unavailable');
    }
  }
  async function release(value: unknown, degraded = false): Promise<MaintenanceStatus> {
    const input = exact(value, degraded ? ['generation', 'unavailable'] : ['generation']);
    const generation = input['generation'];
    if (typeof generation !== 'string' || !UUID.test(generation)) fail('invalid_request', 400);
    const unavailable = input['unavailable'];
    if (
      degraded &&
      (typeof unavailable !== 'number' || !Number.isSafeInteger(unavailable) || unavailable <= 0)
    )
      fail('invalid_request', 400);
    return connected(async (c) => {
      await c.query('BEGIN');
      await c.query('SELECT id FROM storage.maintenance WHERE id=true FOR UPDATE');
      const row = await status(c);
      if (row.generation !== generation) fail('hold_conflict', 409);
      if (degraded && row.purpose !== 'restore') fail('restore_pending', 409);
      if (row.purpose === 'restore') {
        const progress = (
          await c.query<{ complete: boolean; unavailable: string }>(
            'SELECT complete,unavailable FROM storage.restore_progress WHERE generation=$1 FOR SHARE',
            [generation]
          )
        ).rows[0];
        // Acceptance changes only admission. Availability, marks, receipts and
        // ledger debt remain intact, including on an idempotent release retry.
        const accepted = degraded ? BigInt(unavailable as number) : 0n;
        if (!progress?.complete || BigInt(progress.unavailable) !== accepted)
          fail('restore_pending', 409);
      }
      if (row.state === 'draining') fail('hold_pending', 409);
      await c.query("UPDATE storage.maintenance SET state='normal' WHERE id=true");
      await c.query('COMMIT');
      return status(c);
    });
  }
  const api: StorageMaintenance = {
    status: () => status(),
    enter,
    run: async (work, parent) => {
      const op = await enter(parent);
      try {
        return await work(op.signal);
      } finally {
        await op.close();
      }
    },
    begin: async (value) => {
      const input = exact(value, ['effectKey']);
      if (
        typeof input['effectKey'] !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(input['effectKey'])
      )
        fail('invalid_request', 400);
      const hold = await connected(async (c) => {
        await c.query('BEGIN');
        await c.query('SELECT id FROM storage.maintenance WHERE id=true FOR UPDATE');
        const row = (
          await c.query<{ state: MaintenanceStatus['state']; effect_key: string | null }>(
            'SELECT state,effect_key FROM storage.maintenance WHERE id=true'
          )
        ).rows[0];
        if (!row) fail('maintenance_unavailable');
        if (row.state !== 'normal' && row.effect_key !== input['effectKey'])
          fail('hold_conflict', 409);
        if (row.state === 'normal')
          await c.query(
            "UPDATE storage.maintenance SET generation=$1,purpose='backup',state='draining',effect_key=$2,cut_at=NULL WHERE id=true",
            [randomUUID(), input['effectKey']]
          );
        await c.query('COMMIT');
        return status(c);
      });
      if (hold.state === 'held' || hold.state === 'reconciling') return hold;
      // Cancel local handlers at the drain bound, retaining the DB fence on timeout.
      const timer = setTimeout(() => {
        for (const op of live) op.controller.abort();
      }, options.drainMs ?? 15000);
      timer.unref();
      try {
        return await connected(
          async (c) => {
            await c.query(`SELECT pg_advisory_lock(${LOCK})`);
            await c.query(
              "UPDATE storage.maintenance SET state='held',cut_at=clock_timestamp() WHERE id=true AND generation=$1 AND state='draining'",
              [hold.generation]
            );
            const result = await status(c);
            if (result.generation !== hold.generation || result.state !== 'held')
              fail('hold_conflict', 409);
            return result;
          },
          (options.drainMs ?? 15000) + (options.settleMs ?? 5000)
        );
      } finally {
        clearTimeout(timer);
      }
    },
    release: (value) => release(value),
    releaseDegraded: (value) => release(value, true),
    prepareRestore: async (input) => {
      if (!UUID.test(input.generation) || !/^[0-9a-f]{64}$/.test(input.artifactSha256))
        fail('invalid_request', 400);
      return connected(async (c) => {
        await c.query(`SELECT pg_advisory_lock(${LOCK})`);
        await c.query('BEGIN');
        await c.query('SELECT id FROM storage.maintenance WHERE id=true FOR UPDATE');
        const current = await status(c);
        if (current.state === 'normal') fail('restore_requires_hold', 409);
        if (current.purpose === 'restore' && current.generation === input.generation) {
          const saved = (
            await c.query<{ artifact_sha256: string | null }>(
              'SELECT artifact_sha256 FROM storage.restore_progress WHERE generation=$1',
              [input.generation]
            )
          ).rows[0];
          if (saved?.artifact_sha256 !== input.artifactSha256) fail('hold_conflict', 409);
          await c.query('COMMIT');
          return current;
        }
        // A generation is single-use: stale completion/cursor rows must never
        // certify a newly seeded set, including after release or another hold.
        if (
          (
            await c.query('SELECT 1 FROM storage.restore_progress WHERE generation=$1', [
              input.generation,
            ])
          ).rowCount
        )
          fail('hold_conflict', 409);
        await c.query(
          "UPDATE storage.maintenance SET generation=$1,purpose='restore',state='held' WHERE id=true",
          [input.generation]
        );
        await c.query(
          `INSERT INTO storage.version_availability(object_id,generation,status) SELECT object_id,$1,'unverified' FROM storage.object_versions ON CONFLICT(object_id) DO UPDATE SET generation=EXCLUDED.generation,status='unverified',checked_at=NULL`,
          [input.generation]
        );
        await c.query(
          'INSERT INTO storage.restore_progress(generation,artifact_sha256) VALUES($1,$2) ON CONFLICT(generation) DO NOTHING',
          [input.generation, input.artifactSha256]
        );
        await c.query('COMMIT');
        return status(c);
      });
    },
    close: () => {
      closed = true;
      for (const item of live) item.controller.abort();
      return Promise.resolve();
    },
  };
  return api;
}
