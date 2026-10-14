import { afterEach, describe, expect, it } from 'vitest';
import { PostgresStorage } from '../../src/storage/postgres-storage.js';
import { createPluginLoader } from '../../src/core/plugin-loader.js';
import { createSchedulerService } from '../../src/core/scheduler-service.js';
import { createMockLogger } from '../helpers/factories.js';
import type { PluginV2 } from '../../src/types/plugin.js';
import { createStoragePrimitive } from '../../src/core/storage-primitive.js';
import { createSchedulerPrimitive } from '../../src/core/scheduler-primitive.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';

describe('PostgresStorage', () => {
  let stores: TestStores | undefined;
  afterEach(async () => {
    if (stores) await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    stores = undefined;
  });

  it('persists values across instances and isolates key listing by pattern', async () => {
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
    const first = new PostgresStorage(stores.postgres);
    await first.save('plugin:alpha:profile', { name: 'Ada' });
    await first.save('plugin:beta:profile', { name: 'Grace' });

    const restarted = new PostgresStorage(stores.postgres);
    expect(await restarted.load('plugin:alpha:profile')).toEqual({ name: 'Ada' });
    expect(await restarted.exists('plugin:alpha:profile')).toBe(true);
    expect(await restarted.keys('plugin:alpha:*')).toEqual(['plugin:alpha:profile']);
    expect(await restarted.delete('plugin:alpha:profile')).toBe(true);
    expect(await restarted.delete('plugin:alpha:profile')).toBe(false);
    expect(await restarted.load('plugin:alpha:profile')).toBeNull();
  });
  it('restores plugin disablement, plugin data, and due schedules after restart', async () => {
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
    const firstStorage = new PostgresStorage(stores.postgres);
    const plugin: PluginV2 = {
      manifest: {
        manifestVersion: 2,
        id: 'test.plugin',
        name: 'Test plugin',
        version: '1.0.0',
        provides: [{ type: 'tool', id: 'test' }],
        requires: [],
      },
      lifecycle: { activate: async () => undefined, deactivate: async () => undefined },
      tools: [],
    };
    const logger = createMockLogger();
    const schedulerService = createSchedulerService(logger);
    const firstLoader = createPluginLoader(logger, firstStorage, schedulerService);
    await firstLoader.load({ default: plugin });

    const pluginStorage = createStoragePrimitive(firstStorage, 'test.plugin', logger);
    await pluginStorage.set('profile', { name: 'Ada' });
    const scheduler = schedulerService.getScheduler('test.plugin');
    const scheduleId = await scheduler.schedule({
      fireAt: new Date(Date.now() - 1000),
      data: { action: 'wake' },
    });
    expect(await firstLoader.disablePlugin('test.plugin')).toBe(true);
    await firstStorage.save('core:disabled_plugins', ['test.plugin']);

    const restartedStorage = new PostgresStorage(stores.postgres);
    const persistedDisabled = (await restartedStorage.load('core:disabled_plugins')) as string[];
    expect(persistedDisabled).toEqual(['test.plugin']);
    const restartedLoader = createPluginLoader(
      logger,
      restartedStorage,
      createSchedulerService(logger)
    );
    restartedLoader.setDisabledCatalog(
      persistedDisabled.includes(plugin.manifest.id) ? [{ plugin }] : []
    );
    expect(restartedLoader.getPluginStatuses()).toEqual([
      { pluginId: 'test.plugin', name: 'Test plugin', status: 'disabled', required: false },
    ]);
    const restartedPluginStorage = createStoragePrimitive(restartedStorage, 'test.plugin', logger);
    expect(await restartedPluginStorage.get('profile')).toEqual({ name: 'Ada' });

    const restartedScheduler = createSchedulerPrimitive(
      'test.plugin',
      restartedPluginStorage,
      logger
    );
    await restartedScheduler.initialize();
    expect(restartedScheduler.getSchedules().map(({ id }) => id)).toContain(scheduleId);
    const due = await restartedScheduler.checkDueSchedules(new Date());
    expect(due).toHaveLength(1);
    await restartedScheduler.markFired(due[0]!.entry.id, due[0]!.fireId, new Date());
    expect(await restartedScheduler.checkDueSchedules(new Date())).toHaveLength(0);
  });
});
