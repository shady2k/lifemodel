/** Native Vector proof of the committed task throttle and aligned counter pairs. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import YAML from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export function checkCollectorThrottle({ runner }) {
  const committed = YAML.parse(readFileSync(join(root, 'deploy/platform/logs/config/vector.yaml'), 'utf8'));
  const directory = mkdtempSync(join(tmpdir(), 'lifemodel-logs-throttle-'));
  mkdirSync(join(directory, 'data'));
  assert.equal(committed.transforms['untrusted-throttle'].threshold, 500);
  assert.equal(committed.transforms['untrusted-throttle'].window_secs, 1);
  assert.equal(committed.transforms['untrusted-throttle'].key_field, '{{ pod }}');
  const base = runner.basePath(directory);
  const path = (name) => join(base, name);
  const records = [];
  const append = (pod, namespace, count, label = 'writer') => {
    for (let i = 0; i < count; i++) records.push({
      timestamp: '2026-11-11T00:00:00Z', stream: 'stdout',
      message: JSON.stringify({ level: 'info', message: 'line', collector_counter: true,
        counter: 'input', value: 999999, window_start: 'forged', window_end: 'forged' }),
      kubernetes: { pod_name: pod, pod_namespace: namespace, container_name: 'writer',
        pod_node_name: 'node1', pod_labels: { 'app.kubernetes.io/name': label } },
    });
  };
  append('flood-a', 'lifemodel-motor', 1600);
  append('flood-b', 'lifemodel-motor', 1600);
  append('quiet', 'lifemodel-motor', 20);
  append('trusted', 'lifemodel-system', 1600, 'throttle-window');
  writeFileSync(join(directory, 'input.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
  const transforms = structuredClone(committed.transforms);
  delete transforms['collector-heartbeat'];
  // A pre-throttle input with no accepted counterpart proves zero seeding.
  transforms['throttle-input-count'].inputs.push('zero-window');
  transforms['decode-input'] = { type: 'remap', inputs: ['input-file'], source: '. = parse_json!(string!(.message))' };
  transforms['zero-window'] = { type: 'remap', inputs: ['zero-file'], source: '. = parse_json!(string!(.message))' };
  transforms.normalize.inputs = ['decode-input'];
  writeFileSync(join(directory, 'zero.jsonl'), JSON.stringify({ pod: 'zero', namespace: 'lifemodel-motor',
    window_start: '2026-11-11T00:00:00Z', window_end: '2026-11-11T00:00:06Z' }) + '\n');
  const source = (name) => ({ type: 'file', include: [path(name)], read_from: 'beginning' });
  const config = {
    data_dir: path('data'),
    sources: { 'input-file': source('input.jsonl'), 'zero-file': source('zero.jsonl') },
    transforms,
    sinks: { out: { type: 'file', path: path('output.jsonl'),
      inputs: committed.sinks['logs-store'].inputs.filter((input) => input !== 'collector-heartbeat'),
      encoding: { codec: 'json' } } },
  };
  writeFileSync(join(directory, 'vector.yaml'), YAML.stringify(config));
  let stop;
  try {
    stop = runner.startCollector({ directory, configName: 'vector.yaml', containerName: 'lifemodel-logs-throttle-check', env: {} });
    spawnSync('sleep', ['19']);
    stop();
    stop = undefined;
    const output = readFileSync(join(directory, 'output.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const counters = output.filter((row) => !Object.hasOwn(row, 'untrusted'));
    const logs = output.filter((row) => Object.hasOwn(row, 'untrusted'));
    assert.equal(logs.filter((row) => row.pod === 'trusted').length, 1600, 'trusted writer bypasses throttle');
    assert.equal(logs.filter((row) => row.pod === 'quiet').length, 20, 'quiet pod has its own quota');
    for (const log of logs) {
      for (const key of ['counter', 'value', 'window_start', 'window_end', 'collector_counter'])
        assert.equal(Object.hasOwn(log, key), false, `normalizer strips forged ${key}`);
    }
    for (const pod of ['flood-a', 'flood-b', 'quiet', 'zero']) {
      const pairs = new Map();
      for (const row of counters.filter((row) => row.pod === pod)) {
        assert.deepEqual(Object.keys(row).sort(), ['counter','module','namespace','pod','timestamp','value','window_end','window_start'].sort());
        assert.equal(row.module, 'throttle-window');
        assert.equal(row.namespace, 'lifemodel-motor');
        assert.equal(Date.parse(row.window_end) - Date.parse(row.window_start), 6000);
        assert.equal(Date.parse(row.window_start) % 6000, 0);
        assert.equal(row.timestamp, row.window_end);
        const pair = pairs.get(row.window_start) ?? {};
        assert.equal(pair[row.counter], undefined, 'one counter per window');
        pair[row.counter] = row.value;
        pairs.set(row.window_start, pair);
      }
      assert.ok(pairs.size > 0, `counter pair exists for ${pod}`);
      let input = 0;
      let accepted = 0;
      for (const pair of pairs.values()) {
        assert.ok(Number.isInteger(pair.input) && Number.isInteger(pair.accepted));
        assert.ok(pair.input >= pair.accepted);
        input += pair.input;
        accepted += pair.accepted;
      }
      assert.equal(input, pod === 'zero' ? 1 : pod === 'quiet' ? 20 : 1600);
      assert.equal(accepted, logs.filter((row) => row.pod === pod).length);
      if (pod.startsWith('flood')) {
        assert.ok(accepted >= 500, `${pod} has its own quota`);
        assert.ok(accepted < input, `${pod} flood is limited`);
      }
    }
    assert.equal(counters.some((row) => row.pod === 'trusted'), false);
    console.log('test collector throttle per pod, trusted bypass, counter pairs, zero seed and forgery ... passed');
  } finally {
    stop?.();
    rmSync(directory, { recursive: true, force: true });
  }
}
