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

type Result = QueryResult<Record<string, unknown>>;
interface SqlExecutor {
  query: (sql: string, values?: unknown[]) => Promise<Result>;
}

function queryParts(input: unknown, values: unknown): { sql: string; values?: unknown[] } {
  if (typeof input === 'string')
    return { sql: input, ...(Array.isArray(values) ? { values } : {}) };
  if (input && typeof input === 'object' && 'text' in input && typeof input.text === 'string') {
    const configValues = 'values' in input ? input.values : values;
    if (configValues !== undefined && !Array.isArray(configValues))
      throw new Error('Fenced Postgres refused a query with invalid values');
    return { sql: input.text, ...(Array.isArray(configValues) ? { values: configValues } : {}) };
  }
  throw new Error('Fenced Postgres refused a query without inspectable SQL');
}

async function assertActiveHolder(client: SqlExecutor, epoch: number): Promise<void> {
  // Keep the row lock until COMMIT. Takeover updates the same row, so it must
  // wait for this transaction rather than making a checked write stale.
  const result = await client.query(
    'SELECT epoch FROM core.active_holder WHERE id = true FOR SHARE'
  );
  const rawStored = result.rows[0]?.['epoch'];
  const stored =
    typeof rawStored === 'number'
      ? rawStored
      : typeof rawStored === 'string' && /^\d+$/.test(rawStored)
        ? Number(rawStored)
        : null;
  if (stored === null || stored > epoch) throw new StalePostgresEpochError(epoch, stored);
}

/** Every statement through this pool is holder-checked; unknown query forms fail closed. */
export function createFencedPostgres(pool: Pool, epoch: number): Pool {
  const wrapClient = (client: PoolClient): PoolClient => {
    const executor = client as unknown as SqlExecutor;
    let transactionOpen = false;
    const runQuery = async (input: unknown, inputValues: unknown): Promise<Result> => {
      const { sql, values } = queryParts(input, inputValues);
      const command = sql.trim().toUpperCase();
      if (command === 'ROLLBACK' || command.startsWith('ROLLBACK ')) {
        try {
          return await executor.query(sql, values);
        } finally {
          transactionOpen = false;
        }
      }
      if (command === 'BEGIN' || command.startsWith('BEGIN ')) {
        const result = await executor.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        transactionOpen = true;
        try {
          await assertActiveHolder(executor, epoch);
          return result;
        } catch (error) {
          await executor.query('ROLLBACK');
          transactionOpen = false;
          throw error;
        }
      }
      if (command === 'COMMIT' || command.startsWith('COMMIT ')) {
        try {
          return await executor.query(sql, values);
        } catch (error) {
          if (transactionOpen) await executor.query('ROLLBACK');
          throw error;
        } finally {
          transactionOpen = false;
        }
      }
      if (transactionOpen) {
        // The holder row remains locked from BEGIN through COMMIT; checking
        // every statement would add round trips without strengthening the fence.
        return executor.query(sql, values);
      }
      await executor.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      transactionOpen = true;
      try {
        await assertActiveHolder(executor, epoch);
        const result = await executor.query(sql, values);
        await executor.query('COMMIT');
        transactionOpen = false;
        return result;
      } catch (error) {
        await executor.query('ROLLBACK');
        transactionOpen = false;
        throw error;
      }
    };
    return new Proxy(client, {
      get(target, property) {
        if (property === 'query') return runQuery;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  };

  return new Proxy(pool, {
    get(target, property) {
      if (property === 'connect')
        return async (callback?: unknown) => {
          if (callback !== undefined)
            throw new Error('Fenced Postgres does not allow callback-style connect');
          return wrapClient(await target.connect());
        };
      if (property === 'query')
        return async (input: unknown, values?: unknown[]) => {
          const client = await target.connect();
          try {
            return await (wrapClient(client) as unknown as SqlExecutor).query(
              typeof input === 'string' ? input : queryParts(input, values).sql,
              typeof input === 'string' ? values : queryParts(input, values).values
            );
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
