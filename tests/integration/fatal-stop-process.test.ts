import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Redis from 'iovalkey';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStores, testStoreUrls, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createPersistentRecipientRegistry } from '../../src/core/recipient-registry.js';
import { createSnapshotStore } from '../../src/storage/snapshot-store.js';
import { InboundMessageStream } from '../../src/core/message-streams.js';
import { createUserMessageSignal } from '../../src/types/signal.js';
import { createTestLogger } from '../helpers/test-logger.js';

const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx');
const CHILD = join(process.cwd(), 'tests', 'fixtures', 'fatal-stop-child.ts');

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

function startCore(env: NodeJS.ProcessEnv): {
  child: ChildProcess;
  result: Promise<ProcessResult>;
} {
  const child = spawn(TSX, [CHILD], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const result = new Promise<ProcessResult>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal, output }));
  });
  return { child, result };
}

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(20);
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a health port');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return port;
}

describe('fatal stop through the real entrypoint and stores', { timeout: 120_000 }, () => {
  let stores: TestStores;
  let redis: Redis;
  let child: ChildProcess | undefined;
  let dataRoot: string;

  beforeAll(async () => {
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
    const valkeyUrl = new URL(testStoreUrls().valkeyUrl);
    valkeyUrl.pathname = '/5';
    redis = new Redis(valkeyUrl.toString());
    await redis.flushdb();
    dataRoot = await mkdtemp(join(tmpdir(), 'lifemodel-fatal-stop-'));
  });

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child?.once('exit', () => resolve()));
    }
    await redis?.quit();
    await stores?.redis.quit();
    await stores?.postgres.end();
    if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
  });

  it.each(['clean', 'stalled'] as const)(
    '%s fatal history failure exits through the bounded stop coordinator without committing',
    async (mode) => {
      const runId = `${stores.workerId}-${Date.now()}-${mode}`;
      const recipientId = createPersistentRecipientRegistry(
        stores.postgres,
        createTestLogger()
      ).getOrCreate('test', runId);
      const registry = createPersistentRecipientRegistry(stores.postgres, createTestLogger());
      const preparedRecipient = registry.getOrCreate('test', runId);
      expect(preparedRecipient).toBe(recipientId);
      await registry.flush();
      await stores.postgres.query(`
        CREATE OR REPLACE FUNCTION core.reject_fatal_test_history() RETURNS trigger AS $$
        BEGIN
          IF NEW.recipient_id = '${recipientId}' THEN
            RAISE EXCEPTION 'fatal test history write rejected';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await stores.postgres.query(`
        CREATE TRIGGER reject_fatal_test_history BEFORE INSERT ON core.conversation_messages
        FOR EACH ROW EXECUTE FUNCTION core.reject_fatal_test_history()
      `);

      const port = await availablePort();
      const snapshotStore = createSnapshotStore(redis);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        LIFEMODEL_VALKEY_URL: new URL('/5', testStoreUrls().valkeyUrl).toString(),
        LIFEMODEL_DATABASE_URL: new URL(
          `/${`lifemodel_test_worker_${stores.workerId}`}`,
          testStoreUrls().databaseUrl
        ).toString(),
        MOTOR_CORTEX_ENABLED: 'false',
        NODE_ENV: 'production',
        DATA_PATH: join(dataRoot, mode),
        LIFEMODEL_CORE_HEALTH_PORT: String(port),
        LIFEMODEL_CORE_STOP_DEADLINE_MS: mode === 'stalled' ? '250' : '2000',
        TEST_STALL_REGISTRY_FLUSH: mode === 'stalled' ? 'true' : 'false',
      };
      const beforeStart = await snapshotStore.read();
      const running = startCore(env);
      child = running.child;
      try {
        await waitFor(async () => {
          if (running.child.exitCode !== null) return true;
          try {
            return (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200;
          } catch {
            return false;
          }
        }, 'real core health endpoint');
        if (running.child.exitCode !== null)
          throw new Error(`Core exited during startup: ${(await running.result).output}`);
        await waitFor(
          async () => (await snapshotStore.read()) !== null,
          'initial durable snapshot'
        );
        const baseline = await snapshotStore.read();
        expect(baseline).not.toBeNull();
        if (!beforeStart) expect(baseline?.tick).toBeGreaterThan(0);

        const inbound = new InboundMessageStream(redis);
        await inbound.append(
          createUserMessageSignal({
            text: 'force history persistence failure',
            recipientId,
            channel: 'test',
            updateId: `fatal-${runId}`,
          })
        );
        const result = await Promise.race([
          running.result,
          delay(5_000).then(() => {
            if (running.child.exitCode === null) running.child.kill('SIGKILL');
            return running.result;
          }),
        ]);
        child = undefined;
        expect(result.signal).toBeNull();
        expect(result.code).toBe(1);
        expect(result.output).toContain('fatal test history write rejected');
        expect(result.output).toContain('Shutdown triggered: fatal core error');
        if (mode === 'clean') {
          expect(result.output).not.toContain('Stop deadline reached');
        } else {
          expect(result.output).toContain('REGISTRY_FLUSH_ENTERED');
          expect(result.output).toContain(
            'Stop deadline reached: the process exits now, whatever is still pending'
          );
          expect(result.output).toContain('state_flush');
        }
        expect(await snapshotStore.read()).toEqual(baseline);
      } finally {
        if (child && child.exitCode === null) {
          child.kill('SIGKILL');
          await new Promise<void>((resolve) => child?.once('exit', () => resolve()));
          child = undefined;
        }
        await stores.postgres.query(
          'DROP TRIGGER IF EXISTS reject_fatal_test_history ON core.conversation_messages'
        );
        await stores.postgres.query('DROP FUNCTION IF EXISTS core.reject_fatal_test_history()');
      }
    }
  );
});
