/**
 * The log store adapter's status reads (ADR-016 §4, §5): the collector's
 * heartbeat (its own record and its copy read back from the collector pod's log
 * file), the store's read-only gauge, and the evictor's own lines.
 *
 * The fixture holds responses captured from the pinned store; no field here is
 * invented.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createLogsStore } from '../../loader/src/logs-store-adapter.js';
import { startLogsStoreFixture, type LogsStoreFixture } from '../helpers/logs-store-fixture.js';

const STATUS_FIXTURE = 'logs-store-status.json';

const fixtures: LogsStoreFixture[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
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

async function recorded(): Promise<LogsStoreFixture> {
  const fixture = await startLogsStoreFixture(STATUS_FIXTURE);
  fixtures.push(fixture);
  return fixture;
}

async function listen(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server did not bind'));
        return;
      }
      const port = address.port;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

describe('the collector heartbeat read (ADR-016 §4)', () => {
  it('reads the newest record of each heartbeat kind with two queries', async () => {
    const fixture = await recorded();
    const store = createLogsStore({ url: fixture.url });
    expect(await store.heartbeats()).toEqual({
      state: 'ok',
      process: '2026-11-07T11:00:00Z',
      podLog: '2026-11-07T10:59:30Z',
    });
    expect(fixture.requests.map((request) => [request.method, request.path])).toEqual([
      ['POST', '/select/logsql/query'],
      ['POST', '/select/logsql/query'],
    ]);
    expect(fixture.requests[0]?.query).toContain('module:="collector-heartbeat"');
    expect(fixture.requests[0]?.query).toContain('container:="collector-heartbeat"');
    expect(fixture.requests[1]?.query).toContain('container:="logs-collector"');
    for (const request of fixture.requests) expect(request.query).toContain('limit 1');
  });

  it('says unknown, not an age, when the store holds no heartbeat at all', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/stream+json' });
      res.end('');
    });
    expect(await createLogsStore({ url }).heartbeats()).toEqual({
      state: 'ok',
      process: null,
      podLog: null,
    });
  });

  it('says unavailable instead of unknown when the heartbeat cannot be read', async () => {
    const port = await closedPort();
    expect(await createLogsStore({ url: `http://127.0.0.1:${String(port)}` }).heartbeats()).toEqual(
      {
        state: 'unavailable',
        reason: 'connection_refused',
      }
    );
  });
});

describe('the store read-only gauge (ADR-016 §4, §5)', () => {
  it('reads the gauge from the store metrics', async () => {
    const fixture = await recorded();
    expect(await createLogsStore({ url: fixture.url }).readOnly()).toEqual({
      state: 'ok',
      readOnly: false,
    });
    const request = fixture.requests.find((entry) => entry.path === '/metrics');
    expect(request).toMatchObject({ method: 'GET' });
  });

  it('reports the read-only state when the gauge says so', async () => {
    const url = await listen((req, res) => {
      expect(req.url).toBe('/metrics');
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end('# HELP vl_storage_is_read_only\nvl_storage_is_read_only{path="/data"} 1\n');
    });
    expect(await createLogsStore({ url }).readOnly()).toEqual({ state: 'ok', readOnly: true });
  });

  it('does not guess read-only from a body without the gauge', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end('go_goroutines 12\n');
    });
    expect(await createLogsStore({ url }).readOnly()).toEqual({
      state: 'unavailable',
      reason: 'invalid_response',
    });
  });

  it('says unavailable when the store answers the metrics with an error', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('starting');
    });
    expect(await createLogsStore({ url }).readOnly()).toEqual({
      state: 'unavailable',
      reason: 'http_error',
      status: 503,
    });
  });
});

describe("the evictor's own lines (ADR-016 §5)", () => {
  it('returns each line newest first with the day and bytes it names', async () => {
    const fixture = await recorded();
    const result = await createLogsStore({ url: fixture.url }).evictions();
    if (result.state !== 'ok') throw new Error(result.reason);
    expect(result.evictions.map((line) => line.time)).toEqual([
      '2026-11-07T09:55:00Z',
      '2026-11-06T08:30:00Z',
      '2026-11-04T22:01:12.5Z',
    ]);
    expect(result.evictions[0]).toEqual({
      time: '2026-11-07T09:55:00Z',
      day: '20261105',
      freedBytes: 123456789,
      reason: 'below_threshold',
      message: expect.stringContaining('the oldest log day was removed'),
    });
    // A run that removed nothing names no day: it is a notice with its reason.
    expect(result.evictions[1]).toMatchObject({
      day: null,
      freedBytes: null,
      reason: 'no_partition',
      message: expect.stringContaining('the log evictor removed nothing'),
    });
    expect(fixture.requests[0]?.query).toBe(
      'module:="logs-evictor" | sort by (_time desc) | limit 50'
    );
  });

  it('says unavailable instead of an empty list when the store does not answer', async () => {
    const port = await closedPort();
    expect(await createLogsStore({ url: `http://127.0.0.1:${String(port)}` }).evictions()).toEqual({
      state: 'unavailable',
      reason: 'connection_refused',
    });
  });
});
