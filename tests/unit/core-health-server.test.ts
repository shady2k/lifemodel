import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { startCoreHealthServer } from '../../src/core/health-server.js';

let server: Server | undefined;
afterEach(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe('core tick health endpoint', () => {
  it('reports healthy only while the loop is running and a tick recently started', async () => {
    let running = true;
    let tickCount = 1;
    let lastTickAt = Date.now();
    server = await startCoreHealthServer(
      { isRunning: () => running, getTickCount: () => tickCount, getLastTickAt: () => lastTickAt },
      0
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('health server has no TCP address');
    const url = `http://127.0.0.1:${address.port}/healthz`;
    expect((await fetch(url)).status).toBe(200);
    lastTickAt = Date.now() - 11_000;
    expect((await fetch(url)).status).toBe(503);
    lastTickAt = Date.now();
    tickCount = 0;
    expect((await fetch(url)).status).toBe(503);
    tickCount = 1;
    running = false;
    expect((await fetch(url)).status).toBe(503);
  });
});
