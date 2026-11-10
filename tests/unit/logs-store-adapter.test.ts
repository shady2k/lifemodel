/**
 * The loader's log-store adapter against a recorded protocol fixture
 * (ADR-016 §3, §4). The fixture holds responses captured from the pinned store;
 * no field here is invented.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createLogsStore } from '../../loader/src/logs-store-adapter.js';
import {
  buildCountQuery,
  buildRecordsQuery,
  createLogsQuery,
  LOGS_PAGE_SIZE,
} from '../../loader/src/logs-query.js';
import { startLogsStoreFixture, type LogsStoreFixture } from '../helpers/logs-store-fixture.js';

const FROM = Date.parse('2026-11-07T10:00:00.000Z');
const TO = Date.parse('2026-11-07T11:00:00.000Z');
const MID = Date.parse('2026-11-07T10:30:00.000Z');

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
  const fixture = await startLogsStoreFixture();
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

describe('the log store adapter query form', () => {
  it('builds the recorded range, sort, offset and page bound', () => {
    expect(buildRecordsQuery({ from: FROM, to: TO })).toBe(
      '_time:[2026-11-07T10:00:00.000Z, 2026-11-07T11:00:00.000Z] | sort by (_time desc, _msg desc, pod desc) | offset 0 | limit 200'
    );
    expect(buildRecordsQuery({ from: FROM, to: TO, module: 'core' })).toBe(
      '_time:[2026-11-07T10:00:00.000Z, 2026-11-07T11:00:00.000Z] module:="core" | sort by (_time desc, _msg desc, pod desc) | offset 0 | limit 200'
    );
    expect(LOGS_PAGE_SIZE).toBe(200);
  });

  it('quotes and escapes a module value instead of letting it reach LogsQL', () => {
    expect(buildRecordsQuery({ from: FROM, to: TO, module: 'core" OR *' })).toBe(
      '_time:[2026-11-07T10:00:00.000Z, 2026-11-07T11:00:00.000Z] module:="core\\" OR *" | sort by (_time desc, _msg desc, pod desc) | offset 0 | limit 200'
    );
    expect(buildRecordsQuery({ from: FROM, to: TO, module: 'core\\' })).toBe(
      '_time:[2026-11-07T10:00:00.000Z, 2026-11-07T11:00:00.000Z] module:="core\\\\" | sort by (_time desc, _msg desc, pod desc) | offset 0 | limit 200'
    );
  });
});

describe('the log store adapter against recorded responses', () => {
  it('returns the records newest first with their fields', async () => {
    const fixture = await recorded();
    const store = createLogsStore({ url: fixture.url });
    const result = await store.query(buildRecordsQuery({ from: FROM, to: TO }));
    expect(result.state).toBe('ok');
    if (result.state !== 'ok') throw new Error(result.reason);
    expect(result.records).toHaveLength(9);
    expect(result.records[0]).toEqual({
      time: '2026-11-07T11:00:00Z',
      message: 'outside window',
      fields: {
        container: 'core',
        level: 'info',
        module: 'core',
        namespace: 'lifemodel-system',
        node: 'node1',
        pod: 'core-0',
        stream: 'stdout',
      },
    });
    const task = result.records.find((record) => record.fields['module'] === 'task-harness');
    expect(task).toMatchObject({
      message: 'task line with "quotes" and \\ backslash',
      fields: {
        level: 'warn',
        namespace: 'lifemodel-tasks',
        pod: 'task-abc',
        untrusted: 'true',
        conversation_id: 'conv_1',
      },
    });
    for (const record of result.records) {
      expect(record.fields).not.toHaveProperty('_stream');
      expect(record.fields).not.toHaveProperty('_stream_id');
    }
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({
      method: 'POST',
      path: '/select/logsql/query',
    });
  });

  it('narrows by module through the store filter', async () => {
    const fixture = await recorded();
    const logs = createLogsQuery({ store: createLogsStore({ url: fixture.url }) });
    const result = await logs.page({
      filter: { from: FROM, to: TO, module: 'core' },
      offset: 0,
      limit: LOGS_PAGE_SIZE,
      expected: null,
    });
    if (result.state !== 'ok') throw new Error(result.reason);
    expect(result.records).toHaveLength(4);
    expect(result.records.every((record) => record.fields['module'] === 'core')).toBe(true);
    // The phrase form module:"core" would also match the module core-web.
    expect(result.records.map((record) => record.fields['module'])).not.toContain('core-web');
    // The window's count first, then the ordered window: the page's records,
    // then the count again, after the records were read.
    expect(fixture.requests.map(({ query }) => query)).toEqual([
      buildCountQuery({ from: FROM, to: TO, module: 'core' }),
      buildRecordsQuery({ from: FROM, to: TO, module: 'core' }),
      buildCountQuery({ from: FROM, to: TO, module: 'core' }),
    ]);
  });

  it('narrows by time through the store range', async () => {
    const fixture = await recorded();
    const logs = createLogsQuery({ store: createLogsStore({ url: fixture.url }) });
    const result = await logs.page({
      filter: { from: FROM, to: MID },
      offset: 0,
      limit: LOGS_PAGE_SIZE,
      expected: null,
    });
    if (result.state !== 'ok') throw new Error(result.reason);
    expect(result.records).toHaveLength(7);
    expect(result.records.map((record) => record.time)).not.toContain('2026-11-07T10:45:00Z');
    expect(result.records.map((record) => record.time)).not.toContain('2026-11-07T11:00:00Z');
  });

  it('returns the module list from the grouped query and caches it for a minute', async () => {
    const fixture = await recorded();
    let now = 0;
    const store = createLogsStore({ url: fixture.url, now: () => now });
    const first = await store.modules();
    expect(first).toEqual({
      state: 'ok',
      modules: ['core', 'core-web', 'loader', 'model-gateway', 'storage-module', 'task-harness'],
    });
    now = 59_999;
    expect(await store.modules()).toEqual(first);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.query).toBe('* | stats by (module) count()');
    now = 60_000;
    await store.modules();
    expect(fixture.requests).toHaveLength(2);
  });

  it('returns an empty list only when the store answered with no rows', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/stream+json' });
      res.end('');
    });
    const result = await createLogsStore({ url }).query('*');
    expect(result).toEqual({ state: 'ok', records: [] });
  });
});

describe('the log store adapter reads the window count', () => {
  it('returns the count the store answered for the window', async () => {
    const fixture = await recorded();
    const store = createLogsStore({ url: fixture.url });
    const range = (from: number, to: number) =>
      `_time:[${new Date(from).toISOString()}, ${new Date(to).toISOString()}] | stats count()`;
    expect(await store.count(range(FROM, TO))).toEqual({ state: 'ok', count: 9 });
    expect(await store.count(range(FROM, MID))).toEqual({ state: 'ok', count: 7 });
    expect(
      await store.count(
        `${range(FROM, TO).replace(' | stats count()', '')} module:="core" | stats count()`
      )
    ).toEqual({ state: 'ok', count: 4 });
  });

  it('says unavailable instead of zero when the count cannot be read', async () => {
    const port = await closedPort();
    const result = await createLogsStore({ url: `http://127.0.0.1:${String(port)}` }).count(
      '* | stats count()'
    );
    expect(result).toEqual({ state: 'unavailable', reason: 'connection_refused' });
  });

  it('says unavailable with invalid_response for a body that is not a count', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/stream+json' });
      res.end('{"rows":3}\n');
    });
    expect(await createLogsStore({ url }).count('* | stats count()')).toEqual({
      state: 'unavailable',
      reason: 'invalid_response',
    });
  });
});

describe('the log store adapter when the store does not answer', () => {
  it('says unavailable with connection_refused', async () => {
    const port = await closedPort();
    const result = await createLogsStore({ url: `http://127.0.0.1:${String(port)}` }).query('*');
    expect(result).toEqual({ state: 'unavailable', reason: 'connection_refused' });
  });

  it('says unavailable with timeout', async () => {
    const url = await listen(() => {
      // Accept the request and never answer.
    });
    const result = await createLogsStore({ url, timeoutMs: 50 }).query('*');
    expect(result).toEqual({ state: 'unavailable', reason: 'timeout' });
  });

  it('says unavailable with the status on a server error', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('storage error');
    });
    const result = await createLogsStore({ url }).query('*');
    expect(result).toEqual({ state: 'unavailable', reason: 'http_error', status: 500 });
  });

  it('says unavailable with read_only on 429', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(429, { 'content-type': 'text/plain' });
      res.end('cannot add rows into storage in read-only mode');
    });
    const result = await createLogsStore({ url }).query('*');
    expect(result).toEqual({ state: 'unavailable', reason: 'read_only', status: 429 });
  });

  it('says unavailable with invalid_response instead of an empty list', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/stream+json' });
      res.end('not a json object\n');
    });
    const result = await createLogsStore({ url }).query('*');
    expect(result).toEqual({ state: 'unavailable', reason: 'invalid_response' });
  });

  it('never turns a failed module query into an empty module list', async () => {
    const port = await closedPort();
    const result = await createLogsStore({ url: `http://127.0.0.1:${String(port)}` }).modules();
    expect(result).toEqual({ state: 'unavailable', reason: 'connection_refused' });
  });
});
