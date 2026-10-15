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
    await stateStore.publishCreatureState('thinking', 23);
    const published = await stateStore.readCreatureState();

    expect(published).toMatchObject({ state: 'thinking', epoch: 23 });
    expect(published?.ageMs).toBeGreaterThanOrEqual(0);
    expect(published?.ageMs).toBeLessThan(6_000);

    await stateStore.deleteCreatureState();
    expect(await stateStore.readCreatureState()).toBeNull();
  });

  it('does not let an older core epoch replace a newer published state', async () => {
    stores = await createTestStores();
    const stateStore = createCreatureStateStore(stores.redis);
    await stateStore.publishCreatureState('awake', 25);
    await stateStore.publishCreatureState('thinking', 24);

    expect(await stateStore.readCreatureState()).toMatchObject({ state: 'awake', epoch: 25 });
  });

  it('does not report a value whose published timestamp is stale', async () => {
    stores = await createTestStores();
    const stateStore = createCreatureStateStore(stores.redis);
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
