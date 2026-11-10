import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLogEvictor } from '../../loader/src/log-evictor.js';
import { createLogsPartitionStore } from '../../loader/src/logs-partition-store.js';

const DAY = '20261106';
const KEY = 'canary-partition-key+&?secret';
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        })
    )
  );
});

async function fixture(attachedInitially: boolean, detachStatus = 200) {
  const root = mkdtempSync(join(tmpdir(), 'evict-recovery-'));
  roots.push(root);
  const directory = join(root, 'partitions', DAY);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'data'), 'logs');
  let attached = attachedInitially;
  const requests: { url: string; method?: string; contentType?: string; body: string }[] = [];
  const events: string[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    requests.push({
      url: req.url ?? '',
      method: req.method,
      contentType: req.headers['content-type'],
      body,
    });
    if (req.url?.startsWith('/internal/partition/list')) {
      res.end(JSON.stringify(attached ? [DAY] : []));
    } else {
      events.push('detach');
      expect(existsSync(directory)).toBe(true);
      res.writeHead(attached ? detachStatus : 400);
      if (attached && detachStatus === 200) {
        attached = false;
      }
      res.end(`diagnostic must not escape: ${KEY}`);
    }
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const store = createLogsPartitionStore({ url: `http://127.0.0.1:${address.port}`, key: KEY });
  const lines: string[] = [];
  const run = () =>
    runLogEvictor({
      volumePath: root,
      store,
      space: async () => ({
        totalBytes: 3 * 1024 ** 3,
        availableBytes: existsSync(directory) ? 0 : 2 * 1024 ** 3,
      }),
      write: (line) => {
        events.push('drop');
        lines.push(line);
      },
    });
  return {
    directory,
    requests,
    events,
    lines,
    run,
    store,
    restart: () => {
      attached = true;
    },
  };
}

it('preserves a still-draining day absent from the list with no drain acknowledgement', async () => {
  const f = await fixture(false);
  expect(await f.run()).toBe(1);
  expect(existsSync(f.directory)).toBe(true);
  expect(f.requests.map((request) => request.url)).toEqual(['/internal/partition/list']);
  expect(f.lines).toHaveLength(1);
  expect(JSON.parse(f.lines[0]!)).toMatchObject({
    level: 'error',
    day: DAY,
    reason: 'stranded_partition',
    msg: 'the log evictor removed nothing',
  });
});

it('requires a store restart after interruption, then uses a new acknowledged detach', async () => {
  const f = await fixture(true);
  // Simulate termination immediately after a successful store response: no
  // filesystem removal or evictor outcome can run in the terminated process.
  const detach = f.store.detach.bind(f.store);
  f.store.detach = async (day) => {
    expect(await detach(day)).toEqual({ state: 'detached' });
    throw new Error('Job killed');
  };
  await expect(f.run()).rejects.toThrow('Job killed');
  f.store.detach = detach;
  expect(existsSync(f.directory)).toBe(true);
  expect(f.events).toEqual(['detach']);
  f.lines.length = 0;
  f.events.length = 0;
  expect(await f.run()).toBe(1);
  expect(existsSync(f.directory)).toBe(true);
  expect(JSON.parse(f.lines[0]!)).toMatchObject({ reason: 'stranded_partition', day: DAY });
  f.restart();
  f.events.length = 0;
  f.lines.length = 0;
  expect(await f.run()).toBe(0);
  expect(f.events).toEqual(['detach', 'drop']);
  expect(existsSync(f.directory)).toBe(false);
  expect(JSON.parse(f.lines[0]!)).toMatchObject({ level: 'info', day: DAY });
});

it('keeps a listed attached day on detach refusal and exposes no key in URLs, logs or diagnostics', async () => {
  const f = await fixture(true, 400);
  expect(await f.run()).toBe(1);
  expect(existsSync(f.directory)).toBe(true);
  expect(JSON.stringify(f.lines)).not.toContain(KEY);
  expect(await f.store.detach(DAY)).toEqual({ state: 'failed', reason: 'rejected', status: 400 });
  for (const request of f.requests) {
    expect(request.url).not.toContain(KEY);
    expect(new URL(request.url, 'http://store').search).toBe('');
    expect(request.method).toBe('POST');
    expect(request.contentType).toMatch(/^application\/x-www-form-urlencoded/);
    const body = new URLSearchParams(request.body);
    expect(body.get('authKey')).toBe(KEY);
    if (request.url.endsWith('/detach')) expect(body.get('name')).toBe(DAY);
  }
});

it('normally waits for a 200 detach before removing the directory', async () => {
  const f = await fixture(true);
  expect(await f.run()).toBe(0);
  expect(f.events).toEqual(['detach', 'drop']);
  expect(existsSync(f.directory)).toBe(false);
  expect(JSON.parse(f.lines[0]!)).toMatchObject({ level: 'info', day: DAY });
});
