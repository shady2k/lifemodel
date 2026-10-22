import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Redis from 'iovalkey';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStores, testStoreUrls, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { reapProcessGroupOnExit, stopProcessGroup } from '../helpers/child-process-group.js';
import { createPersistentRecipientRegistry } from '../../src/core/recipient-registry.js';
import { InboundMessageStream } from '../../src/core/message-streams.js';
import { createUserMessageSignal } from '../../src/types/signal.js';
import { createTestLogger } from '../helpers/test-logger.js';

const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx');
const CHILD = join(process.cwd(), 'tests', 'fixtures', 'stream-core-child.ts');

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function waitFor(
  check: () => Promise<boolean>,
  what: string,
  timeoutMs = 20_000
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error(`Timed out waiting for ${what}`);
    await delay(20);
  }
}

function startCore(env: NodeJS.ProcessEnv): { child: ChildProcess; ready: Promise<void> } {
  const child = spawn(TSX, [CHILD], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // The core runs in a child of tsx: its own group lets the teardown kill both.
    detached: true,
  });
  // A wrapper that dies on its own leaves the core behind: reap the group.
  reapProcessGroupOnExit(child);
  let stdout = '';
  let stderr = '';
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Core did not start. stderr: ${stderr}`)),
      30_000
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes('CORE_READY')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (child.exitCode !== null) reject(new Error(`Core exited during startup: ${stderr}`));
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (!stdout.includes('CORE_READY'))
        reject(new Error(`Core exited (${code ?? signal}): ${stderr}`));
    });
  });
  return { child, ready };
}

async function hardStop(child: ChildProcess): Promise<void> {
  await stopProcessGroup(child);
}

function fieldsToRecord(fields: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (key !== undefined && value !== undefined) record[key] = value;
  }
  return record;
}

describe('real container inbound crash/restart boundary', { timeout: 120_000 }, () => {
  let stores: TestStores;
  let redis: Redis;
  let server: Server;
  let dataRoot: string;
  const blockedRequest = deferred();
  const releaseBlocked = deferred();
  let blockRequests = true;
  let llmRequestCount = 0;
  let baseUrl: string;
  let child: ChildProcess | undefined;

  beforeAll(async () => {
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
    const rawUrl = new URL(testStoreUrls().valkeyUrl);
    // container-inbound-restart.test.ts owns logical database 5; fatal-stop-process.test.ts owns 6.
    rawUrl.pathname = '/5'; // private logical DB for the real container's unprefixed keys
    redis = new Redis(rawUrl.toString());
    await redis.flushdb();
    dataRoot = await mkdtemp(join(tmpdir(), 'lifemodel-avy-4-4-'));

    server = createServer(async (request, response) => {
      for await (const _chunk of request) {
        /* consume the request body */
      }
      llmRequestCount += 1;
      blockedRequest.resolve();
      if (blockRequests) await releaseBlocked.promise;
      if (response.destroyed) return;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: `stub-${llmRequestCount}`,
          object: 'chat.completion',
          created: 1,
          model: 'stub',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Acknowledged.' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('LLM stub did not bind a TCP port');
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  });

  afterAll(async () => {
    if (child) await hardStop(child);
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (redis) await redis.quit();
    await stores?.redis.quit();
    await stores?.postgres.end();
    if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
  });

  it('replays three uncommitted messages after a hard kill and never replays a committed answer', async () => {
    const runId = randomUUID();
    const registry = createPersistentRecipientRegistry(stores.postgres, createTestLogger());
    await registry.init();
    const messageIds = [0, 1, 2].map((index) => `crash-${runId}-${index}`);
    const recipients = messageIds.map((id) => registry.getOrCreate('gateway', `destination-${id}`));
    await registry.flush();

    const inbound = new InboundMessageStream(redis);
    for (let i = 0; i < messageIds.length; i += 1) {
      const messageId = messageIds[i]!;
      await inbound.append(
        createUserMessageSignal({
          text: `message ${i}`,
          recipientId: recipients[i]!,
          channel: 'gateway',
          updateId: messageId,
        })
      );
    }

    const env = {
      ...process.env,
      LIFEMODEL_VALKEY_URL: testStoreUrls().valkeyUrl,
      LIFEMODEL_DATABASE_URL: new URL(
        `/${`lifemodel_test_worker_${stores.workerId}`}`,
        testStoreUrls().databaseUrl
      ).toString(),
      MOTOR_CORTEX_ENABLED: 'false',
      TEST_LLM_BASE_URL: baseUrl,
      DATA_PATH: join(dataRoot, 'first'),
    };
    const isolatedUrl = new URL(env.LIFEMODEL_VALKEY_URL);
    isolatedUrl.pathname = '/5';
    env.LIFEMODEL_VALKEY_URL = isolatedUrl.toString();
    const first = startCore(env);
    child = first.child;
    await first.ready;
    await blockedRequest.promise;
    await hardStop(first.child); // SIGKILL: no shutdown sequence or tick drain
    child = undefined;

    blockRequests = false;
    releaseBlocked.resolve();
    const restarted = startCore({ ...env, DATA_PATH: join(dataRoot, 'restart') });
    child = restarted.child;
    await restarted.ready;
    const expectedEventIds = recipients.map((recipientId, index) => {
      const digest = createHash('sha256')
        .update(`${recipientId}|${messageIds[index]}|0`)
        .digest('hex');
      return `send:${digest}`;
    });
    const expectedRecipientIds = recipients;
    await waitFor(async () => {
      const rows = await stores.postgres.query(
        "SELECT payload->>'channelMessageId' AS event_id FROM core.conversation_messages WHERE kind = $1 AND payload->>'role' = 'assistant' AND recipient_id = ANY($2::text[])",
        ['message', expectedRecipientIds]
      );
      return rows.rowCount === 3;
    }, 'three Postgres assistant rows');
    const recoveredRows = await stores.postgres.query(
      "SELECT payload->>'channelMessageId' AS event_id, recipient_id FROM core.conversation_messages WHERE kind = $1 AND payload->>'role' = 'assistant' AND recipient_id = ANY($2::text[])",
      ['message', expectedRecipientIds]
    );
    expect(recoveredRows.rows.map((row) => row.event_id).sort()).toEqual(
      [...expectedEventIds].sort()
    );

    await hardStop(restarted.child);
    child = undefined;
    const committedId = `committed-${runId}`;
    const committedRecipient = registry.getOrCreate('gateway', `destination-${committedId}`);
    await registry.flush();
    await inbound.append(
      createUserMessageSignal({
        text: 'already committed',
        recipientId: committedRecipient,
        channel: 'gateway',
        updateId: committedId,
      })
    );
    const third = startCore({ ...env, DATA_PATH: join(dataRoot, 'after-commit') });
    child = third.child;
    await third.ready;
    await waitFor(async () => {
      const result = await stores.postgres.query<{ event_id: string }>(
        "SELECT payload->>'channelMessageId' AS event_id FROM core.conversation_messages WHERE recipient_id = $1 AND payload->>'role' = 'assistant'",
        [committedRecipient]
      );
      return result.rowCount === 1;
    }, 'second scenario assistant row');
    const committedRows = await stores.postgres.query<{ event_id: string }>(
      "SELECT payload->>'channelMessageId' AS event_id FROM core.conversation_messages WHERE recipient_id = $1 AND payload->>'role' = 'assistant'",
      [committedRecipient]
    );
    const committedEventId = committedRows.rows[0]?.event_id;
    if (!committedEventId) throw new Error('Committed assistant row has no event id');
    await hardStop(third.child);
    child = undefined;
    blockRequests = false;
    const fourth = startCore({ ...env, DATA_PATH: join(dataRoot, 'post-commit-restart') });
    child = fourth.child;
    await fourth.ready;
    await delay(500);
    await hardStop(fourth.child);
    child = undefined;
    const eventRows = await redis.xrange('outbound', '-', '+');
    const committedMatches = eventRows.filter(([, fields]) => {
      const event = JSON.parse(fieldsToRecord(fields)['event'] ?? 'null') as {
        eventId?: string;
      } | null;
      return event?.eventId === committedEventId;
    });
    expect(committedMatches).toHaveLength(0);
    const row = await stores.postgres.query(
      "SELECT message_id FROM core.conversation_messages WHERE payload->>'channelMessageId' = $1 AND payload->>'role' = 'assistant'",
      [committedEventId]
    );
    expect(row.rowCount).toBe(1);
  });
});
