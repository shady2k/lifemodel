import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConfigLoader } from '../../src/config/config-loader.js';
import type { AgentConfigFile } from '../../src/config/config-schema.js';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createSettingsServer } from '../../src/settings/server.js';
import { createTestLogger } from '../helpers/test-logger.js';

let stores: TestStores;
beforeAll(async () => {
  stores = await createTestStores();
  await applyTestMigrations(stores.postgres);
});
beforeEach(async () => {
  await stores.postgres.query(`DELETE FROM core.settings WHERE id = 'agent-config'`);
});
afterAll(async () => {
  await stores.postgres.end();
  await stores.redis.quit();
});

const config = (baseUrl: string): AgentConfigFile => ({
  version: 1,
  identity: { name: 'Nika' },
  llm: { endpoint: { baseUrl, fastModel: 'fast', smartModel: 'smart', motorModel: 'motor' } },
});

describe('Postgres configuration persistence', () => {
  it('stores one config document and loads it on a fresh loader', async () => {
    await createConfigLoader(stores.postgres).writeConfig(config('http://127.0.0.1:1234/v1'));
    const freshLoader = createConfigLoader(stores.postgres);
    expect(await freshLoader.readConfig()).toEqual(config('http://127.0.0.1:1234/v1'));
    expect((await freshLoader.load()).llm.endpoint.baseUrl).toBe('http://127.0.0.1:1234/v1');
  });

  it('saves endpoint and model settings through HTTP and reads them after a loader restart', async () => {
    const server = createSettingsServer({
      config: createConfigLoader(stores.postgres),
      logger: createTestLogger('silent'),
      port: 0,
      onSaved: () => undefined,
    });
    await server.listen();
    try {
      const address = server.address();
      const form = new URLSearchParams({
        endpointBaseUrl: 'http://127.0.0.1:1234/v1',
        fastModel: 'fast-next',
        smartModel: 'smart-next',
        motorModel: 'motor-next',
        telegramChatId: '',
        telegramBotToken: '__telegram_bot_token__',
      });
      const response = await fetch(`${address}/settings`, {
        method: 'POST',
        headers: { Origin: address, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      });
      expect(response.status).toBe(200);
      await response.text();
      const restartedLoader = createConfigLoader(stores.postgres);
      expect((await restartedLoader.load()).llm.endpoint).toEqual({
        baseUrl: 'http://127.0.0.1:1234/v1',
        fastModel: 'fast-next',
        smartModel: 'smart-next',
        motorModel: 'motor-next',
      });
    } finally {
      await server.close();
    }
  });

  it('replaces the document atomically as one JSON value', async () => {
    const loader = createConfigLoader(stores.postgres);
    await loader.writeConfig(config('http://first/v1'));
    await Promise.all([
      loader.writeConfig(config('http://second/v1')),
      loader.writeConfig(config('http://third/v1')),
    ]);
    const written = await loader.readConfig();
    expect(['http://second/v1', 'http://third/v1']).toContain(written?.llm?.endpoint?.baseUrl);
    const row = await stores.postgres.query(`SELECT count(*)::int AS count FROM core.settings`);
    expect(row.rows[0].count).toBe(1);
  });
});
