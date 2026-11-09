/**
 * The log evictor (ADR-016 §5, check L16): new logs displace the oldest ones
 * with nobody acting.
 *
 * A run reads the volume's free space, and only below its threshold (a quarter
 * of the volume plus 768 MiB) detaches the oldest partition in the store and
 * then removes it from the volume - never the other way round. Each drop is one
 * line; an idle run and a quiet run write nothing. A failed detach removes
 * nothing and fails the run, and so does a run that finds nothing left to drop.
 * The partition key travels to the store and never reaches a line.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONNECT_RETRY_DELAYS_MS,
  CONNECT_RETRY_WINDOW_MS,
  runLogEvictor,
  type ConnectRetry,
  type LogEvictorDeps,
} from '../../loader/src/log-evictor.js';
import {
  evictorThresholdBytes,
  readVolumeSpace,
  EVICTOR_HEADROOM_BYTES,
} from '../../loader/src/logs-volume-space.js';
import {
  createLogsPartitionStore,
  LOGS_PARTITION_DETACH_PATH,
  type PartitionDetachFailure,
  type PartitionDetachResult,
} from '../../loader/src/logs-partition-store.js';

const GiB = 1024 ** 3;
const KEY = 'unit-partition-key-3f9c2e';
/** The default volume: 3 GiB holds a 768 MiB margin and 768 MiB of headroom. */
const THRESHOLD = 1.5 * GiB;

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        })
    )
  );
});

/** A temporary volume whose `partitions/YYYYMMDD` directories hold one file each. */
function volume(days: string[], bytesPerDay = 4096): string {
  const root = mkdtempSync(join(tmpdir(), 'log-evictor-'));
  roots.push(root);
  mkdirSync(join(root, 'partitions'));
  for (const day of days) {
    mkdirSync(join(root, 'partitions', day));
    writeFileSync(join(root, 'partitions', day, 'data.bin'), Buffer.alloc(bytesPerDay, 1));
  }
  return root;
}

interface FakeStore {
  readonly calls: string[];
  detach(day: string): Promise<PartitionDetachResult>;
}

function fakeStore(result?: PartitionDetachResult): FakeStore {
  const calls: string[] = [];
  return {
    calls,
    detach: (day: string) => {
      calls.push(day);
      return Promise.resolve(result ?? { state: 'detached' });
    },
  };
}

/** A store that answers nothing for its first `refusals` connections, then detaches. */
function refusingStore(
  refusals: number,
  reason: PartitionDetachFailure = 'connection_refused'
): FakeStore {
  const calls: string[] = [];
  return {
    calls,
    detach: (day: string) => {
      calls.push(day);
      const result: PartitionDetachResult =
        calls.length <= refusals ? { state: 'failed', reason, status: null } : { state: 'detached' };
      return Promise.resolve(result);
    },
  };
}

/** A retry policy whose waits are recorded instead of slept. */
function fastRetry(overrides: Partial<ConnectRetry> = {}): {
  retry: ConnectRetry;
  sleeps: number[];
} {
  const sleeps: number[] = [];
  let clock = 0;
  const retry: ConnectRetry = {
    windowMs: 10,
    delaysMs: [1, 2, 3],
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
    ...overrides,
  };
  return { retry, sleeps };
}

/** Free-space readings in order; the last one repeats. */
function spaces(...available: number[]) {
  let index = 0;
  return () => {
    const value = available[Math.min(index, available.length - 1)] ?? 0;
    index += 1;
    return Promise.resolve({ totalBytes: 3 * GiB, availableBytes: value });
  };
}

function harness(deps: {
  volumePath: string;
  store: FakeStore;
  space: LogEvictorDeps['space'];
  retry?: ConnectRetry;
}): {
  code: () => Promise<number>;
  lines: string[];
} {
  const lines: string[] = [];
  const code = () =>
    runLogEvictor({
      volumePath: deps.volumePath,
      store: deps.store,
      space: deps.space,
      write: (line) => lines.push(line),
      // A run under test never waits out the real window.
      connectRetry: deps.retry ?? fastRetry().retry,
    });
  return { code, lines };
}

