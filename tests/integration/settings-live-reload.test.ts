import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { createContainerAsync, createSettingsReloadHandler } from '../../src/core/container.js';
import { createSettingsServer, type SettingsServer } from '../../src/settings/server.js';
import { createConfigLoader } from '../../src/config/config-loader.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createTestLogger } from '../helpers/test-logger.js';
import { createTestStores } from '../helpers/test-stores.js';

let server: SettingsServer | undefined;
let core: Awaited<ReturnType<typeof createContainerAsync>> | undefined;
let endpoint: Server | undefined;
afterEach(async () => {
  await server?.close();
  await core?.shutdown();
  if (endpoint?.listening) {
    endpoint.close();
    await once(endpoint, 'close');
  }
  server = undefined;
  core = undefined;
  endpoint = undefined;
});

describe('settings reload in a running core', () => {
  it('routes a settings save into the existing provider holder and uses the new model next', async () => {
    const stores = await createTestStores();
    const previous = {
      db: process.env.LIFEMODEL_DATABASE_URL,
      valkey: process.env.LIFEMODEL_VALKEY_URL,
      dataPath: process.env.DATA_PATH,
      nodeEnv: process.env.NODE_ENV,
      motor: process.env.MOTOR_CORTEX_ENABLED,
    };
    const readOnlyDataPath = join(tmpdir(), `lifemodel-readonly-${randomUUID()}`);
    await writeFile(readOnlyDataPath, 'not a directory');
    try {
      process.env.DATA_PATH = readOnlyDataPath;
      process.env.NODE_ENV = 'production';
      process.env.MOTOR_CORTEX_ENABLED = 'false';
      await applyTestMigrations(stores.postgres);
      const url = new URL(process.env.LIFEMODEL_TEST_DATABASE_URL!);
      url.pathname = `/lifemodel_test_worker_${stores.workerId}`;
      const redisUrl = new URL(process.env.LIFEMODEL_TEST_VALKEY_URL!);
      redisUrl.pathname = '/0';
      const previous = {
        db: process.env.LIFEMODEL_DATABASE_URL,
        valkey: process.env.LIFEMODEL_VALKEY_URL,
      };
      process.env.LIFEMODEL_DATABASE_URL = url.toString();
      process.env.LIFEMODEL_VALKEY_URL = redisUrl.toString();

      const requestedModels: string[] = [];
      endpoint = createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        const payload = JSON.parse(body) as { model: string };
        requestedModels.push(payload.model);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'test',
            object: 'chat.completion',
            created: 1,
            model: payload.model,
            choices: [
              { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
            ],
          })
        );
      });
      endpoint.listen(0, '127.0.0.1');
      await once(endpoint, 'listening');
      const address = endpoint.address();
      if (!address || typeof address === 'string') throw new Error('fake endpoint did not bind');
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      const loader = createConfigLoader(stores.postgres);
      await loader.writeConfig({
        version: 1,
        llm: {
          endpoint: {
            baseUrl,
            fastModel: 'fast-old',
            smartModel: 'smart-old',
            motorModel: 'motor-old',
          },
        },
      });
      core = await createContainerAsync({ logLevel: 'error' });
      await core.llmProvider.complete({
        role: 'fast',
        messages: [{ role: 'user', content: 'first' }],
      });
      expect(requestedModels).toEqual(['fast-old']);

      let reloadFinished: Promise<void> | undefined;
      server = createSettingsServer({
        config: core.configLoader,
        logger: createTestLogger('silent'),
        port: 0,
        onSaved: () => {
          reloadFinished = createSettingsReloadHandler(core!)();
          return reloadFinished;
        },
      });
      await server.listen();
      const addressText = server.address();
      const form = new URLSearchParams({
        endpointBaseUrl: baseUrl,
        fastModel: 'fast-new',
        smartModel: 'smart-new',
        motorModel: 'motor-new',
        telegramChatId: '',
        telegramBotToken: '__telegram_bot_token__',
      });
      const result = await fetch(`${addressText}/settings`, {
        method: 'POST',
        headers: { Origin: addressText, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      });
      expect(result.status).toBe(200);
      await result.text();
      await reloadFinished;
      await core.llmProvider.complete({
        role: 'fast',
        messages: [{ role: 'user', content: 'next' }],
      });
      expect(requestedModels).toEqual(['fast-old', 'fast-new']);
    } finally {
      if (previous.db === undefined) delete process.env.LIFEMODEL_DATABASE_URL;
      else process.env.LIFEMODEL_DATABASE_URL = previous.db;
      if (previous.valkey === undefined) delete process.env.LIFEMODEL_VALKEY_URL;
      else process.env.LIFEMODEL_VALKEY_URL = previous.valkey;
      if (previous.dataPath === undefined) delete process.env.DATA_PATH;
      else process.env.DATA_PATH = previous.dataPath;
      if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous.nodeEnv;
      if (previous.motor === undefined) delete process.env.MOTOR_CORTEX_ENABLED;
      else process.env.MOTOR_CORTEX_ENABLED = previous.motor;
      await Promise.all([stores.postgres.end(), stores.redis.quit(), unlink(readOnlyDataPath)]);
    }
  });
});
