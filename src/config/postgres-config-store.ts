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

  async write(document: AgentConfigFile): Promise<void> {
    await this.pool.query(
      `INSERT INTO core.settings (id, document) VALUES ('agent-config', $1::jsonb)
       ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document, updated_at = now()`,
      [JSON.stringify(document)]
    );
  }
}
