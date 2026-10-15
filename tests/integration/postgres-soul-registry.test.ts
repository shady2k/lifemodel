import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSoulProvider, PostgresSoulStore } from '../../src/storage/soul-provider.js';
import { createPersistentRecipientRegistry } from '../../src/core/recipient-registry.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createTestLogger } from '../helpers/test-logger.js';
import { createTestStores } from '../helpers/test-stores.js';

describe('Postgres soul and recipient registry', () => {
  it('persists the soul and routes across fresh instances and refuses a stale soul write', async () => {
    const stores = await createTestStores();
    const dataPath = await mkdtemp(join(tmpdir(), 'lifemodel-soul-'));
    try {
      await applyTestMigrations(stores.postgres);
      process.env.DATA_PATH = dataPath;
      const logger = createTestLogger();
      const soulStore = new PostgresSoulStore(stores.postgres);
      const firstSoul = createSoulProvider(logger, { store: soulStore });
      const staleSoul = createSoulProvider(logger, { store: soulStore });
      const changed = await firstSoul.getState();
      const staleState = await staleSoul.getState();
      changed.selfModel.narrative.currentStory = 'survives a restart';
      await firstSoul.persist();
      staleState.selfModel.narrative.currentStory = 'stale overwrite';
      await expect(staleSoul.persist()).rejects.toThrow(/stale|version/i);

      const registry = createPersistentRecipientRegistry(stores.postgres, logger, {
        saveDebounceMs: 60_000,
      });
      await registry.init();
      const recipientId = registry.getOrCreate('telegram', 'chat-avy');
      await registry.flush();

      const restartedSoul = createSoulProvider(logger, {
        store: new PostgresSoulStore(stores.postgres),
      });
      const restartedRegistry = createPersistentRecipientRegistry(stores.postgres, logger);
      await restartedRegistry.init();
      expect((await restartedSoul.getState()).selfModel.narrative.currentStory).toBe(
        'survives a restart'
      );
      expect(restartedRegistry.resolve(recipientId)).toEqual({
        channel: 'telegram',
        destination: 'chat-avy',
      });
      await expect(access(join(dataPath, 'state'))).rejects.toThrow();
    } finally {
      delete process.env.DATA_PATH;
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
      await rm(dataPath, { recursive: true, force: true });
    }
  });
});