function entries(lines: readonly string[]): Record<string, any>[] {
  return lines.map((line) => {
    const value: unknown = JSON.parse(line);
    expect(typeof value, `a line must be JSON: ${line}`).toBe('object');
    return value as Record<string, any>;
  });
}

function expectNoKey(lines: readonly string[]): void {
  for (const line of lines) expect(line).not.toContain(KEY);
}

describe('the evictor threshold (ADR-016 §5)', () => {
  it('is a quarter of the volume plus 768 MiB', () => {
    expect(EVICTOR_HEADROOM_BYTES).toBe(768 * 1024 * 1024);
    expect(evictorThresholdBytes(3 * GiB)).toBe(THRESHOLD);
    expect(evictorThresholdBytes(2 * GiB)).toBe(0.5 * GiB + 768 * 1024 * 1024);
    expect(evictorThresholdBytes(4 * GiB)).toBe(GiB + 768 * 1024 * 1024);
  });

  it('reads a real directory as a volume', async () => {
    const root = volume([]);
    const space = await readVolumeSpace(root);
    expect(space.totalBytes).toBeGreaterThan(0);
    expect(space.availableBytes).toBeGreaterThan(0);
    expect(space.availableBytes).toBeLessThanOrEqual(space.totalBytes);
  });
});

describe('a log evictor run (ADR-016 §5, L16)', () => {
  it('removes nothing and writes nothing above the threshold', async () => {
    const root = volume(['20261106', '20261107']);
    const store = fakeStore();
    const run = harness({ volumePath: root, store, space: spaces(THRESHOLD) });

    expect(await run.code()).toBe(0);
    expect(store.calls).toEqual([]);
    expect(run.lines).toEqual([]);
    expect(existsSync(join(root, 'partitions', '20261106'))).toBe(true);
    expect(existsSync(join(root, 'partitions', '20261107'))).toBe(true);
  });

  it('detaches the oldest partition and then removes it, with one line', async () => {
    const root = volume(['20261106', '20261107']);
    const store = fakeStore();
    const run = harness({ volumePath: root, store, space: spaces(THRESHOLD - 1, 2 * GiB) });

    expect(await run.code()).toBe(0);
    expect(store.calls).toEqual(['20261106']);
    expect(existsSync(join(root, 'partitions', '20261106'))).toBe(false);
    expect(existsSync(join(root, 'partitions', '20261107'))).toBe(true);

    const [line, ...rest] = entries(run.lines);
    expect(rest).toEqual([]);
    expect(line).toMatchObject({
      level: 'info',
      day: '20261106',
      freedBytes: 4096,
      reason: 'below_threshold',
    });
    expectNoKey(run.lines);
  });

  it('drops day after day, oldest first, until free space is above the threshold', async () => {
    const root = volume(['20261105', '20261106', '20261107']);
    const store = fakeStore();
    const run = harness({
      volumePath: root,
      store,
      space: spaces(THRESHOLD - 1, THRESHOLD - 1, 2 * GiB),
    });

    expect(await run.code()).toBe(0);
    expect(store.calls).toEqual(['20261105', '20261106']);
    expect(entries(run.lines).map((line) => line.day)).toEqual(['20261105', '20261106']);
    expect(run.lines).toHaveLength(2);
    expect(existsSync(join(root, 'partitions', '20261107'))).toBe(true);
    expectNoKey(run.lines);
  });

  it('removes nothing and fails when the detach is rejected', async () => {
    const root = volume(['20261106']);
    const store = fakeStore({ state: 'failed', reason: 'rejected', status: 400 });
    const run = harness({ volumePath: root, store, space: spaces(THRESHOLD - 1) });

    expect(await run.code()).not.toBe(0);
    expect(existsSync(join(root, 'partitions', '20261106'))).toBe(true);
    const [line, ...rest] = entries(run.lines);
    expect(rest).toEqual([]);
    expect(line).toMatchObject({ level: 'error', reason: 'rejected', status: 400 });
    expectNoKey(run.lines);
  });

  it('retries a connection that got no answer, then fails with the reason', async () => {
    const root = volume(['20261106']);
    const store = refusingStore(Number.POSITIVE_INFINITY);
    const { retry, sleeps } = fastRetry();
    const run = harness({ volumePath: root, store, space: spaces(THRESHOLD - 1), retry });

    expect(await run.code()).not.toBe(0);
    expect(existsSync(join(root, 'partitions', '20261106'))).toBe(true);
    expect(store.calls.length).toBeGreaterThan(1);
    expect(store.calls).toHaveLength(sleeps.length + 1);
    expect(sleeps.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(retry.windowMs);
    const [line, ...rest] = entries(run.lines);
    expect(rest).toEqual([]);
    expect(line).toMatchObject({
      level: 'error',
      reason: 'connection_refused',
      attempts: store.calls.length,
      day: '20261106',
    });
    expectNoKey(run.lines);
  });

  it('removes nothing and fails when no partition is left and space is still low', async () => {
    const root = volume([]);
    const store = fakeStore();
    const run = harness({ volumePath: root, store, space: spaces(THRESHOLD - 1) });

    expect(await run.code()).not.toBe(0);
    expect(store.calls).toEqual([]);
    const [line, ...rest] = entries(run.lines);
    expect(rest).toEqual([]);
    expect(line).toMatchObject({ level: 'error', reason: 'no_partition' });
    expectNoKey(run.lines);
  });

  it('fails with one line when the volume cannot be read', async () => {
    const root = volume(['20261106']);
    const store = fakeStore();
    const run = harness({
      volumePath: root,
      store,
      space: () => Promise.reject(new Error('statfs failed')),
    });

    expect(await run.code()).not.toBe(0);
    expect(store.calls).toEqual([]);
    const [line, ...rest] = entries(run.lines);
    expect(rest).toEqual([]);
    expect(line).toMatchObject({ level: 'error', reason: 'volume_unreadable' });
    expect(run.lines[0]).not.toContain('statfs failed');
    expectNoKey(run.lines);
  });
});

describe('a detach that got no answer (ADR-016 §5)', () => {
  it('retries a refused connection and then detaches and removes', async () => {
    const root = volume(['20261106', '20261107']);
    const store = refusingStore(2);
    const { retry, sleeps } = fastRetry();
    const run = harness({
      volumePath: root,
      store,
      space: spaces(THRESHOLD - 1, 2 * GiB),
      retry,
    });

    expect(await run.code()).toBe(0);
    expect(store.calls).toEqual(['20261106', '20261106', '20261106']);
    expect(sleeps).toEqual([1, 2]);
    expect(existsSync(join(root, 'partitions', '20261106'))).toBe(false);
    expect(existsSync(join(root, 'partitions', '20261107'))).toBe(true);
    const [line, ...rest] = entries(run.lines);
    expect(rest).toEqual([]);
    expect(line).toMatchObject({
      level: 'info',
      day: '20261106',
      freedBytes: 4096,
      reason: 'below_threshold',
    });
    expectNoKey(run.lines);
  });

  it.each(['connection_refused', 'timeout', 'unreachable'] as const)(
    'retries a %s and then detaches',
    async (reason) => {
      const root = volume(['20261106']);
      const store = refusingStore(1, reason);
      const { retry } = fastRetry();
      const run = harness({ volumePath: root, store, space: spaces(THRESHOLD - 1, 2 * GiB), retry });

      expect(await run.code()).toBe(0);
      expect(store.calls).toEqual(['20261106', '20261106']);
      expect(entries(run.lines)[0]).toMatchObject({ level: 'info', day: '20261106' });
    }
  );

  it('does not retry an HTTP answer, whatever its status', async () => {
    for (const status of [400, 401, 503]) {
      const root = volume(['20261106']);
      const store = fakeStore({ state: 'failed', reason: 'rejected', status });
      const { retry, sleeps } = fastRetry();
      const run = harness({ volumePath: root, store, space: spaces(THRESHOLD - 1), retry });

      expect(await run.code()).not.toBe(0);
      expect(store.calls).toEqual(['20261106']);
      expect(sleeps).toEqual([]);
      const [line] = entries(run.lines);
      expect(line).toMatchObject({ level: 'error', reason: 'rejected', status });
      expect(line?.attempts).toBeUndefined();
    }
  });

  it('makes no extra attempt when the store answers at once', async () => {
    const root = volume(['20261106']);
    const store = fakeStore();
    const { retry, sleeps } = fastRetry();
    const run = harness({ volumePath: root, store, space: spaces(THRESHOLD - 1, 2 * GiB), retry });

    expect(await run.code()).toBe(0);
    expect(store.calls).toEqual(['20261106']);
    expect(sleeps).toEqual([]);
  });

  it('stops when the attempts themselves have used the window', async () => {
    const root = volume(['20261106']);
    const store = refusingStore(Number.POSITIVE_INFINITY);
    const sleeps: number[] = [];
    let clock = 0;
    const retry: ConnectRetry = {
      windowMs: 100,
      delaysMs: [10],
      sleep: (ms) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
      // Each attempt costs 60 ms, as one that waits out its request timeout does.
      now: () => {
        clock += 60;
        return clock;
      },
    };
    const run = harness({ volumePath: root, store, space: spaces(THRESHOLD - 1), retry });

    expect(await run.code()).not.toBe(0);
    expect(store.calls).toHaveLength(2);
    expect(sleeps).toEqual([10]);
    expect(entries(run.lines)[0]).toMatchObject({ attempts: 2, reason: 'connection_refused' });
  });

  it('keeps the whole backoff inside the window', () => {
    // The window itself is held to the CronJob's deadline in
    // tests/unit/platform-logs-evictor.test.ts, against the manifest.
    expect(CONNECT_RETRY_WINDOW_MS).toBe(20_000);
    expect(CONNECT_RETRY_DELAYS_MS.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(
      CONNECT_RETRY_WINDOW_MS
    );
    expect(CONNECT_RETRY_DELAYS_MS[0]).toBeGreaterThan(0);
  });
});

describe('the store partition protocol (ADR-016 §5)', () => {
  async function listen(handler: Parameters<typeof createServer>[0]): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    return `http://127.0.0.1:${address.port}`;
  }

  it('posts the detach of that day with the key as authKey', async () => {
    const seen: { method?: string; url?: string }[] = [];
    const url = await listen((req, res) => {
      seen.push({ method: req.method, url: req.url });
      res.writeHead(200);
      res.end();
    });
    const store = createLogsPartitionStore({ url, key: KEY });

    expect(await store.detach('20261106')).toEqual({ state: 'detached' });
    expect(seen).toHaveLength(1);
    const request = new URL(seen[0]?.url ?? '/', url);
    expect(seen[0]?.method).toBe('POST');
    expect(request.pathname).toBe(`/${LOGS_PARTITION_DETACH_PATH}`);
    expect(request.searchParams.get('name')).toBe('20261106');
    expect(request.searchParams.get('authKey')).toBe(KEY);
  });

  it('reports a non-200 answer as rejected, without carrying the body', async () => {
    const url = await listen((_req, res) => {
      // A hostile body: the store's answer echoes the key, and no line may.
      res.writeHead(400);
      res.end(`cannot detach; authKey=${KEY}`);
    });
    const store = createLogsPartitionStore({ url, key: KEY });

    const result = await store.detach('20261106');
    expect(result).toEqual({ state: 'failed', reason: 'rejected', status: 400 });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('reports a refused connection as connection_refused', async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('server did not bind'));
          return;
        }
        const bound = address.port;
        server.close(() => {
          resolve(bound);
        });
      });
    });
    const store = createLogsPartitionStore({ url: `http://127.0.0.1:${String(port)}`, key: KEY });
    expect(await store.detach('20261106')).toEqual({
      state: 'failed',
      reason: 'connection_refused',
      status: null,
    });
  });
});
