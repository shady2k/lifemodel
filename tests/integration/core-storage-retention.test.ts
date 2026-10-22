import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:https';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import {
  createStorageCertificate,
  type TestStorageCertificate,
} from '../helpers/storage-certificate.js';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createTestLogger, recordingLogger, type RecordedLog } from '../helpers/test-logger.js';
import { createSnapshotStore, type SnapshotStore } from '../../src/storage/snapshot-store.js';
import { createConversationManager } from '../../src/storage/conversation-manager.js';
import { PostgresConversationStore } from '../../src/storage/postgres-conversation-store.js';
import { trimOutboundEvents } from '../../src/core/message-streams.js';
import { createStorageControlClient } from '../../src/core/storage-control-client.js';
import {
  createStorageRetentionReconciler,
  storageWarningEventId,
} from '../../src/core/storage-retention.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const plan = (id: string) => ({
  id,
  sequence: '1',
  reason: 'age',
  state: 'pending',
  leadDays: 7,
  settingsRevision: '1',
  totalBytes: 1_500_000_000,
});

describe('core storage retention notices', () => {
  let stores: TestStores;
  let cert: TestStorageCertificate;
  let server: Server;
  let root: string;
  let origin: string;
  let prefix: string;
  let snapshot: SnapshotStore;
  let epoch: number;
  let tokenFile: string;
  let caFile: string;
  let expectedToken: string;
  let plans: ReturnType<typeof plan>[];
  let pages:
    | Record<string, { plans: ReturnType<typeof plan>[]; nextCursor: string | null }>
    | undefined;
  let connections = 0;
  let heldListReply: (() => void) | undefined;
  let status: number;
  let mode: 'normal' | 'hold-list' | 'drop-list' | 'hold-warning' | 'drop-warning';
  let warningStatus: number;
  let warningSeen: ReturnType<typeof deferred>;
  let listSeen: ReturnType<typeof deferred>;
  let confirmations: { planId: string; messageId: string }[];
  let failures: unknown[];
  let logs: RecordedLog[];
  const sockets = new Set<Socket>();
  const components: ReturnType<typeof createStorageRetentionReconciler>[] = [];
  const clients: ReturnType<typeof createStorageControlClient>[] = [];
  const logger = () => recordingLogger(createTestLogger(), logs);
  const conversationStore = () => new PostgresConversationStore(stores.postgres);
  const manager = () =>
    createConversationManager(new PostgresConversationStore(stores.postgres), createTestLogger());
  function client(timeout = 300) {
    const result = createStorageControlClient({
      origin,
      tokenFile,
      caFile,
      requestTimeoutMs: timeout,
    });
    clients.push(result);
    return result;
  }
  function component(
    options: {
      intervalMs?: number;
      retryMs?: number;
      language?: () => string | null;
      conversationStore?: PostgresConversationStore;
      conversations?: ReturnType<typeof manager>;
    } = {}
  ) {
    const result = createStorageRetentionReconciler({
      client: client(),
      snapshotStore: snapshot,
      epoch,
      conversations: manager(),
      conversationStore: conversationStore(),
      recipientId: prefix,
      route: { channel: 'web', destination: 'owner' },
      language: () => 'English',
      logger: logger(),
      ...options,
    });
    components.push(result);
    return result;
  }
  async function events() {
    return (await stores.redis.xrange(`${prefix}outbound`, '-', '+')).map(([, fields]) =>
      JSON.parse(fields[fields.indexOf('event') + 1]!)
    );
  }
  async function rows() {
    return (
      await stores.postgres.query(
        "SELECT payload FROM core.conversation_messages WHERE recipient_id=$1 AND kind='message'",
        [prefix]
      )
    ).rows;
  }
  beforeAll(async () => {
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
    cert = await createStorageCertificate(['localhost']);
    root = await mkdtemp(join(tmpdir(), 'core-retention-'));
    tokenFile = join(root, 'token');
    caFile = join(root, 'ca');
    await writeFile(caFile, cert.ca);
    server = createServer({ cert: cert.cert, key: cert.key }, (req, res) => {
      req.on('error', () => undefined);
      res.on('error', () => undefined);
      void (async () => {
        expect(req.headers.authorization).toBe(`Bearer ${expectedToken}`);
        if (req.method === 'GET') {
          expect(req.url?.startsWith('/retention/plans?limit=100')).toBe(true);
          listSeen.resolve();
          if (mode === 'drop-list') {
            req.socket.destroy();
            return;
          }
          if (mode === 'hold-list') {
            heldListReply = () => {
              res.writeHead(200);
              res.end(JSON.stringify({ plans: [plan('late-plan')], nextCursor: null }));
            };
            return;
          }
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(
            status === 200
              ? JSON.stringify(
                  pages?.[new URL(req.url!, origin).searchParams.get('cursor') ?? 'first'] ?? {
                    plans,
                    nextCursor: null,
                  }
                )
              : 'secret body'
          );
          return;
        }
        expect(req.method).toBe('POST');
        expect(req.url).toBe('/retention/warningCommitted');
        let body = '';
        for await (const chunk of req) body += chunk;
        const value = JSON.parse(body);
        expect(Object.keys(value).sort()).toEqual(['messageId', 'planId']);
        const persisted = await rows();
        // Receipt-time oracle: a separately written Postgres row cannot prove
        // outbound admission. Require the actual hot receipt and full payload.
        const rawReceipt = await stores.redis.get(`${prefix}current:notice:${value.messageId}`);
        expect(rawReceipt).not.toBeNull();
        const receipt = JSON.parse(rawReceipt!);
        const row = persisted.find((entry) => entry.payload.channelMessageId === value.messageId);
        expect(row).toBeDefined();
        expect(receipt).toEqual({
          eventId: value.messageId,
          type: 'send.command',
          payload: {
            recipientId: prefix,
            channel: 'web',
            destination: 'owner',
            text: row!.payload.content,
            storageDeletionPlanId: value.planId,
          },
        });
        const committed = await events();
        const streamEvent = committed.find((event) => event.eventId === value.messageId);
        if (streamEvent) expect(streamEvent).toEqual(receipt);
        expect(value.messageId).toBe(storageWarningEventId(value.planId));
        confirmations.push(value);
        warningSeen.resolve();
        if (mode === 'hold-warning') return;
        if (mode === 'drop-warning') {
          req.socket.destroy();
          return;
        }
        res.writeHead(warningStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'receipt', ...value, earliestDeleteAt: '2030-01-01' }));
      })().catch((error) => {
        failures.push(error);
        warningSeen.resolve();
        res.destroy();
      });
    });
    server.on('connection', (socket) => {
      connections++;
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('tlsClientError', () => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    origin = `https://localhost:${address.port}`;
  });
  beforeEach(async () => {
    for (const item of components.splice(0)) item.stop();
    for (const item of clients.splice(0)) item.close();
    prefix = `retention-${crypto.randomUUID()}:`;
    snapshot = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    epoch = await snapshot.takeEpoch();
    expectedToken = 'rotating-token-1';
    await writeFile(tokenFile, expectedToken);
    plans = [plan('plan-1')];
    status = 200;
    warningStatus = 200;
    mode = 'normal';
    pages = undefined;
    heldListReply = undefined;
    confirmations = [];
    failures = [];
    logs = [];
    warningSeen = deferred();
    listSeen = deferred();
  });
  afterAll(async () => {
    for (const item of components) item.stop();
    for (const item of clients) item.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cert.cleanup();
    await rm(root, { recursive: true, force: true });
    await stores.redis.quit();
    await stores.postgres.end();
  });

  async function hotReceipts() {
    return stores.redis.keys(`${stores.redis.options.keyPrefix ?? ''}${prefix}current:notice:*`);
  }
  it('confirmed plan churn removes hot receipts and restore replay uses permanent Postgres rows without appending', async () => {
    plans = Array.from({ length: 80 }, (_, i) => plan(`churn-${i}`));
    expect(await component().runOnce()).toBe(true);
    expect(await hotReceipts()).toHaveLength(0);
    expect(await events()).toHaveLength(80);
    expect(await rows()).toHaveLength(80);
    const originalIds = confirmations.map((entry) => entry.messageId);
    await stores.redis.del(`${prefix}outbound`, `${prefix}outbound:event-keys`);
    snapshot = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    epoch = await snapshot.takeEpoch();
    plans = plans.map((entry) => ({ ...entry, totalBytes: 1, leadDays: 30 }));
    expect(await component({ language: () => 'ru' }).runOnce()).toBe(true);
    expect(await events()).toHaveLength(0);
    expect(await rows()).toHaveLength(80);
    expect(await hotReceipts()).toHaveLength(0);
    expect(
      confirmations
        .slice(80)
        .map((entry) => entry.messageId)
        .sort()
    ).toEqual(originalIds.sort());
    expect(failures).toEqual([]);
  });
  it('a 201 accepted warning retires hot state and a cleared conversation still prevents a new append', async () => {
    warningStatus = 201;
    expect(await component().runOnce()).toBe(true);
    expect(await hotReceipts()).toHaveLength(0);
    await conversationStore().delete(`conversation:${prefix}`);
    expect(await conversationStore().load(`conversation:${prefix}`)).toBeNull();
    await stores.redis.del(`${prefix}outbound`, `${prefix}outbound:event-keys`);
    epoch = await snapshot.takeEpoch();
    warningStatus = 200;
    expect(await component().runOnce()).toBe(true);
    expect(await events()).toHaveLength(0);
    expect(await rows()).toHaveLength(1);
    expect(await hotReceipts()).toHaveLength(0);
    expect(failures).toEqual([]);
  });
  it('a Postgres read failure refuses new append and later recovers', async () => {
    const store = conversationStore();
    const read = vi
      .spyOn(store, 'findChannelMessage')
      .mockRejectedValueOnce(new Error('private database failure'));
    const reconciler = component({ conversationStore: store });
    expect(await reconciler.runOnce()).toBe(false);
    expect(await events()).toHaveLength(0);
    expect(await hotReceipts()).toHaveLength(0);
    expect(confirmations).toHaveLength(0);
    expect(await reconciler.runOnce()).toBe(true);
    expect(read).toHaveBeenCalled();
    expect(await hotReceipts()).toHaveLength(0);
    expect(failures).toEqual([]);
  });
  it.each(['append-reply', 'projection-reply', 'confirmation-reply', 'cleanup-reply'] as const)(
    'restart after lost %s never creates a second notice',
    async (boundary) => {
      const first = component();
      const commit = snapshot.commitNotice.bind(snapshot);
      const release = snapshot.releaseNotice.bind(snapshot);
      const spies: { mockRestore(): void }[] = [];
      if (boundary === 'append-reply')
        spies.push(
          vi.spyOn(snapshot, 'commitNotice').mockImplementation(async (...args) => {
            await commit(...args);
            first.stop();
            throw new Error('lost append reply');
          })
        );
      if (boundary === 'projection-reply') {
        // A separate owner-row write can commit and lose its reply.
        const store = conversationStore();
        const save = store.save.bind(store);
        const managerWithLostReply = createConversationManager(store, createTestLogger());
        first.stop();
        const replacement = component({ conversations: managerWithLostReply });
        spies.push(
          vi.spyOn(store, 'save').mockImplementation(async (...args) => {
            await save(...args);
            replacement.stop();
            throw new Error('lost projection reply');
          })
        );
        expect(await replacement.runOnce()).toBe(false);
      } else if (boundary === 'confirmation-reply') {
        mode = 'hold-warning';
        const pass = first.runOnce();
        await warningSeen.promise;
        first.stop();
        await pass;
      } else {
        if (boundary === 'cleanup-reply')
          spies.push(
            vi.spyOn(snapshot, 'releaseNotice').mockImplementation(async (...args) => {
              await release(...args);
              first.stop();
              throw new Error('lost cleanup reply');
            })
          );
        expect(await first.runOnce()).toBe(false);
      }
      for (const spy of spies) spy.mockRestore();
      const original = (await events())[0];
      expect(original).toBeDefined();
      await stores.redis.del(`${prefix}outbound`, `${prefix}outbound:event-keys`);
      snapshot = createSnapshotStore(stores.redis, { keyPrefix: prefix });
      epoch = await snapshot.takeEpoch();
      mode = 'normal';
      const second = component();
      expect(await second.runOnce()).toBe(true);
      expect(await events()).toHaveLength(0);
      expect(await rows()).toHaveLength(1);
      expect(await hotReceipts()).toHaveLength(0);
      expect(confirmations.every((entry) => entry.messageId === original.eventId)).toBe(true);
      expect(failures).toEqual([]);
    }
  );
  it('a lost confirmation followed by a plan disappearing still retires its hot receipt', async () => {
    const first = component();
    mode = 'drop-warning';
    expect(await first.runOnce()).toBe(false);
    first.stop();
    expect(await hotReceipts()).toHaveLength(1);
    plans = [];
    mode = 'normal';
    snapshot = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    epoch = await snapshot.takeEpoch();
    expect(await component().runOnce()).toBe(true);
    expect(await hotReceipts()).toHaveLength(0);
    expect(await events()).toHaveLength(1);
    expect(confirmations).toHaveLength(2);
    expect(confirmations[1]).toEqual(confirmations[0]);
    expect(failures).toEqual([]);
  });
  it.each([200, 409])(
    'cleanup after module %s requires a fresh confirmed Postgres row',
    async (responseStatus) => {
      warningStatus = responseStatus;
      const store = conversationStore();
      const find = store.findChannelMessage.bind(store);
      let reads = 0;
      const spy = vi.spyOn(store, 'findChannelMessage').mockImplementation(async (...args) => {
        reads++;
        if (reads === 2) throw new Error('read failed after confirmation');
        return find(...args);
      });
      const reconciler = component({ conversationStore: store });
      expect(await reconciler.runOnce()).toBe(false);
      expect(await hotReceipts()).toHaveLength(1);
      spy.mockRestore();
      warningStatus = 200;
      expect(await reconciler.runOnce()).toBe(true);
      expect(await hotReceipts()).toHaveLength(0);
      expect(await events()).toHaveLength(1);
      expect(failures).toEqual([]);
    }
  );

  it('commits one owner notice per returned plan before confirming, without an LLM or registered channel', async () => {
    plans.push(plan('plan-2'));
    const reconciler = component();
    expect(await reconciler.runOnce()).toBe(true);
    expect(await reconciler.runOnce()).toBe(true);
    expect(failures).toEqual([]);
    const notices = await events();
    expect(notices).toHaveLength(2);
    expect(await rows()).toHaveLength(2);
    expect(notices[0].payload).toMatchObject({
      recipientId: prefix,
      channel: 'web',
      destination: 'owner',
    });
    expect(notices[0].payload.text).toMatch(
      /1.5 GB.*old task output.*7 days.*Nothing.*deleted before/s
    );
    expect(confirmations.map((x) => x.messageId)).toEqual([
      storageWarningEventId('plan-1'),
      storageWarningEventId('plan-2'),
      storageWarningEventId('plan-1'),
      storageWarningEventId('plan-2'),
    ]);
  });
  it('restarts after commit with a lost warning response and even after stream/key trimming, reusing the message ID', async () => {
    const first = component();
    mode = 'hold-warning';
    const pass = first.runOnce();
    await warningSeen.promise;
    expect(failures).toEqual([]);
    first.stop();
    await pass;
    const notices = await events();
    expect(notices).toHaveLength(1);
    const entries = await stores.redis.xrange(`${prefix}outbound`, '-', '+');
    await stores.redis.set(`${prefix}pg-applied`, entries[0]![0]);
    await trimOutboundEvents(stores.redis, {
      streamKey: `${prefix}outbound`,
      eventKeysKey: `${prefix}outbound:event-keys`,
      postgresOffsetKey: `${prefix}pg-applied`,
    });
    expect(await events()).toHaveLength(0);
    expect(await stores.redis.hlen(`${prefix}outbound:event-keys`)).toBe(0);
    snapshot = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    epoch = await snapshot.takeEpoch();
    mode = 'normal';
    const second = component();
    expect(await second.runOnce()).toBe(true);
    expect(failures).toEqual([]);
    expect(await events()).toHaveLength(0);
    expect(await rows()).toHaveLength(1);
    expect(confirmations).toHaveLength(2);
    expect(confirmations[1]).toEqual(confirmations[0]);
  });
  it('recovers the original payload after stopping immediately after append, before any Postgres projection, and forced trimming', async () => {
    const first = component();
    const realCommit = snapshot.commitNotice.bind(snapshot);
    const commit = vi.spyOn(snapshot, 'commitNotice').mockImplementation(async (...args) => {
      const event = await realCommit(...args);
      first.stop();
      return event;
    });
    expect(await first.runOnce()).toBe(false);
    commit.mockRestore();
    expect(await rows()).toHaveLength(0);
    expect(confirmations).toHaveLength(0);
    const original = (await events())[0];
    await stores.redis.xadd(`${prefix}outbound`, '*', 'eventId', 'sentinel');
    await trimOutboundEvents(stores.redis, {
      streamKey: `${prefix}outbound`,
      eventKeysKey: `${prefix}outbound:event-keys`,
      postgresOffsetKey: `${prefix}pg-applied`,
      maxLength: 1,
    });
    await stores.redis.xtrim(`${prefix}outbound`, 'MAXLEN', 0);
    expect(await events()).toHaveLength(0);
    expect(await stores.redis.hexists(`${prefix}outbound:event-keys`, original.eventId)).toBe(0);
    snapshot = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    epoch = await snapshot.takeEpoch();
    plans = [{ ...plan('plan-1'), totalBytes: 1, leadDays: 30 }];
    expect(await component({ language: () => 'ru' }).runOnce()).toBe(true);
    expect(await events()).toHaveLength(0);
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0].payload.content).toBe(original.payload.text);
    expect(confirmations).toEqual([{ planId: 'plan-1', messageId: original.eventId }]);
    expect(failures).toEqual([]);
    expect(await hotReceipts()).toHaveLength(0);
  });
  it.each([401, 503])('list refusal %s emits nothing and later retries', async (code) => {
    const reconciler = component();
    status = code;
    expect(await reconciler.runOnce()).toBe(false);
    expect(await events()).toHaveLength(0);
    expect(confirmations).toHaveLength(0);
    expect(logs.at(-1)?.obj).toMatchObject({ status: code });
    status = 200;
    expect(await reconciler.runOnce()).toBe(true);
    expect(confirmations).toHaveLength(1);
    expect(failures).toEqual([]);
  });
  it.each(['drop-list', 'hold-list'] as const)(
    'transport failure %s is bounded and retryable',
    async (failureMode) => {
      const reconciler = component();
      mode = failureMode;
      expect(await reconciler.runOnce()).toBe(false);
      expect(await events()).toHaveLength(0);
      expect(confirmations).toHaveLength(0);
      mode = 'normal';
      expect(await reconciler.runOnce()).toBe(true);
      expect(failures).toEqual([]);
    }
  );
  it('advances bounded pages and returns to the first page without skipping retries', async () => {
    pages = {
      first: { plans: [plan('p1')], nextCursor: 'Mg' },
      Mg: { plans: [plan('p2')], nextCursor: null },
    };
    const reconciler = component();
    expect(await reconciler.runOnce()).toBe(true);
    expect(await events()).toHaveLength(1);
    warningStatus = 503;
    expect(await reconciler.runOnce()).toBe(false);
    warningStatus = 200;
    expect(await reconciler.runOnce()).toBe(true);
    expect(await reconciler.runOnce()).toBe(true);
    expect(confirmations.map((x) => x.planId)).toEqual(['p1', 'p2', 'p2', 'p1']);
    expect(await events()).toHaveLength(2);
    expect(failures).toEqual([]);
  });
  it('a late timed-out list cannot replace a newer pass or emit a notice', async () => {
    const reconciler = component();
    mode = 'hold-list';
    expect(await reconciler.runOnce()).toBe(false);
    mode = 'normal';
    plans = [plan('new-plan')];
    expect(await reconciler.runOnce()).toBe(true);
    heldListReply!();
    expect(confirmations.map((x) => x.planId)).toEqual(['new-plan']);
    expect((await events()).map((x) => x.eventId)).toEqual([storageWarningEventId('new-plan')]);
    expect(failures).toEqual([]);
  });
  it('connection refused is local, safe, and retryable', async () => {
    const transport = client();
    const oldOrigin = origin;
    origin = 'https://localhost:1';
    const refused = client();
    origin = oldOrigin;
    await expect(refused.plans()).rejects.toMatchObject({
      route: '/retention/plans',
      status: undefined,
    });
    await expect(transport.plans()).resolves.toMatchObject({ plans });
    expect(failures).toEqual([]);
  });
  it.each([401, 503, 409])(
    'warning refusal %s never creates a fresh notice or ID on retry',
    async (code) => {
      const reconciler = component();
      warningStatus = code;
      expect(await reconciler.runOnce()).toBe(code === 409);
      expect(await events()).toHaveLength(1);
      warningStatus = 200;
      expect(await reconciler.runOnce()).toBe(true);
      expect(confirmations).toHaveLength(2);
      expect(confirmations[1]).toEqual(confirmations[0]);
      expect(await events()).toHaveLength(1);
      expect(failures).toEqual([]);
      expect(
        logs.some(
          (entry) => entry.obj.status === code && JSON.stringify(entry.obj).includes('plan-1')
        )
      ).toBe(true);
    }
  );
  it('a dropped warning reply retries the same committed ID', async () => {
    const reconciler = component();
    mode = 'drop-warning';
    expect(await reconciler.runOnce()).toBe(false);
    mode = 'normal';
    expect(await reconciler.runOnce()).toBe(true);
    expect(confirmations).toHaveLength(2);
    expect(confirmations[1]).toEqual(confirmations[0]);
    expect(await events()).toHaveLength(1);
    expect(failures).toEqual([]);
  });
  it('a failed outbound append never confirms and can recover', async () => {
    await stores.redis.set(`${prefix}outbound`, 'wrong-type');
    const reconciler = component();
    expect(await reconciler.runOnce()).toBe(false);
    expect(confirmations).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
    await stores.redis.del(`${prefix}outbound`);
    expect(await reconciler.runOnce()).toBe(true);
    expect(failures).toEqual([]);
  });
  it.each([
    ['ru', 'старых результатов задач'],
    ['de-DE', 'alter Aufgabenergebnisse'],
    ['fr', 'anciens résultats'],
    ['es', 'resultados antiguos'],
    ['zh', '旧任务输出'],
    ['ja', '古いタスク出力'],
  ])('uses the owner language %s without an LLM', async (language, expected) => {
    expect(await component({ language: () => language }).runOnce()).toBe(true);
    expect((await events())[0].payload.text).toContain(expected);
    expect(failures).toEqual([]);
  });
  it('an unsupported language leaves the plan pending rather than authorizing an unreadable warning', async () => {
    expect(await component({ language: () => 'unknown' }).runOnce()).toBe(false);
    expect(await events()).toHaveLength(0);
    expect(confirmations).toHaveLength(0);
    expect(await component({ language: () => null }).runOnce()).toBe(true);
  });
  it('reads the rotated bearer token afresh on each call over the reused agent', async () => {
    const transport = client();
    const before = connections;
    await transport.plans();
    await transport.plans();
    expect(connections - before).toBe(1);
    expectedToken = 'rotating-token-2';
    await writeFile(tokenFile, expectedToken);
    await transport.plans();
    const reconciler = component();
    expect(await reconciler.runOnce()).toBe(true);
    expect(failures).toEqual([]);
  });
  it('rejects an untrusted instance CA, a missing token and malformed list without notices', async () => {
    const other = await createStorageCertificate(['localhost']);
    await writeFile(caFile, other.ca);
    const reconciler = component();
    expect(await reconciler.runOnce()).toBe(false);
    expect(await events()).toHaveLength(0);
    expect(confirmations).toHaveLength(0);
    other.cleanup();
    await writeFile(caFile, cert.ca);
    const second = component();
    await rm(tokenFile);
    expect(await second.runOnce()).toBe(false);
    await writeFile(tokenFile, expectedToken);
    plans = [{ ...plan('bad'), totalBytes: -1 }];
    expect(await second.runOnce()).toBe(false);
    expect(await events()).toHaveLength(0);
    expect(confirmations).toHaveLength(0);
    expect(JSON.stringify(logs)).not.toMatch(/rotating-token|secret body|localhost|\/tmp\//);
  });
  it('a stale holder cannot append or confirm, and notice commits do not replace the tick snapshot', async () => {
    await snapshot.commitOwners(epoch, 42);
    const before = await snapshot.read();
    const reconciler = component();
    await snapshot.takeEpoch();
    expect(await reconciler.runOnce()).toBe(false);
    expect(await events()).toHaveLength(0);
    expect(confirmations).toHaveLength(0);
    epoch = await snapshot.takeEpoch();
    expect(await component().runOnce()).toBe(true);
    expect(await snapshot.read()).toEqual(before);
    expect(failures).toEqual([]);
  });
  it('starts immediately, retries outages with backoff, and stop aborts held requests without later confirmation', async () => {
    const reconciler = component({ intervalMs: 500, retryMs: 10 });
    mode = 'drop-list';
    reconciler.start();
    await listSeen.promise;
    mode = 'normal';
    await warningSeen.promise;
    reconciler.stop();
    expect(confirmations).toHaveLength(1);
    expect(failures).toEqual([]);
    mode = 'hold-list';
    listSeen = deferred();
    const held = component();
    held.start();
    await listSeen.promise;
    held.stop();
    expect(await held.runOnce()).toBe(false);
    expect(confirmations).toHaveLength(1);
  });
});
