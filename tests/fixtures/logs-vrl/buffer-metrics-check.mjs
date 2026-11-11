/** Native full-disk-buffer outage regression for the collector's exported gauges. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import YAML from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const expirySeconds = 5;
const flushSeconds = 2;
const idleMillis = 12_000;

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

function samples(text) {
  const result = new Map();
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const match = line.match(/^(\w+)\{([^}]*)\} ([^ ]+)/);
    if (match && match[2].includes('component_id="logs-store"')) {
      result.set(match[1], Number(match[3]));
    }
    if (match?.[1] === 'vector_component_sent_events_total' &&
        match[2].includes('component_id="internal_metrics"')) {
      result.set('metrics_source_sent', Number(match[3]));
    }
  }
  return result;
}

const names = {
  bytes: 'vector_buffer_size_bytes',
  events: 'vector_buffer_size_events',
  received: 'vector_buffer_received_events_total',
  sent: 'vector_buffer_sent_events_total',
};

async function runOutage(committed, runner, topology, retain) {
  const directory = mkdtempSync(join(tmpdir(), 'lifemodel-buffer-metrics-'));
  mkdirSync(join(directory, 'data'));
  // Use two ephemeral loopback ports. The destination really closes after warmup;
  // an HTTP error response alone does not reproduce a refused connection.
  const destination = createServer((request, response) => {
    request.resume();
    request.on('end', () => response.writeHead(200).end());
  });
  const destinationPort = await listen(destination);
  const reservation = createServer();
  const metricsPort = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const config = structuredClone(committed);
  const base = runner.basePath(directory);
  config.data_dir = join(base, 'data');
  config.expire_metrics_secs = retain ? committed.expire_metrics_secs : expirySeconds;
  // Accelerate only the observation clocks, never the production buffer or throttle.
  config.sources = {
    kubernetes: { type: 'demo_logs', format: 'shuffle', interval: 0.0025,
      lines: ['info ' + 'x'.repeat(50 * 1024)] },
    heartbeat: { ...committed.sources.heartbeat, interval: 1 },
    internal_metrics: { ...committed.sources.internal_metrics, scrape_interval_secs: 1 },
  };
  config.transforms['source-identity'] = {
    type: 'remap', inputs: ['kubernetes'],
    source: '.kubernetes = {"pod_namespace": "lifemodel-motor", "pod_name": "outage-writer", "container_name": "writer", "pod_node_name": "test-node"}',
  };
  config.transforms.normalize.inputs = ['source-identity'];
  config.sinks.metrics.address = `127.0.0.1:${metricsPort}`;
  config.sinks.metrics.flush_period_secs = flushSeconds;
  config.sinks['logs-store'].uri = `http://127.0.0.1:${destinationPort}/insert/jsonline`;
  // d7a767a4: before the throttle branches, the sink read normalize directly.
  if (topology === 'old') config.sinks['logs-store'].inputs = ['normalize', 'collector-heartbeat'];
  delete config.sinks['heartbeat-canary'];
  assert.deepEqual(config.sinks['logs-store'].buffer,
    { type: 'disk', max_size: 335544320, when_full: 'block' });
  writeFileSync(join(directory, 'vector.yaml'), YAML.stringify(config));
  let stop;
  const scrape = async () => {
    const response = await fetch(`http://127.0.0.1:${metricsPort}/metrics`);
    assert.equal(response.status, 200);
    return samples(await response.text());
  };
  const until = async (description, predicate, milliseconds) => {
    const deadline = Date.now() + milliseconds;
    let last;
    while (Date.now() < deadline) {
      await delay(1000);
      try { last = await scrape(); } catch (error) {
        if (error.cause?.code === 'ECONNREFUSED') continue;
        throw error;
      }
      if (predicate(last)) return last;
    }
    throw new Error(`${description}: timed out; last metrics ${JSON.stringify(Object.fromEntries(last ?? []))}`);
  };
  try {
    stop = runner.startCollector({ directory, configName: 'vector.yaml',
      containerName: 'lifemodel-buffer-metrics-check', hostNetwork: true,
      env: { VECTOR_COLLECTOR_START: new Date().toISOString(), VECTOR_SELF_NODE_NAME: 'test-node' } });
    await until('warm sink seeds received and sent counters',
      (m) => m.get(names.received) > 0 && m.get(names.sent) > 0, 20_000);
    const closed = new Promise((resolve) => destination.close(resolve));
    destination.closeAllConnections();
    await closed;
    let previous;
    let stationary = 0;
    const full = await until('full production buffer stops receiving', (m) => {
      const bytes = m.get(names.bytes);
      const received = m.get(names.received);
      // Vector 0.61 disk_v2 reserves one default 128 MiB segment from max_size.
      // The logical gauge therefore stalls around 192 MiB, not 320 MiB.
      const effectiveCapacity = 335544320 - 128 * 1024 * 1024;
      if (bytes > effectiveCapacity - 100 * 1024 && received === previous) stationary++;
      else stationary = 0;
      previous = received;
      return stationary >= 2;
    }, 90_000);
    const received = full.get(names.received);
    const bytes = full.get(names.bytes);
    const events = full.get(names.events);
    const sent = full.get(names.sent);
    assert.ok(events > 0, 'full buffer contains events');
    await delay(idleMillis);
    const idle = await scrape();
    assert.ok(idle.get('metrics_source_sent') > full.get('metrics_source_sent'),
      'internal metric heartbeats continue during backpressure');
    assert.equal(idle.get('vector_buffer_max_size_bytes'), 335544320);
    if (!retain) {
      assert.equal(idle.has(names.bytes), false, 'old registry expires the full-buffer size');
      assert.equal(idle.has(names.events), false, 'old registry expires the full-buffer event count');
      assert.equal(idle.has(names.received), false, 'old registry expires the stalled received counter');
    } else {
      assert.equal(idle.get(names.bytes), bytes, 'idle full-buffer size remains exported');
      assert.equal(idle.get(names.events), events, 'idle full-buffer event count remains exported');
      assert.equal(idle.get(names.received), received, 'stalled received counter remains exported');
      assert.ok(sent > 0, 'warmup delivered records before the outage');
      assert.equal(idle.get(names.sent), sent, 'stalled sent counter remains exported unchanged');
    }
    console.log(`test collector full 320 MiB outage ${topology} topology ${retain ? 'retention' : 'expiry control'} ... passed`);
  } finally {
    destination.closeAllConnections();
    destination.close();
    await stop?.('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function checkCollectorBufferMetrics({ runner }) {
  const committed = YAML.parse(readFileSync(join(root, 'deploy/platform/logs/config/vector.yaml'), 'utf8'));
  assert.equal(committed.expire_metrics_secs, -1, 'collector registry must retain inactive metrics');
  await runOutage(committed, runner, 'old', false);
  await runOutage(committed, runner, 'committed', false);
  await runOutage(committed, runner, 'committed', true);
}
