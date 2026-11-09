/**
 * The logs API's filter refusals and the new filters reaching the store
 * (ADR-016 §4, L11). The store answers from a recorded fixture, so a passing
 * record answer proves the loader sent the field filter.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createLoaderHttp, type LoaderHttp } from '../../loader/src/http.js';
import { createSession, hashPassword, type PasswordRecord } from '../../loader/src/auth.js';
import { loadConfig } from '../../loader/src/config.js';
import { createTestClock } from '../../loader/src/clock.js';
import { createRecordingLogger } from '../../loader/src/logger.js';
import type { LoaderState } from '../../loader/src/state.js';
import { LOGS_PAGE_SIZE_MAX } from '../../loader/src/logs-query.js';
import { startLogsStoreFixture, type LogsStoreFixture } from '../helpers/logs-store-fixture.js';

const BOOT = 'boot-lifemodel.local';
const FROM = Date.parse('2026-11-07T10:00:00.000Z');
const TO = Date.parse('2026-11-07T11:00:00.000Z');
const RANGE = `from=${String(FROM)}&to=${String(TO)}`;

const servers: LoaderHttp[] = [];
const roots: string[] = [];
const fixtures: LogsStoreFixture[] = [];

afterAll(async () => {
  await Promise.all(servers.splice(0).map(({ close }) => close()));
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Answer {
  status: number;
  body: string;
}

async function start(): Promise<{
  fixture: LogsStoreFixture;
  get(path: string): Promise<Answer>;
}> {
  const root = mkdtempSync(join(tmpdir(), 'loader-logs-filters-'));
  roots.push(root);
  writeFileSync(join(root, 'logs.html'), '<main>logs</main>');
  const fixture = await startLogsStoreFixture('logs-store-filters.json');
  fixtures.push(fixture);
  const record = await hashPassword('owner password');
  const clock = createTestClock();
  const token = createSession(record, clock.now());
  const state: LoaderState = {
    ensureLayout: async () => {},
    readAuth: async () => record,
    writeAuth: async () => {},
    replaceAuth: async () => {},
    readOnboarding: async () => ({ version: 1, step: 'done', completedAt: 'now' }),
    reconcilePasswordOnboarding: async () => {},
    savePasswordOnboarding: async () => {},
    saveModelOnboarding: async () => {},
  };
  const loader = createLoaderHttp({
    state,
    logger: createRecordingLogger([]),
    clock,
    config: loadConfig({
      LIFEMODEL_NAME: 'lifemodel',
      LIFEMODEL_LOGS_STORE_URL: fixture.url,
    }),
    uiRoot: root,
    pki: {
      bootstrap: async () => {},
      report: async () => ({
        identity: 'present',
        ca: 'present-matching',
        leaf: 'valid',
        sans: [],
        fingerprint: 'x',
      }),
      caPem: async () => 'CA',
    },
  });
  servers.push(loader);
  await new Promise<void>((resolve) => loader.server.listen(0, '127.0.0.1', resolve));
  const address = loader.server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  return {
    fixture,
    get: (path) =>
      new Promise((resolve, reject) => {
        const request = httpRequest(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path,
            method: 'GET',
            headers: {
              host: BOOT,
              cookie: `__Host-lm_session=${token}`,
            },
          },
          (response) => {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => {
              text += chunk;
            });
            response.on('end', () => {
              resolve({ status: response.statusCode ?? 0, body: text });
            });
          }
        );
        request.on('error', reject);
        request.end();
      }),
  };
}

function refusal(field: string): unknown {
  return { state: 'invalid', reason: 'filter', field };
}

describe('the logs API refuses a filter that cannot be queried', () => {
  it.each([
    ['a level outside the closed set', 'level=warning', 'level'],
    ['a level in the wrong case', 'level=WARN', 'level'],
    ['a module longer than its bound', `module=${'m'.repeat(129)}`, 'module'],
    ['a conversation longer than its bound', `conversation_id=${'c'.repeat(129)}`, 'conversation_id'],
    ['a text search longer than its bound', `text=${'t'.repeat(257)}`, 'text'],
    ['a module holding a control character', 'module=core%0A', 'module'],
    ['a text search holding a control character', 'text=needle%00', 'text'],
  ] as const)('answers 400 naming the field for %s', async (_case, query, field) => {
    const { fixture, get } = await start();
    const response = await get(`/api/logs?${RANGE}&${query}`);
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual(refusal(field));
    expect(fixture.requests).toHaveLength(0);
  });

  it('accepts every level the collector writes', async () => {
    const { get } = await start();
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'unknown']) {
      const response = await get(`/api/logs?${RANGE}&level=${level}`);
      expect(response.status, level).not.toBe(400);
    }
  });
});

describe('the logs API refuses a page bound that cannot be read', () => {
  it.each([
    ['an offset that is not a whole number', 'offset=1.5', 'offset'],
    ['a negative offset', 'offset=-1', 'offset'],
    ['a page size of zero', 'limit=0', 'limit'],
    ['a page size past the bound', `limit=${String(LOGS_PAGE_SIZE_MAX + 1)}`, 'limit'],
    ['an expected count that is not a number', 'expected=many', 'expected'],
    ['a negative expected count', 'expected=-1', 'expected'],
  ] as const)('answers 400 naming the parameter for %s', async (_case, query, field) => {
    const { fixture, get } = await start();
    const response = await get(`/api/logs?${RANGE}&${query}`);
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual(refusal(field));
    expect(fixture.requests).toHaveLength(0);
  });
});

describe('the logs API passes each new filter to the store', () => {
  it('narrows by level alone', async () => {
    const { fixture, get } = await start();
    const response = await get(`/api/logs?${RANGE}&level=warn`);
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      records: { fields: Record<string, string> }[];
    };
    expect(body.records).toHaveLength(3);
    expect(body.records.every((record) => record.fields['level'] === 'warn')).toBe(true);
    expect(fixture.requests.at(-1)?.query).toContain('level:="warn"');
  });

  it('narrows by conversation alone', async () => {
    const { fixture, get } = await start();
    const response = await get(`/api/logs?${RANGE}&conversation_id=conv_1`);
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      records: { fields: Record<string, string> }[];
    };
    expect(body.records).toHaveLength(4);
    expect(body.records.every((record) => record.fields['conversation_id'] === 'conv_1')).toBe(
      true
    );
    expect(fixture.requests.at(-1)?.query).toContain('conversation_id:="conv_1"');
  });

  it('narrows by text search alone', async () => {
    const { fixture, get } = await start();
    const response = await get(`/api/logs?${RANGE}&text=needle`);
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { records: { message: string }[] };
    expect(body.records.map((record) => record.message)).toEqual([
      'needle in the second bucket',
      'needle in the first bucket',
    ]);
    expect(fixture.requests.at(-1)?.query).toContain('_msg:"needle"');
  });

  it('narrows by every filter together', async () => {
    const { get } = await start();
    const response = await get(
      `/api/logs?${RANGE}&module=core&level=info&conversation_id=conv_2&text=needle`
    );
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      records: { time: string; message: string }[];
    };
    expect(body.records.map((record) => record.message)).toEqual([
      'needle in the second bucket',
    ]);
  });
});
