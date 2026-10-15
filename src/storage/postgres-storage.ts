import type { Pool } from 'pg';
import type { Storage } from './storage.js';

/** Durable key-value storage in the core Postgres schema. */
export class PostgresStorage implements Storage {
  constructor(private readonly pool: Pool) {}

  async load(key: string): Promise<unknown> {
    const result = await this.pool.query<{ value: unknown }>(
      'SELECT value FROM core.kv WHERE key = $1',
      [key]
    );
    return result.rows[0]?.value ?? null;
  }

  async save(key: string, data: unknown): Promise<void> {
    const value = JSON.stringify(data);
    if (value === undefined) throw new Error(`Cannot store a non-JSON value for key ${key}`);
    await this.pool.query(
      `INSERT INTO core.kv (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value]
    );
  }

  async delete(key: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM core.kv WHERE key = $1', [key]);
    return (result.rowCount ?? 0) > 0;
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.pool.query('SELECT 1 FROM core.kv WHERE key = $1', [key]);
    return result.rowCount !== 0;
  }

  async keys(pattern?: string): Promise<string[]> {
    if (pattern === undefined) {
      const result = await this.pool.query<{ key: string }>('SELECT key FROM core.kv ORDER BY key');
      return result.rows.map(({ key }) => key);
    }
    const likePattern = pattern
      .replaceAll('\\', '\\\\')
      .replaceAll('%', '\\%')
      .replaceAll('_', '\\_')
      .replaceAll('*', '%');
    const result = await this.pool.query<{ key: string }>(
      `SELECT key FROM core.kv WHERE key LIKE $1 ESCAPE chr(92) ORDER BY key`,
      [likePattern]
    );
    return result.rows.map(({ key }) => key);
  }
}
