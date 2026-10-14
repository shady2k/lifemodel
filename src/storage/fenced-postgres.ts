import type { Pool, PoolClient, QueryResult } from 'pg';

export class StalePostgresEpochError extends Error {
  constructor(
    readonly writerEpoch: number,
    readonly storedEpoch: number | null
  ) {
    super(
      `StalePostgresEpochError: writer epoch ${String(writerEpoch)} is older than active holder ${storedEpoch === null ? 'missing' : String(storedEpoch)}`
    );
    this.name = 'StalePostgresEpochError';
  }
}

const WRITE = /^\s*(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|COPY)\b/i;
type Result = QueryResult<Record<string, unknown>>;
interface SqlExecutor {
  query: (sql: string, values?: unknown[]) => Promise<Result>;
}

async function assertActiveHolder(client: SqlExecutor, epoch: number): Promise<void> {
  const result = await client.query('SELECT epoch FROM core.active_holder WHERE id = true');
  const rawStored = result.rows[0]?.['epoch'];
  const stored =
    typeof rawStored === 'number'
      ? rawStored
      : typeof rawStored === 'string' && /^\d+$/.test(rawStored)
        ? Number(rawStored)
        : null;
  if (stored === null || stored > epoch) throw new StalePostgresEpochError(epoch, stored);
}

/** One shared fencing boundary for every core Postgres write. */
export function createFencedPostgres(pool: Pool, epoch: number): Pool {
  const wrapClient = (client: PoolClient): PoolClient =>
    new Proxy(client, {
      get(target, property) {
        if (property === 'query')
          return async (sql: string, values?: unknown[]) => {
            const executor = target as unknown as SqlExecutor;
            if (WRITE.test(sql)) await assertActiveHolder(executor, epoch);
            return executor.query(sql, values);
          };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  return new Proxy(pool, {
    get(target, property) {
      if (property === 'connect') return async () => wrapClient(await target.connect());
      if (property === 'query')
        return async (sql: string, values?: unknown[]) => {
          if (!WRITE.test(sql)) {
            const execute = target.query.bind(target) as unknown as SqlExecutor['query'];
            return execute(sql, values);
          }
          const client = await target.connect();
          const executor = client as unknown as SqlExecutor;
          try {
            await client.query('BEGIN');
            await assertActiveHolder(executor, epoch);
            const result = await executor.query(sql, values);
            await client.query('COMMIT');
            return result;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
