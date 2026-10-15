import type { Pool } from 'pg';
import type { AgentConfigFile } from './config-schema.js';

/** The single configuration document owned by the running core. */
export class PostgresConfigStore {
  constructor(private readonly pool: Pool) {}

  async read(): Promise<AgentConfigFile | null> {
    const result = await this.pool.query<{ document: AgentConfigFile }>(
      `SELECT document FROM core.settings WHERE id = 'agent-config'`
    );
    return result.rows[0]?.document ?? null;
  }

  async write(document: AgentConfigFile, options?: { signal?: AbortSignal }): Promise<void> {
    options?.signal?.throwIfAborted();
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      await client.query("SET LOCAL statement_timeout = '5s'");
      options?.signal?.throwIfAborted();
      await client.query(
        `INSERT INTO core.settings (id, document) VALUES ('agent-config', $1::jsonb)
         ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document, updated_at = now()`,
        [JSON.stringify(document)]
      );
      options?.signal?.throwIfAborted();
      await client.query('COMMIT');
    } catch (error) {
      if (began) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* Keep the original cancellation or query error. */
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
