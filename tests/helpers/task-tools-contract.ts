/** Shared T07 durable boundary: real TLS/mailbox/owner intake, synthetic Pod proof only. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { expect } from 'vitest';
import { createTestStores, workerDatabaseUrl } from './test-stores.js';
import { applyTestMigrations } from './apply-test-migrations.js';
import { createPlatformSettingsReader } from '../../src/config/platform-settings.js';
import { createTestLogger } from './test-logger.js';
import { createPostgresTaskRegistry } from '../../src/storage/postgres-task-registry.js';
import { createPostgresTaskMailbox } from '../../src/storage/postgres-task-mailbox.js';
import { createTaskService } from '../../src/core/task-service.js';
import { createTaskChannel } from '../../src/core/task-channel.js';
import { TaskJsonClient } from '../../loader/src/task-launcher-http.js';
import { OwnerMessageIntake } from '../../src/storage/owner-message-intake.js';
import type { TaskChannelProof, TaskChannelFrame } from '../../src/ports/task-channel.js';
import type { TestStorageCertificate } from './storage-certificate.js';

export async function taskToolsContract(certificate: TestStorageCertificate, directory: string) {
  const stores = await createTestStores();
  const pool = new Pool({ connectionString: workerDatabaseUrl(), max: 2 });
  pool.on('error', () => undefined);
  await applyTestMigrations(stores.postgres);
  await stores.postgres.query(
    'TRUNCATE core.tasks CASCADE; TRUNCATE task_access.start_claims,task_access.projections,task_access.intents; TRUNCATE storage.spaces CASCADE'
  );
  await stores.postgres.query(
    'INSERT INTO core.active_holder VALUES(true,1) ON CONFLICT(id) DO UPDATE SET epoch=1'
  );
  const settings = createPlatformSettingsReader({
    logger: createTestLogger(),
    dir: '/nonexistent-task-settings',
  });
  async function seed(
    key: string
  ): Promise<TaskChannelProof & { taskId: string; attemptId: string; launchId: string }> {
    const registry = createPostgresTaskRegistry({ pool: stores.postgres, epoch: 1, settings });
    const task = await registry.accept({
      launchKey: key,
      briefing: 'mailbox fixture',
      profile: {
        id: 'small',
        revision: '1',
        timeoutSeconds: 600,
        cpuMillis: 500,
        memoryBytes: 536870912,
      },
      imageRevision: `sha256:${'a'.repeat(64)}`,
    });
    await registry.admitNext();
    await stores.postgres.query(
      'INSERT INTO storage.spaces(id) VALUES($1) ON CONFLICT DO NOTHING',
      [`space-${key}`]
    );
    await stores.postgres.query(
      'INSERT INTO storage.allocations(task_id,launch_id,space_id,retention_revision) VALUES($1,$2,$3,$4)',
      [task.id, task.launchId, `space-${key}`, String(task.settingsRevision)]
    );
    await registry.recordAllocation(task.id, task.launchId, {
      id: 'receipt-1',
      space: `space-${key}`,
      effectKey: `${key}:allocate`,
    });
    await registry.bindJob(task.id, task.launchId, `job-${key}`, 'b'.repeat(64));
    const startedAt = new Date().toISOString();
    await registry.initializeAccessIntent(task.id, new Date(startedAt));
    const result = {
      taskId: task.id,
      attemptId: task.attemptId,
      launchId: task.launchId,
      podUid: `pod-${key}`,
      podName: `pod-${key}`,
      jobUid: `job-${key}`,
      jobName: task.jobName,
      launchLabel: task.launchId.slice(7, 65),
      templateHash: 'b'.repeat(64),
      startedAt,
    };
    await stores.postgres.query(
      'UPDATE core.task_launches SET pod_uid=$2,job_uid=$3 WHERE task_id=$1',
      [task.id, result.podUid, result.jobUid]
    );
    await stores.postgres.query(
      `INSERT INTO task_access.start_claims(launch_id,task_id,attempt_id,pod_uid,job_uid,boot_nonce,job_started_at,soft_due_at,hard_stop_at) VALUES($1,$2,$3,$4,$5,'abcdefghijklmnop',$6,$6::timestamptz+interval '10 minutes',$6::timestamptz+interval '15 minutes')`,
      [task.launchId, task.id, task.attemptId, result.podUid, result.jobUid, result.startedAt]
    );
    const intent = (await registry.readAccessIntent(task.id))!;
    await stores.postgres.query(
      `INSERT INTO task_access.projections(task_id,attempt_id,launch_id,job_uid,pod_uid,pod_name,job_name,space_id,access_revision,intent_revision,mode,soft_due_at,hard_stop_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,0,'active',$9,$10)`,
      [
        task.id,
        task.attemptId,
        task.launchId,
        result.jobUid,
        result.podUid,
        result.podName,
        result.jobName,
        `space-${key}`,
        intent.softDueAt,
        intent.hardStopAt,
      ]
    );
    return result;
  }
  const first = await seed('first');
  const second = await seed('second');
  const mailbox = createPostgresTaskMailbox({ pool, epoch: 1 });
  const channel = createTaskChannel({
    tls: { cert: certificate.cert, key: certificate.key },
    settings: (await settings.read()).values,
    mailbox,
    identity: {
      verify: async (token) => {
        if (token === 'first-token') return first;
        if (token === 'second-token') return second;
        throw new Error('fixture_identity_denied');
      },
    },
    logger: createTestLogger(),
  });
  await new Promise<void>((resolve) => channel.server.listen(0, '127.0.0.1', resolve));
  const address = channel.server.address();
  if (!address || typeof address === 'string') throw new Error('channel_bind_failed');
  const origin = `https://localhost:${address.port}`;
  await writeFile(join(directory, 'channel-ca'), certificate.ca);
  await writeFile(join(directory, 'channel-token'), 'first-token');
  await writeFile(join(directory, 'second-channel-token'), 'second-token');
  const endpoint = {
    endpoint: origin,
    tokenFile: join(directory, 'channel-token'),
    caFile: join(directory, 'channel-ca'),
  };
  const firstClient = new TaskJsonClient(endpoint);
  const secondClient = new TaskJsonClient({
    ...endpoint,
    tokenFile: join(directory, 'second-channel-token'),
  });
  let sequence = 0;
  const attempts: TaskChannelFrame[] = [];
  return {
    stores,
    mailbox,
    service: createTaskService({
      tasks: createPostgresTaskRegistry({ pool: stores.postgres, epoch: 1, settings }),
      mailbox,
    }),
    first,
    second,
    endpoint,
    attempts,
    async report(kind: 'step' | 'question', text: string, messageId: string) {
      const frame = {
        taskId: first.taskId,
        attemptId: first.attemptId,
        direction: 'task_to_core',
        messageId,
        sequence: ++sequence,
        kind,
        payload: kind === 'step' ? { line: text } : { questionId: messageId, text },
      } as TaskChannelFrame;
      // Simulate a lost event ACK end to end. Exact frame is redelivered to the
      // real listener and fenced mailbox, not re-created with a fresh identity.
      attempts.push(frame, frame);
      const ack = await firstClient.call('/task/events', frame);
      const replay = await firstClient.call('/task/events', frame);
      expect(replay).toEqual(ack);
      expect(
        await stores.postgres.query(
          'SELECT 1 FROM core.task_mailbox WHERE task_id=$1 AND message_id=$2',
          [first.taskId, messageId]
        )
      ).toMatchObject({ rowCount: 1 });
    },
    async responsiveness() {
      const owner = new OwnerMessageIntake(stores.redis, 'owner', {
        streamKey: `mcp-owner:${randomUUID()}`,
      });
      const ownerMs: number[] = [];
      const controlMs: number[] = [];
      await Promise.all([
        ...Array.from({ length: 20 }, async () => {
          const start = performance.now();
          const time = Date.now().toString(16).padStart(12, '0');
          const id = `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(0, 3)}-8${randomUUID().slice(0, 3)}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
          expect((await owner.acceptOwnerMessage(id, 'Owner still talks')).status).toBe('accepted');
          ownerMs.push(performance.now() - start);
        }),
        (async () => {
          // One bounded ordered command stream, 20 controls with durable ACKs.
          for (let i = 0; i < 20; i++) {
            const start = performance.now();
            const command = await mailbox.enqueueCommand({
              taskId: second.taskId,
              attemptId: second.attemptId,
              commandId: `second-${i}`,
              kind: 'steer',
              text: 'Keep working',
            });
            expect((await secondClient.call('/task/commands'))['command']).toEqual(command);
            await secondClient.call('/task/commands/ack', {
              taskId: second.taskId,
              attemptId: second.attemptId,
              commandId: command.commandId,
              disposition: 'accepted',
            });
            controlMs.push(performance.now() - start);
          }
        })(),
      ]);
      expect(ownerMs).toHaveLength(20);
      expect(controlMs).toHaveLength(20);
      expect(Math.max(...ownerMs)).toBeLessThanOrEqual(2000);
      expect(Math.max(...controlMs)).toBeLessThanOrEqual(2000);
      return { ownerMs, controlMs };
    },
    async close() {
      firstClient.close();
      secondClient.close();
      await channel.stop(Date.now() + 1000);
      mailbox.stop();
      await pool.end();
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    },
  };
}
