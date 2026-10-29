/** Lazy, single-connection capture writer; never called on the model-call stack. */
import { Pool } from 'pg';
import type { CaptureRow } from './model-exchange-capture.js';

export function createExchangeStore(credentials: () => Promise<string>) {
  let pool: Pool | undefined;
  let previous: string | undefined;
  let closed = false;
  async function source(): Promise<Pool> {
    const url = await credentials();
    if (closed) throw new Error('capture_closed');
    if (pool && previous !== url) {
      void pool.end().catch(() => undefined);
      pool = undefined;
    }
    if (!pool) {
      previous = url;
      pool = new Pool({
        connectionString: url,
        max: 1,
        connectionTimeoutMillis: 1000,
        query_timeout: 1000,
        statement_timeout: 1000,
        lock_timeout: 250,
        idleTimeoutMillis: 1000,
        allowExitOnIdle: true,
        application_name: 'lifemodel-capture',
      });
      pool.on('error', () => undefined);
    }
    return pool;
  }
  return {
    async write(row: CaptureRow): Promise<void> {
      const db = await source();
      await db.query(
        'SELECT observability.append_model_exchange($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz)',
        [
          row.callId,
          row.attempt,
          row.slot,
          row.taskId,
          row.sessionId,
          JSON.stringify(row.exchange),
          row.expiresAt,
        ]
      );
    },
    async prune(): Promise<void> {
      await (await source()).query('SELECT observability.prune_model_exchanges()');
    },
    async close(): Promise<void> {
      closed = true;
      await pool?.end();
    },
  };
}
