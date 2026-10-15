import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { createBusSignalStream } from '../../src/core/bus-stream.js';
import { startCoreHealthServer } from '../../src/core/health-server.js';
import {
  startInstance,
  makeScratchDir,
  rmDir,
  waitFor,
} from '../helpers/core-loop-drain-harness.js';

describe('core health tracks committed progress', () => {
  let stores: TestStores;
  beforeAll(async () => {
    stores = await createTestStores();
  });
  afterAll(async () => {
    await stores.redis.quit();
    await stores.postgres.end();
  });

  it('stays unhealthy through repeated pre-CAS failures and becomes healthy after a commit', async () => {
    const prefix = `health-progress:${stores.workerId}:${Date.now()}:`;
    const bus = createBusSignalStream(stores.redis, prefix);
    await stores.redis.xadd(`${prefix}bus`, '*', 'signal', '{malformed');
    const path = await makeScratchDir('health-progress-fail-');
    let commits = 0;
    const instance = await startInstance(path, {
      tickIntervalMs: 10,
      busSignalStream: bus,
      commitSnapshot: async () => {
        commits += 1;
      },
    });
    let server: Server | undefined;
    try {
      server = await startCoreHealthServer(instance.coreLoop, 0, 50);
      await waitFor(() => instance.coreLoop.getTickCount() >= 3, 'repeated failed ticks');
      await new Promise((resolve) => setTimeout(resolve, 60));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('health server has no address');
      expect(commits).toBe(0);
      expect((await fetch(`http://127.0.0.1:${address.port}/healthz`)).status).toBe(503);
    } finally {
      if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await instance.coreLoop.stop();
      await rmDir(path);
    }

    const goodPrefix = `health-progress-ok:${stores.workerId}:${Date.now()}:`;
    const goodPath = await makeScratchDir('health-progress-ok-');
    const good = await startInstance(goodPath, {
      tickIntervalMs: 10,
      busSignalStream: createBusSignalStream(stores.redis, goodPrefix),
      commitSnapshot: async () => undefined,
    });
    let goodServer: Server | undefined;
    try {
      goodServer = await startCoreHealthServer(good.coreLoop, 0, 50);
      await waitFor(() => good.coreLoop.getLastCommitAt() > 0, 'successful snapshot commit');
      const address = goodServer.address();
      if (!address || typeof address === 'string') throw new Error('health server has no address');
      expect((await fetch(`http://127.0.0.1:${address.port}/healthz`)).status).toBe(200);
    } finally {
      if (goodServer?.listening)
        await new Promise<void>((resolve) => goodServer!.close(() => resolve()));
      await good.coreLoop.stop();
      await rmDir(goodPath);
    }
  });
});
