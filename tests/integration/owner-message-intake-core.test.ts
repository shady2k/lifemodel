import { randomBytes } from 'node:crypto';
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
import { killProcessGroup } from '../helpers/child-process-group.js';
import { OwnerMessageIntake } from '../../src/storage/owner-message-intake.js';
import { PostgresTranscriptStore } from '../../src/storage/postgres-transcript-store.js';

const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx');
const CHILD = join(process.cwd(), 'tests', 'fixtures', 'stream-core-child.ts');
let coreOutput = '';
let llmRequests: string[] = [];

function uuidV7(at: number): string {
  const bytes = randomBytes(16);
  let time = BigInt(at);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(time & 0xffn);
    time >>= 8n;
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function waitFor(
  check: () => Promise<boolean>,
  what: string,
  diagnostic: () => Promise<string>
): Promise<void> {
  const end = Date.now() + 30_000;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error(`Timed out waiting for ${what}: ${await diagnostic()}`);
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
  let output = '';
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Core did not start: ${output}`)), 30_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      coreOutput += chunk.toString();
      if (output.includes('CORE_READY')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      coreOutput += chunk.toString();
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (!output.includes('CORE_READY')) reject(new Error(`Core exited (${code}): ${output}`));
    });
  });
  return { child, ready };
}

async function stopCore(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  killProcessGroup(child);
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

describe('owner intake is processed once by the real core', { timeout: 120_000 }, () => {
  let stores: TestStores;
  let redis: Redis;
  let server: Server;
  let core: ChildProcess | undefined;
  let dataRoot: string;
  let baseUrl: string;
  let completions = 0;

  beforeAll(async () => {
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
    const url = new URL(testStoreUrls().valkeyUrl);
    url.pathname = '/8';
    redis = new Redis(url.toString());
    await redis.flushdb();
    dataRoot = await mkdtemp(join(tmpdir(), 'lifemodel-owner-intake-core-'));
    server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk.toString();
      llmRequests.push(body);
      completions += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: `stub-${completions}`,
          object: 'chat.completion',
          created: 1,
          model: 'stub',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Received once.' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('LLM stub did not bind');
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  });

  afterAll(async () => {
    if (core) await stopCore(core);
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await redis?.quit();
    await stores?.redis.quit();
    await stores?.postgres.end();
    if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
  });

  it('absorbs a receipt-write retry and answers both accepted messages once', async () => {
    const recipientId = 'rcpt_5dca93478eabd318';
    const transcript = new PostgresTranscriptStore(stores.postgres, stores.redis, recipientId);
    const intake = new OwnerMessageIntake(redis, recipientId, { transcript });
    const retriedId = uuidV7(Date.now());
    const failureConnection = redis.duplicate();
    const failing = new OwnerMessageIntake(failureConnection, recipientId, {
      scriptOverride: `redis.call('XADD', KEYS[1], '*', 'type', 'inbound.message', 'messageId', ARGV[1], 'recipientId', ARGV[2], 'text', ARGV[3], 'timestamp', ARGV[4], 'signal', ARGV[6]); return redis.error_reply('receipt write failed')`,
    });
    await expect(failing.acceptOwnerMessage(retriedId, 'retry accepted')).rejects.toThrow(
      /receipt/i
    );
    await failureConnection.quit();
    expect((await intake.acceptOwnerMessage(retriedId, 'retry accepted')).status).toBe('accepted');

    const env = {
      ...process.env,
      LIFEMODEL_VALKEY_URL: new URL('/8', testStoreUrls().valkeyUrl).toString(),
      LIFEMODEL_DATABASE_URL: new URL(
        `/${`lifemodel_test_worker_${stores.workerId}`}`,
        testStoreUrls().databaseUrl
      ).toString(),
      MOTOR_CORTEX_ENABLED: 'false',
      TEST_LLM_BASE_URL: baseUrl,
      DATA_PATH: join(dataRoot, 'core'),
    };
    const started = startCore(env);
    core = started.child;
    await started.ready;

    await waitFor(
      async () => {
        const result = await stores.postgres.query(
          "SELECT count(*)::int AS count FROM core.conversation_messages WHERE recipient_id = $1 AND kind = 'message' AND (message_id = $2 OR payload->>'role' = 'assistant')",
          [recipientId, `inbound:${retriedId}`]
        );
        return result.rows[0]?.count === 2;
      },
      'one owner row and its assistant answer',
      async () =>
        JSON.stringify({
          rows: (
            await stores.postgres.query(
              'SELECT recipient_id, message_id, kind, payload FROM core.conversation_messages ORDER BY sequence DESC LIMIT 10'
            )
          ).rows,
          coreOutput,
        })
    );

    const ownerRow = await stores.postgres.query(
      'SELECT sequence::text FROM core.conversation_messages WHERE recipient_id = $1 AND message_id = $2',
      [recipientId, `inbound:${retriedId}`]
    );
    const replySequence = ownerRow.rows[0]!.sequence as string;
    const freshId = uuidV7(Date.now());
    expect((await intake.acceptOwnerMessage(freshId, 'fresh accepted', replySequence)).status).toBe(
      'accepted'
    );
    await waitFor(
      async () => {
        const rows = await stores.postgres.query(
          "SELECT message_id, payload->>'role' AS role FROM core.conversation_messages WHERE recipient_id = $1 AND kind = 'message' AND (message_id = $2 OR (payload->>'role' = 'assistant' AND payload->>'content' = 'Received once.'))",
          [recipientId, `inbound:${freshId}`]
        );
        return rows.rowCount >= 3;
      },
      'fresh owner row and second assistant answer',
      async () =>
        JSON.stringify({
          rows: (
            await stores.postgres.query(
              'SELECT recipient_id, message_id, kind, payload FROM core.conversation_messages ORDER BY sequence DESC LIMIT 10'
            )
          ).rows,
          stream: await redis.xrange('inbound', '-', '+'),
          completions,
          coreOutput,
        })
    );

    const rows = await stores.postgres.query(
      "SELECT message_id, payload->>'role' AS role, payload->>'content' AS content FROM core.conversation_messages WHERE recipient_id = $1 AND kind = 'message' ORDER BY sequence",
      [recipientId]
    );
    expect(rows.rows.filter((row) => row.message_id === `inbound:${retriedId}`)).toHaveLength(1);
    expect(rows.rows.filter((row) => row.message_id === `inbound:${freshId}`)).toHaveLength(1);
    expect(rows.rows.filter((row) => row.role === 'assistant')).toHaveLength(2);
    const replyRow = await stores.postgres.query(
      "SELECT sequence::text, payload->'replyTo' AS reply_to FROM core.conversation_messages WHERE recipient_id = $1 AND message_id = $2",
      [recipientId, `inbound:${freshId}`]
    );
    expect(replyRow.rows[0]).toMatchObject({
      reply_to: { sequence: replySequence, role: 'user', excerpt: 'retry accepted' },
    });
    const replyDto = (await transcript.readTranscript({ limit: 50 })).rows.find(
      (row) => row.clientId === freshId
    );
    expect(replyDto).toMatchObject({
      replyTo: { sequence: replySequence, role: 'user', excerpt: 'retry accepted' },
      text: 'fresh accepted',
    });
    expect(
      llmRequests.some(
        (request) => request.includes('quoted_message') && request.includes('retry accepted')
      )
    ).toBe(true);
    expect(completions).toBe(2);
  });
});
