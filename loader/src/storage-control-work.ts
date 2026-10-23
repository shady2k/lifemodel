/** Request-owned SQL cancellation. Capacity stays owned until checkout and socket teardown settle. */
import { Client, type Pool, type PoolClient } from 'pg';
import { StorageAccessError } from './storage-access-error.js';

/** PostgreSQL acknowledges termination (including rollback) before capacity retires.
 * Cancellation has its own connection, never a checkout behind the blocked query.
 * The module role may terminate its own sessions; no superuser right is needed. */
export async function terminateStorageQuery(connectionString: string, pid: number): Promise<void> {
  const cancel = new Client({
    connectionString,
    connectionTimeoutMillis: 1000,
    query_timeout: 2000,
    statement_timeout: 2000,
    application_name: 'lifemodel-storage-cancel',
  });
  cancel.on('error', () => undefined);
  try {
    await cancel.connect();
    const result = await cancel.query<{ stopped: boolean }>(
      'SELECT pg_terminate_backend($1, 1500) AS stopped',
      [pid]
    );
    if (!result.rows[0]?.stopped) throw new StorageAccessError(503, 'catalog_unavailable');
  } finally {
    await cancel.end().catch(() => undefined);
  }
}

/** A rejected terminal query is never an acknowledgement, even with SQLSTATE.
 * Mark retirement before a caller converts the error to a public refusal. */
export async function storageSqlCompletion(
  client: PoolClient,
  command: 'COMMIT' | 'ROLLBACK',
  retire: () => void
): Promise<void> {
  try {
    await client.query(command);
  } catch (error) {
    retire();
    throw error;
  }
}

export async function withStorageSqlClient<T>(
  pool: Pool,
  connectionString: string,
  signal: AbortSignal | undefined,
  run: (client: PoolClient, retire: () => void) => Promise<T>
): Promise<T> {
  signal?.throwIfAborted();
  // Do not detach a pending checkout: it is still executing work for this slot.
  const client = await pool.connect();
  let cancellation: Promise<void> | undefined;
  let pid: number | undefined;
  let broken = false;
  const failed = (): void => {
    broken = true;
  };
  client.on('error', failed);
  const abort = (): void => {
    broken = true;
    if (pid !== undefined) {
      cancellation ??= terminateStorageQuery(connectionString, pid);
      // The awaited promise below owns failure; keep the event callback safe.
      void cancellation.catch(() => undefined);
    }
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    if (signal?.aborted) abort();
    signal?.throwIfAborted();
    const result = await run(client, failed);
    signal?.throwIfAborted();
    if (broken) throw new StorageAccessError(503, 'catalog_unavailable');
    return result;
  } catch (error) {
    // A local query timeout is not proof that the backend stopped its query.
    const code = (error as { code?: unknown } | null)?.code;
    if (
      !(error instanceof StorageAccessError) &&
      (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code))
    )
      broken = true;
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    try {
      await cancellation;
    } finally {
      if (broken) await client.end().catch(() => undefined);
      client.removeListener('error', failed);
      client.release(broken);
    }
  }
}
