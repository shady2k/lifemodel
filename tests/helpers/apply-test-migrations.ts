import type { Pool } from 'pg';

import { applyMigrations } from '../../scripts/apply-migrations.js';

export function applyTestMigrations(database: Pool): Promise<void> {
  return applyMigrations(database);
}
