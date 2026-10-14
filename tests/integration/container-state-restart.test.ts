import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContainerAsync, type Container } from '../../src/core/container.js';
import { createStoragePrimitive } from '../../src/core/storage-primitive.js';
import { createTestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';

vi.mock('@huggingface/transformers', () => ({
  env: { cacheDir: '', allowLocalModels: true, allowRemoteModels: true },
  pipeline: async () => async () => ({ data: new Float32Array(384).fill(0.1) }),
}));

let active: Container | undefined;

afterEach(async () => {
  await active?.shutdown();
  active = undefined;
});

describe('core state homes across restart', () => {
  it('uses a read-only DATA_PATH and restores conversation, memory, soul, registry, plugin state, schedule and config', async () => {
    const stores = await createTestStores();
    const readonlyDataPath = join(tmpdir(), `lifemodel-readonly-${randomUUID()}`);
    const previous = {
      database: process.env['LIFEMODEL_DATABASE_URL'],
      valkey: process.env['LIFEMODEL_VALKEY_URL'],
      data: process.env['DATA_PATH'],
      model: process.env['LIFEMODEL_MODEL_DIR'],
      nodeEnv: process.env['NODE_ENV'],
      motor: process.env['MOTOR_CORTEX_ENABLED'],
    };
    await mkdir(readonlyDataPath);
    await chmod(readonlyDataPath, 0o555);
    try {
      await applyTestMigrations(stores.postgres);
      const databaseUrl = new URL(process.env['LIFEMODEL_TEST_DATABASE_URL']!);
      databaseUrl.pathname = `/lifemodel_test_worker_${stores.workerId}`;
      const valkeyUrl = new URL(process.env['LIFEMODEL_TEST_VALKEY_URL']!);
      valkeyUrl.pathname = '/0';
      process.env['LIFEMODEL_DATABASE_URL'] = databaseUrl.toString();
      process.env['LIFEMODEL_VALKEY_URL'] = valkeyUrl.toString();
      process.env['DATA_PATH'] = readonlyDataPath;
      delete process.env['LIFEMODEL_MODEL_DIR'];
      process.env['NODE_ENV'] = 'production';
      process.env['MOTOR_CORTEX_ENABLED'] = 'false';

      active = await createContainerAsync({ logLevel: 'error' });
      const first = active;
      const conversationId = 'restart-check';
      await first.conversationManager!.addMessage(conversationId, {
        role: 'user',
        content: 'remember this conversation across restart',
      });
      await first.conversationManager!.addMessage(conversationId, {
        role: 'assistant',
        content: 'I will remember it',
      });
      await first.memoryProvider!.save({
        id: 'restart-memory',
        type: 'fact',
        content: 'the blue lantern is on the porch',
        timestamp: new Date(),
        confidence: 0.9,
      });
      const soul = await first.soulProvider!.getState();
      soul.selfModel.narrative.currentStory = 'restart-safe inner life';
      await first.soulProvider!.persist();
      const recipientId = first.recipientRegistry!.getOrCreate('test-channel', 'restart-user');
      await first.recipientRegistry!.flush();

      const pluginStorage = createStoragePrimitive(first.storage!, 'restart.plugin', first.logger);
      await pluginStorage.set('setting', { enabled: true, label: 'persisted' });
      const scheduler = first.schedulerService!.getScheduler('reminder');
      if (!scheduler) throw new Error('reminder scheduler was not registered');
      const scheduleId = await scheduler.schedule({
        fireAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        data: { reminder: 'tomorrow' },
      });
      await first.configLoader.writeConfig({
        version: 1,
        primaryUser: { name: 'Restart User', timezoneOffset: 3 },
      });

      await first.shutdown();
      active = await createContainerAsync({ logLevel: 'error' });
      const restarted = active;

      expect(
        (await restarted.conversationManager!.getHistory(conversationId)).map((m) => m.content)
      ).toEqual(['remember this conversation across restart', 'I will remember it']);
      expect(
        (await restarted.memoryProvider!.search('blue lantern')).entries.map((m) => m.id)
      ).toContain('restart-memory');
      expect((await restarted.soulProvider!.getState()).selfModel.narrative.currentStory).toBe(
        'restart-safe inner life'
      );
      expect(restarted.recipientRegistry!.resolve(recipientId)).toEqual({
        channel: 'test-channel',
        destination: 'restart-user',
      });
      expect(
        await createStoragePrimitive(restarted.storage!, 'restart.plugin', restarted.logger).get(
          'setting'
        )
      ).toEqual({ enabled: true, label: 'persisted' });
      expect(
        restarted
          .schedulerService!.getScheduler('reminder')
          ?.getSchedules()
          .map(({ id }) => id)
      ).toContain(scheduleId);
      expect((await restarted.configLoader.readConfig())?.primaryUser?.name).toBe('Restart User');
      expect(await readdir(readonlyDataPath)).toEqual([]);
    } finally {
      await active?.shutdown();
      active = undefined;
      if (previous.database === undefined) delete process.env['LIFEMODEL_DATABASE_URL'];
      else process.env['LIFEMODEL_DATABASE_URL'] = previous.database;
      if (previous.valkey === undefined) delete process.env['LIFEMODEL_VALKEY_URL'];
      else process.env['LIFEMODEL_VALKEY_URL'] = previous.valkey;
      if (previous.data === undefined) delete process.env['DATA_PATH'];
      else process.env['DATA_PATH'] = previous.data;
      if (previous.model === undefined) delete process.env['LIFEMODEL_MODEL_DIR'];
      else process.env['LIFEMODEL_MODEL_DIR'] = previous.model;
      if (previous.nodeEnv === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous.nodeEnv;
      if (previous.motor === undefined) delete process.env['MOTOR_CORTEX_ENABLED'];
      else process.env['MOTOR_CORTEX_ENABLED'] = previous.motor;
      await chmod(readonlyDataPath, 0o755);
      await Promise.all([
        stores.postgres.end(),
        stores.redis.quit(),
        rm(readonlyDataPath, { recursive: true, force: true }),
      ]);
    }
  });
});
