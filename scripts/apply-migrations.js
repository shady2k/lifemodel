#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Pool } from 'pg';

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../db/migrations/', import.meta.url));

export function migrationUpSql(source, filename) {
  const lines = source.split(/\r?\n/);
  const upMarkers = lines.flatMap((line, index) =>
    line.trim() === '-- migrate:up' ? [index] : []
  );
  const downMarkers = lines.flatMap((line, index) =>
    line.trim() === '-- migrate:down' ? [index] : []
  );
  if (upMarkers.length !== 1 || downMarkers.length !== 1 || downMarkers[0] < upMarkers[0]) {
    throw new Error(
      `Migration ${filename} must have one -- migrate:up section and one later -- migrate:down section`
    );
  }
  const end = downMarkers[0] ?? lines.length;
  const sql = lines
    .slice(upMarkers[0] + 1, end)
    .join('\n')
    .trim();
  if (!sql) throw new Error(`Migration ${filename} has an empty -- migrate:up section`);
  if (
    lines
      .slice(downMarkers[0] + 1)
      .join('\n')
      .trim()
  ) {
    throw new Error(
      `Migration ${filename} must have an empty -- migrate:down section; rollback SQL is not allowed`
    );
  }
  return sql;
}

export async function applyMigrations(pool, migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
  const migrations = files.map((filename) => {
    const match = filename.match(/^(\d{14})_[a-z0-9_]+\.sql$/);
    if (!match)
      throw new Error(
        `Migration filename must use dbmate's YYYYMMDDHHMMSS_description.sql format: ${filename}`
      );
    return { version: match[1], filename };
  });
  if (new Set(migrations.map(({ version }) => version)).size !== migrations.length) {
    throw new Error('Migration versions must be unique');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version varchar(255) NOT NULL PRIMARY KEY,
      applied_at timestamp without time zone NOT NULL DEFAULT current_timestamp
    )
  `);
  for (const { version, filename } of migrations) {
    const client = await pool.connect();
    try {
      const source = await readFile(path.join(migrationsDir, filename), 'utf8');
      const nonTransactional = source
        .split(/\r?\n/)
        .some((line) => line.trim() === '-- migrate:no-transaction');
      if (nonTransactional) {
        // Concurrent index creation cannot run inside a transaction. Keep the
        // migration lock for the session and record its version after success.
        await client.query('SELECT pg_advisory_lock($1)', [914732661]);
        try {
          const applied = await client.query(
            'SELECT 1 FROM public.schema_migrations WHERE version = $1',
            [version]
          );
          if (!applied.rowCount) {
            const statements = migrationUpSql(source, filename)
              .split(';')
              .map((sql) => sql.trim())
              .filter(Boolean);
            for (const statement of statements) await client.query(statement);
            await client.query('INSERT INTO public.schema_migrations (version) VALUES ($1)', [
              version,
            ]);
          }
        } finally {
          await client.query('SELECT pg_advisory_unlock($1)', [914732661]);
        }
        continue;
      }
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [914732661]);
      const applied = await client.query(
        'SELECT 1 FROM public.schema_migrations WHERE version = $1',
        [version]
      );
      if (applied.rowCount) {
        await client.query('COMMIT');
        continue;
      }
      await client.query(migrationUpSql(source, filename));
      await client.query('INSERT INTO public.schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required to apply database migrations');
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await applyMigrations(pool);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`apply-migrations: ${error.message}`);
    process.exitCode = 1;
  });
}
