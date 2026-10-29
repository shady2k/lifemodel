import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyTestMigrations as applyMigrations } from '../helpers/apply-test-migrations.js';
import { createTestStores } from '../helpers/test-stores.js';

const migrations = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

// Exercise the production runner's per-file transaction, not isolated SQL
// statements: deferred terminal/outbox checks survive until that file commits.
describe('task trace migration upgrades', () => {
  it.each([22, 23])(
    'backfills a terminal task from schema %s without changing its outcome',
    async (schema) => {
      const stores = await createTestStores();
      const directory = await mkdtemp(join(tmpdir(), 'task-trace-upgrade-'));
      try {
        await stores.postgres.query(`
        DROP SCHEMA IF EXISTS observability CASCADE;
        DROP SCHEMA IF EXISTS task_access CASCADE;
        DROP SCHEMA IF EXISTS storage CASCADE;
        DROP SCHEMA IF EXISTS core CASCADE;
        DROP TABLE IF EXISTS public.schema_migrations;
      `);
        const files = (await readdir(migrations)).filter((file) => file.endsWith('.sql')).sort();
        for (const file of files.filter(
          (file) => Number(file.slice(0, 14)) <= 20261015000000 + schema
        )) {
          await writeFile(join(directory, file), await readFile(join(migrations, file)));
        }
        await applyMigrations(stores.postgres, directory);
        await stores.postgres.query(`
        INSERT INTO core.tasks (
          id, launch_key, briefing, profile, settings_revision, harness,
          image_revision, request_image_revision, wrap_grace_seconds, state
        ) VALUES (
          'task_upgrade', 'upgrade', 'Upgrade fixture', '{}', 0, 'prime-agent',
          'sha256:' || repeat('a', 64), 'sha256:' || repeat('a', 64), 60, 'starting'
        );
        INSERT INTO core.task_launches (task_id, attempt_id, launch_id, job_name, tombstoned_at)
          VALUES ('task_upgrade', 'attempt_upgrade', 'launch_upgrade', 'upgrade', clock_timestamp());
      `);
        if (schema === 23) {
          // A real post-23 terminal commit has termination/revocation/seal proof
          // and a matching outbox. No task guards are disabled for this fixture.
          const client = await stores.postgres.connect();
          try {
            await client.query('BEGIN');
            await client.query(`
            UPDATE core.task_launches SET termination_confirmed_at=clock_timestamp()
              WHERE task_id='task_upgrade';
            INSERT INTO task_access.intents (
              task_id, attempt_id, launch_id, revision, mode, soft_due_at, hard_stop_at
            ) VALUES ('task_upgrade', 'attempt_upgrade', 'launch_upgrade', 1, 'revoked', now(), now());
            UPDATE core.tasks SET state='done', terminal_candidate='done',
              terminal_reason_code='completed', terminal_at=clock_timestamp(),
              terminal_summary='Finished', candidate_revision=1,
              seal_request='{"space":"space_upgrade","effectKey":"seal_upgrade","expectedRevision":0,"intentRevision":1,"outcome":"completed","candidateRevision":1}',
              seal_receipt='{"state":"sealed","space":"space_upgrade","effectKey":"seal_upgrade","outcome":"completed","manifest":{"objects":[{"mark":"result"}]}}'
              WHERE id='task_upgrade';
            INSERT INTO core.task_outcomes (outcome_key, task_id, launch_id, event)
              VALUES ('outcome_launch_upgrade', 'task_upgrade', 'launch_upgrade',
                '{"outcomeKey":"outcome_launch_upgrade","taskId":"task_upgrade","state":"done","reasonCode":"completed","summary":"Finished","objects":[{"mark":"result"}]}');
          `);
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        } else {
          // Schema 22 accepted terminal rows before sealed-outcome proof existed.
          await stores.postgres.query(`
          UPDATE core.tasks SET state='running' WHERE id='task_upgrade';
          UPDATE core.tasks SET state='done', terminal_candidate='done',
            terminal_reason_code='completed', terminal_at=clock_timestamp()
            WHERE id='task_upgrade';
        `);
        }
        const before = await stores.postgres.query('SELECT * FROM core.tasks');
        const launchBefore = await stores.postgres.query('SELECT * FROM core.task_launches');
        for (const file of files) {
          await writeFile(join(directory, file), await readFile(join(migrations, file)));
        }
        await expect(applyMigrations(stores.postgres, directory)).resolves.toBeUndefined();
        const after = await stores.postgres.query('SELECT * FROM core.tasks');
        expect(after.rows).toEqual([
          expect.objectContaining({
            ...before.rows[0],
            trace_id: 'task_upgrade',
            parent_span_id: null,
          }),
        ]);
        const launchAfter = await stores.postgres.query('SELECT * FROM core.task_launches');
        expect(launchAfter.rows).toEqual([expect.objectContaining(launchBefore.rows[0])]);
        const outcomes = await stores.postgres.query('SELECT event FROM core.task_outcomes');
        expect(outcomes.rowCount).toBe(schema === 23 ? 1 : 0);
        if (schema === 23) {
          expect(outcomes.rows[0].event).toEqual({
            outcomeKey: 'outcome_launch_upgrade',
            taskId: 'task_upgrade',
            state: 'done',
            reasonCode: 'completed',
            summary: 'Finished',
            objects: [{ mark: 'result' }],
          });
        }
        await expect(applyMigrations(stores.postgres, directory)).resolves.toBeUndefined();
        // Trace backfill is the only exemption. Both no-op and changed metadata
        // updates still require an outbox, with the original deferred timing.
        for (const assignment of [
          'updated_at=updated_at',
          "updated_at=updated_at + interval '1 second'",
        ]) {
          const client = await stores.postgres.connect();
          try {
            await client.query('BEGIN');
            await client.query("DELETE FROM core.task_outcomes WHERE task_id='task_upgrade'");
            await expect(
              client.query(`UPDATE core.tasks SET ${assignment} WHERE id='task_upgrade'`)
            ).resolves.toBeDefined();
            await expect(client.query('COMMIT')).rejects.toThrow('task outcome required');
          } finally {
            await client.query('ROLLBACK');
            client.release();
          }
        }
        if (schema === 23) {
          await expect(
            stores.postgres.query(
              'UPDATE core.task_outcomes SET event=event || \'{"summary":"changed"}\' WHERE task_id=\'task_upgrade\''
            )
          ).rejects.toThrow('task outcome immutable');
          expect(
            (await stores.postgres.query('SELECT event FROM core.task_outcomes')).rows
          ).toEqual(outcomes.rows);
        } else {
          expect(after.rows[0]).toMatchObject({
            seal_request: null,
            seal_receipt: null,
            terminal_summary: null,
          });
        }
        await expect(
          stores.postgres.query("UPDATE core.tasks SET trace_id='changed' WHERE id='task_upgrade'")
        ).rejects.toThrow('task trace immutable');
        await expect(
          stores.postgres.query(
            "UPDATE core.tasks SET state='failed', terminal_candidate='failed' WHERE id='task_upgrade'"
          )
        ).rejects.toThrow('task terminal immutable');
      } finally {
        await rm(directory, { recursive: true, force: true });
        await Promise.all([stores.postgres.end(), stores.redis.quit()]);
      }
    }
  );
});
