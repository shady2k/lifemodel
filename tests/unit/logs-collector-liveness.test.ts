import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const probe = resolve('deploy/platform/logs/config/check-delivery.sh');
const sent = (count: number, component = 'logs-store') =>
  `vector_component_sent_events_total{component_id="${component}",component_kind="sink"} ${count}\n`;

let directory: string;
let store: Server;
let exporter: Server;
let storeUrl: string;
let metricsUrl: string;
let healthStatus: number;
let metricsStatus: number;
let metrics: string;
let hang: boolean;
let requests: string[];

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture address');
  return `http://127.0.0.1:${address.port}`;
}

async function check(now: number) {
  return await new Promise<{ code: number | null; output: string }>((done, reject) => {
    const child = spawn('/bin/bash', [probe], {
      env: {
        ...process.env,
        LOGS_STORE_HEALTH_URL: storeUrl,
        LOGS_COLLECTOR_METRICS_URL: metricsUrl,
        LOGS_DELIVERY_STATE_FILE: join(directory, 'delivery'),
        LOGS_DELIVERY_NOW: String(now),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => done({ code, output }));
  });
}

async function stalledFrom(start: number, count = 7) {
  metrics = sent(count);
  for (let offset = 0; offset < 300; offset += 30) {
    expect((await check(start + offset)).code).toBe(0);
  }
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'logs-delivery-'));
  healthStatus = 200;
  metricsStatus = 200;
  metrics = sent(7);
  hang = false;
  requests = [];
  store = createServer((request, response) => {
    requests.push(`store ${request.url}`);
    response.writeHead(healthStatus).end('private-health-body');
  });
  exporter = createServer((request, response) => {
    requests.push(`exporter ${request.url}`);
    if (hang) return;
    response.writeHead(metricsStatus).end(metrics);
  });
  storeUrl = `${await listen(store)}/health`;
  metricsUrl = `${await listen(exporter)}/metrics`;
});

afterEach(async () => {
  for (const server of [store, exporter]) {
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done()))
    );
  }
  rmSync(directory, { recursive: true, force: true });
});

describe('collector delivery liveness', () => {
  it('allows startup grace, then fails at five minutes without sink delivery', async () => {
    await stalledFrom(1000);
    const result = await check(1300);
    expect(result.code).toBe(1);
    expect(requests).toContain('store /health');
    expect(requests).toContain('exporter /metrics');
    expect(result.output).not.toContain('private-health-body');
    expect(result.output).not.toContain('vector_component_sent_events_total');
  });

  it('resets the grace period when the logs-store sink counter advances', async () => {
    await stalledFrom(1000);
    metrics = sent(8);
    expect((await check(1300)).code).toBe(0);
    for (let now = 1330; now < 1600; now += 30) expect((await check(now)).code).toBe(0);
    expect((await check(1600)).code).toBe(1);
  });

  it('does not mistake another sink or source activity for store delivery', async () => {
    await stalledFrom(1000);
    metrics = `${sent(7)}${sent(999, 'console')}component_received_events_total{component_id="logs-store"} 999\n`;
    expect((await check(1300)).code).toBe(1);
  });

  it('adds all labeled series of the store sink and accepts exponent counters', async () => {
    metrics =
      'vector_component_sent_events_total{component_kind="sink",component_id="logs-store",output="a"} 3\n' +
      'vector_component_sent_events_total{output="b",component_id="logs-store",component_kind="sink"} 4\n';
    expect((await check(1000)).code).toBe(0);
    metrics = sent(8);
    expect((await check(1030)).code).toBe(0);
    metrics = sent(9).replace(' 9\n', ' 9e0\n');
    expect((await check(1060)).code).toBe(0);
  });

  it('keeps the collector healthy while the store is unavailable and restarts grace on recovery', async () => {
    await stalledFrom(1000);
    healthStatus = 503;
    expect((await check(1300)).code).toBe(0);
    expect((await check(4000)).code).toBe(0);
    healthStatus = 200;
    await stalledFrom(4030);
    expect((await check(4330)).code).toBe(1);
  });

  it.each([302, 404, 500])('does not treat store HTTP %s as healthy', async (status) => {
    await stalledFrom(1000);
    healthStatus = status;
    expect((await check(1300)).code).toBe(0);
  });

  it('fails after grace when healthy-store exporter metrics are missing or malformed', async () => {
    metrics =
      'private-metrics-body\nvector_component_sent_events_total{component_id="logs-store"} NaN\n';
    for (let now = 1000; now < 1300; now += 30) expect((await check(now)).code).toBe(0);
    const result = await check(1300);
    expect(result.code).toBe(1);
    expect(result.output).not.toContain('private-metrics-body');
    expect(result.output).not.toContain('NaN');
  });

  it('does not parse metrics from an HTTP failure response', async () => {
    metricsStatus = 503;
    for (let now = 1000; now < 1300; now += 30) {
      metrics = sent(now);
      expect((await check(now)).code).toBe(0);
    }
    expect((await check(1300)).code).toBe(1);
  });

  it('bounds a hung exporter request and counts it as no progress', async () => {
    await stalledFrom(1000);
    hang = true;
    const began = performance.now();
    expect((await check(1300)).code).toBe(1);
    expect(performance.now() - began).toBeLessThan(4500);
  }, 7000);

  it('resets grace after a counter restart, a backward clock or a long observation gap', async () => {
    await stalledFrom(1000);
    metrics = sent(0);
    expect((await check(1300)).code).toBe(0);
    expect((await check(900)).code).toBe(0);
    expect((await check(2000)).code).toBe(0);
  });
});
