import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { createSnapshotStore } from '../../src/storage/snapshot-store.js';

describe('tick snapshot store', () => {
  let stores: TestStores;
  beforeAll(async () => { stores = await createTestStores(); });
  afterAll(async () => { await stores.redis.quit(); await stores.postgres.end(); });

  it('takes a new epoch, commits only for that epoch, and refuses newer formats', async () => {
    const store = createSnapshotStore(stores.redis, { keyPrefix: `snapshot:${stores.workerId}:` });
    const epoch = await store.takeEpoch();
    const initial = await store.read();
    expect(initial).toBeNull();
    const envelope = { version: 1, epoch, tick: 1, sections: { state: { energy: 0.3 }, later: true } };
    expect(await store.commit(epoch, envelope)).toBe(true);
    const before = await stores.redis.get(`snapshot:${stores.workerId}:current`);
    expect(await store.read()).toEqual(envelope);
    const newer = { ...envelope, version: 2 };
    await stores.redis.set(`snapshot:${stores.workerId}:current`, JSON.stringify(newer));
    await expect(store.read()).rejects.toThrow(/version 2/);
    expect(await store.commit(epoch - 1, { ...envelope, epoch: epoch - 1 })).toBe(false);
    expect(await stores.redis.get(`snapshot:${stores.workerId}:current`)).toBe(JSON.stringify(newer));
    expect(before).not.toBeNull();
  });
});
