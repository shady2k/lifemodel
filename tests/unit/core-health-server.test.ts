import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { startCoreHealthServer } from '../../src/core/health-server.js';

let server: Server | undefined;
afterEach(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe('core tick health endpoint', () => {
  it('reports healthy only while the loop is running and a snapshot recently committed', async () => {
    let running = true;
    let lastCommitAt = Date.now();
    server = await startCoreHealthServer(
      { isRunning: () => running, getLastCommitAt: () => lastCommitAt },
      0
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('health server has no TCP address');
    const url = `http://127.0.0.1:${address.port}/healthz`;
    expect((await fetch(url)).status).toBe(200);
    lastCommitAt = Date.now() - 11_000;
    expect((await fetch(url)).status).toBe(503);
    lastCommitAt = 0;
    expect((await fetch(url)).status).toBe(503);
    lastCommitAt = Date.now();
    running = false;
    expect((await fetch(url)).status).toBe(503);
  });
});
