import { afterEach, describe, expect, it } from 'vitest';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { createCreatureStateStore } from '../../src/storage/creature-state-store.js';

let stores: TestStores | undefined;

afterEach(async () => {
  await stores?.redis.quit();
  await stores?.postgres.end();
  stores = undefined;
});

describe('creature state store', () => {
  it('publishes a fresh state with its epoch and reports no state after expiry', async () => {
    stores = await createTestStores();
    const stateStore = createCreatureStateStore(stores.redis);

    expect(await stateStore.readCreatureState()).toBeNull();
    await stores.redis.set('lifemodel:core:snapshot:epoch', '23');
    await stateStore.publishCreatureState('thinking', 23);
    const ttl = await stores.redis.pttl('lifemodel:creature:state');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(15_000);
    const published = await stateStore.readCreatureState();

    expect(published).toMatchObject({ state: 'thinking', epoch: 23 });
    expect(published?.ageMs).toBeGreaterThanOrEqual(0);
    expect(published?.ageMs).toBeLessThan(6_000);

    await stores.redis.pexpire('lifemodel:creature:state', 1);
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 1_000;
      const check = async () => {
        if ((await stores?.redis.get('lifemodel:creature:state')) === null) return resolve();
        if (Date.now() >= deadline) return reject(new Error('creature state did not expire'));
        setTimeout(() => void check(), 5);
      };
      void check();
    });
    expect(await stateStore.readCreatureState()).toBeNull();
  });

  it('fences old epochs after projection expiry and after epoch takeover', async () => {
    stores = await createTestStores();
    const stateStore = createCreatureStateStore(stores.redis);
    await stores.redis.set('lifemodel:core:snapshot:epoch', '25');
    await stateStore.publishCreatureState('awake', 25);
    await stores.redis.pexpire('lifemodel:creature:state', 1);
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 1_000;
      const check = async () => {
        if ((await stores?.redis.get('lifemodel:creature:state')) === null) return resolve();
        if (Date.now() >= deadline) return reject(new Error('creature state did not expire'));
        setTimeout(() => void check(), 5);
      };
      void check();
    });
    await stateStore.publishCreatureState('thinking', 24);
    expect(await stateStore.readCreatureState()).toBeNull();

    await stores.redis.set('lifemodel:core:snapshot:epoch', '26');
    await stateStore.publishCreatureState('thinking', 25);
    expect(await stateStore.readCreatureState()).toBeNull();
  });

  it('does not report a value whose published timestamp is stale', async () => {
    stores = await createTestStores();
    const stateStore = createCreatureStateStore(stores.redis);
    await stores.redis.set('lifemodel:core:snapshot:epoch', '24');
    await stateStore.publishCreatureState('awake', 24);
    await stores.redis.set(
      'lifemodel:creature:state',
      JSON.stringify({ state: 'awake', epoch: 24, publishedAt: Date.now() - 16_000 }),
      'EX',
      15
    );

    expect(await stateStore.readCreatureState()).toBeNull();
  });
});
