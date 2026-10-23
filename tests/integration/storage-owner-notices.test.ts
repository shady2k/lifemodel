import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, request, type Server } from 'node:https';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRetentionHarness, DAY, TERMINAL } from '../helpers/storage-retention-harness.js';
import { createTestLogger } from '../helpers/test-logger.js';
import { PostgresConversationStore } from '../../src/storage/postgres-conversation-store.js';
import { createConversationManager } from '../../src/storage/conversation-manager.js';
import { createSnapshotStore, type SnapshotStore } from '../../src/storage/snapshot-store.js';
import { createStorageControlClient } from '../../src/core/storage-control-client.js';
import {
  createStorageRetentionReconciler,
  storageWarningEventId,
} from '../../src/core/storage-retention.js';

let h: Awaited<ReturnType<typeof createRetentionHarness>>;
let directory: string;
let tokenFile: string;
let caFile: string;
let proxy: Server;
let proxyOrigin: string;
let dropWarning = false;
let prefix: string;
let snapshot: SnapshotStore;
let epoch: number;
const clients: ReturnType<typeof createStorageControlClient>[] = [];
const reconcilers: ReturnType<typeof createStorageRetentionReconciler>[] = [];

beforeAll(async () => {
  h = await createRetentionHarness();
  directory = await mkdtemp(join(tmpdir(), 'storage-owner-notices-'));
  tokenFile = join(directory, 'token');
  caFile = join(directory, 'ca');
  await writeFile(tokenFile, 'core');
  await writeFile(caFile, h.identity.certificate.ca);
  // Fault only the reply after the actual module listener committed. Neither
  // the module nor the shipped core client/reconciler is replaced by a fake.
  proxy = createServer(
    { cert: h.identity.certificate.cert, key: h.identity.certificate.key },
    (req, res) => {
      req.on('error', () => undefined);
      res.on('error', () => undefined);
      const upstream = request(
        {
          hostname: 'localhost',
          port: h.child().ports.control,
          path: req.url,
          method: req.method,
          headers: req.headers,
          ca: h.identity.certificate.ca,
          agent: false,
        },
        (reply) => {
          reply.on('error', () => res.destroy());
          if (dropWarning && req.url === '/retention/warningCommitted') {
            reply.resume();
            reply.once('end', () => {
              dropWarning = false;
              res.destroy();
            });
          } else {
            res.writeHead(reply.statusCode!, reply.headers);
            reply.pipe(res);
          }
        }
      );
      upstream.on('error', () => res.destroy());
      req.pipe(upstream);
    }
  );
  proxy.on('connection', (socket) => socket.on('error', () => undefined));
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  if (!address || typeof address === 'string') throw Error('missing proxy address');
  proxyOrigin = `https://localhost:${address.port}`;
}, 30_000);
beforeEach(async () => {
  await h.reset();
  dropWarning = false;
  prefix = `storage-notice-${randomUUID()}:`;
  snapshot = createSnapshotStore(h.stores.redis, { keyPrefix: prefix });
  epoch = await snapshot.takeEpoch();
}, 20_000);
afterEach(async () => {
  for (const reconciler of reconcilers.splice(0)) reconciler.stop();
  for (const client of clients.splice(0)) client.close();
  await h.cleanup();
}, 20_000);
afterAll(async () => {
  proxy?.closeAllConnections();
  if (proxy) await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await h?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 20_000);

function conversationStore() {
  return new PostgresConversationStore(h.stores.postgres);
}
function conversations() {
  return createConversationManager(conversationStore(), createTestLogger());
}
function reconciler(origin = `https://localhost:${h.child().ports.control}`) {
  const client = createStorageControlClient({ origin, tokenFile, caFile, requestTimeoutMs: 3000 });
  clients.push(client);
  const result = createStorageRetentionReconciler({
    client,
    snapshotStore: snapshot,
    epoch,
    conversations: conversations(),
    conversationStore: conversationStore(),
    recipientId: prefix,
    route: { channel: 'web', destination: 'owner' },
    language: () => 'en',
    logger: createTestLogger(),
  });
  reconcilers.push(result);
  return result;
}
async function plan() {
  await h.artifact();
  await h.clock(TERMINAL + 90 * DAY);
  await h.tick();
  const pending = await h.pending();
  expect(pending.plans).toHaveLength(1);
  return pending.plans[0].id as string;
}
async function state(planId: string) {
  return (
    await h.stores.postgres.query(
      'SELECT state,message_id,warned_at,earliest_delete_at,warning_receipt FROM storage.deletion_plans WHERE id=$1',
      [planId]
    )
  ).rows[0];
}
async function persist(messageId: string) {
  await conversations().addMessage(
    prefix,
    { role: 'assistant', content: 'Old task output will be deleted no earlier than seven days.' },
    { channel: 'web', channelMessageId: messageId }
  );
}
async function confirm(planId: string, messageId: string) {
  return h.call('control', 'POST', '/retention/warningCommitted', { planId, messageId });
}

describe('persisted owner notice enforcement at the real core/module boundary', () => {
  it('refuses a missing persisted owner notice without starting the clock, then accepts a retry after persistence', async () => {
    const planId = await plan();
    const messageId = storageWarningEventId(planId);
    const missing = await confirm(planId, messageId);
    expect(missing.status).toBe(503);
    expect(missing.json.error.code).toBe('warning_receipt_pending');
    expect(await state(planId)).toMatchObject({
      state: 'pending',
      message_id: null,
      warned_at: null,
      earliest_delete_at: null,
      warning_receipt: null,
    });
    expect((await h.pending()).plans.map((entry) => entry.id)).toEqual([planId]);
    await persist(messageId);
    expect((await confirm(planId, messageId)).status).toBe(200);
    expect((await state(planId)).state).toBe('warned');
  }, 30_000);

  it('refuses a persisted notice belonging to another plan', async () => {
    const planId = await plan();
    const messageId = storageWarningEventId('another-plan');
    await persist(messageId);
    const reply = await confirm(planId, messageId);
    expect(reply.status).toBe(503);
    expect(reply.json.error.code).toBe('warning_receipt_pending');
    expect((await state(planId)).state).toBe('pending');
  }, 30_000);

  it('the shipped reconciler persists the real core notice before the real module starts its warning clock', async () => {
    const planId = await plan();
    expect(await reconciler().runOnce()).toBe(true);
    const stored = await state(planId);
    expect(stored.state).toBe('warned');
    expect(stored.message_id).toBe(storageWarningEventId(planId));
    expect(stored.warned_at.getTime()).toBe(TERMINAL + 90 * DAY);
    expect(stored.earliest_delete_at.getTime()).toBe(TERMINAL + 97 * DAY);
    const notices = await h.stores.postgres.query(
      'SELECT message_id,committed_at FROM core.storage_owner_notices WHERE message_id=$1',
      [stored.message_id]
    );
    expect(notices.rows).toHaveLength(1);
    expect(notices.rows[0].committed_at).toBeInstanceOf(Date);
    expect(await h.stores.redis.xlen(`${prefix}outbound`)).toBe(1);
  }, 30_000);

  it('a lost real module response retries its exact receipt after core restart without a second notice or a later clock', async () => {
    const planId = await plan();
    dropWarning = true;
    const first = reconciler(proxyOrigin);
    expect(await first.runOnce()).toBe(false);
    first.stop();
    const original = await state(planId);
    expect(original.state).toBe('warned');
    await h.clock(TERMINAL + 91 * DAY);
    snapshot = createSnapshotStore(h.stores.redis, { keyPrefix: prefix });
    epoch = await snapshot.takeEpoch();
    expect(await reconciler().runOnce()).toBe(true);
    expect(await state(planId)).toEqual(original);
    expect((await confirm(planId, original.message_id)).json).toEqual(original.warning_receipt);
    expect(await h.stores.redis.xlen(`${prefix}outbound`)).toBe(1);
    expect(
      await h.stores.redis.keys(
        `${h.stores.redis.options.keyPrefix ?? ''}${prefix}current:notice:*`
      )
    ).toHaveLength(0);
    expect(
      (
        await h.stores.postgres.query(
          "SELECT count(*)::int AS count FROM core.conversation_messages WHERE recipient_id=$1 AND kind='message'",
          [prefix]
        )
      ).rows[0].count
    ).toBe(1);
  }, 30_000);

  it('the narrow read view exposes only permanent assistant web storage warnings, not message contents', async () => {
    const good = storageWarningEventId(randomUUID());
    await persist(good);
    const store = conversationStore();
    const rejected = [
      {
        role: 'user',
        channel: 'web',
        channelMessageId: storageWarningEventId(randomUUID()),
        content: 'user',
      },
      {
        role: 'assistant',
        channel: 'telegram',
        channelMessageId: storageWarningEventId(randomUUID()),
        content: 'wrong channel',
      },
      {
        role: 'assistant',
        channel: 'web',
        channelMessageId: 'ordinary-message',
        content: 'ordinary',
      },
      {
        role: 'assistant',
        channel: 'web',
        channelMessageId: storageWarningEventId(randomUUID()),
        content: '',
      },
      {
        role: 'assistant',
        channel: 'web',
        channelMessageId: storageWarningEventId(randomUUID()),
        content: 'wrong key',
        messageId: 'not-a-channel-key',
      },
    ];
    await store.save(`conversation:${prefix}`, { messages: rejected });
    await store.save(`conversation:${prefix}`, {
      messages: [],
      compactionMarker: {
        summary: 'Compacted owner history',
        retainedMessageIds: [],
        timestamp: new Date().toISOString(),
      },
    });
    expect(await store.load(`conversation:${prefix}`)).toMatchObject({ messages: [] });
    expect(
      (
        await h.stores.postgres.query(
          'SELECT message_id FROM core.storage_owner_notices WHERE message_id=$1',
          [good]
        )
      ).rows
    ).toEqual([{ message_id: good }]);
    await store.delete(`conversation:${prefix}`);
    expect(await store.load(`conversation:${prefix}`)).toBeNull();
    const rows = (
      await h.stores.postgres.query(
        'SELECT * FROM core.storage_owner_notices WHERE message_id=ANY($1::text[])',
        [[good, ...rejected.map((entry) => entry.channelMessageId)]]
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(['committed_at', 'message_id']);
    expect(rows[0].message_id).toBe(good);
  });
});
