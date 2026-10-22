import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createContainerAsync, type Container } from '../../src/core/container.js';
import { createTestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';

const embeddingGate: { promise: Promise<void>; release: () => void } = (() => {
  let release!: () => void;
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
})();
let markEmbeddingStarted!: () => void;
const embeddingStarted = new Promise<void>((resolve) => {
  markEmbeddingStarted = resolve;
});

vi.mock('@huggingface/transformers', () => ({
  env: { cacheDir: '', allowLocalModels: true, allowRemoteModels: true },
  pipeline: async () => async () => {
    markEmbeddingStarted();
    await embeddingGate.promise;
    return { data: new Float32Array(384).fill(0.1) };
  },
}));

let active: Container | undefined;
const previousEnv = new Map<string, string | undefined>();
const envKeys = [
  'LIFEMODEL_DATABASE_URL',
  'LIFEMODEL_VALKEY_URL',
  'NODE_ENV',
  'MOTOR_CORTEX_ENABLED',
];

afterEach(async () => {
  embeddingGate.release();
  await active?.shutdown();
  active = undefined;
  for (const key of envKeys) {
    const previous = previousEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

describe('durable effects during shutdown', { timeout: 120_000 }, () => {
  it('waits for an in-flight memory save before closing the real Postgres store', async () => {
    const stores = await createTestStores();
    // The file's stores are closed even when an assertion fails: a pool left
    // open keeps its connection, and the file's database cannot be dropped
    // (lifemodel-653.7.10).
    onTestFinished(async () => {
      await stores.postgres.end();
      await stores.redis.quit();
    });
    await applyTestMigrations(stores.postgres);
    previousEnv.clear();
    for (const key of envKeys) previousEnv.set(key, process.env[key]);
    const databaseUrl = new URL(process.env['LIFEMODEL_TEST_DATABASE_URL']!);
    databaseUrl.pathname = `/lifemodel_test_worker_${stores.workerId}`;
    process.env['LIFEMODEL_DATABASE_URL'] = databaseUrl.toString();
    const valkeyUrl = new URL(process.env['LIFEMODEL_TEST_VALKEY_URL']!);
    valkeyUrl.pathname = '/0';
    process.env['LIFEMODEL_VALKEY_URL'] = valkeyUrl.toString();
    process.env['NODE_ENV'] = 'production';
    process.env['MOTOR_CORTEX_ENABLED'] = 'false';
    active = await createContainerAsync({
      logLevel: 'error',
      coreLoop: { shutdownDrainTimeoutMs: 500 },
    });
    const content = `shutdown-gated-${randomUUID()}`;
    active.coreLoop.start();
    (active.coreLoop as unknown as { applyIntents(intents: unknown[]): void }).applyIntents([
      { type: 'SAVE_TO_MEMORY', payload: { type: 'fact', content } },
    ]);
    await embeddingStarted;

    let shutdownFinished = false;
    const stopping = active.shutdown().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    embeddingGate.release();
    await stopping;
    const result = await stores.postgres.query(
      'SELECT content FROM core.memories WHERE content = $1',
      [content]
    );
    expect(result.rows).toHaveLength(1);
  });
});
