#!/usr/bin/env node
/**
 * The collector's heartbeat (ADR-016 §4, check L14), proved with the pinned
 * Vector binary on this box's host.
 *
 * The heartbeat is one `demo_logs` event every 30 s with two destinations: the
 * store sink the pod records use, and a console sink on the collector's own
 * stdout, whose line the kubelet writes into this pod's log file and the file
 * source reads back. This check runs the committed source and transform for a
 * minute and asserts the record's fields and its cadence, then feeds a line it
 * actually emitted through the committed normalizing program and asserts the
 * read-back record names the heartbeat module. That is the wiring L14 walks on
 * a deployed build; it cannot be seen by reading the manifest.
 *
 * It is called by `scripts/check-logs-vrl.mjs`, which owns the run: the CI job
 * `ci-logs-vrl` on a pull request, and a person on the host with
 *
 *   flock /work/check.lock node scripts/check-logs-vrl.mjs
 *
 * The pinned binary runs natively when the runner names one (the CI job's check
 * image ships it) and in its image otherwise
 * (`scripts/logs-vector-runner.mjs`).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The configuration is the generator's input for the logs step's ConfigMap
// (deploy/platform/logs/kustomization.yaml); the pod mounts it as vector.yaml.
const configPath = join(root, 'deploy', 'platform', 'logs', 'config', 'vector.yaml');
const INTERVAL_SECONDS = 30;
/** Long enough for the first two beats: one at start, one a period later. */
const RUN_SECONDS = 65;
const CONTAINER = 'lifemodel-logs-heartbeat-check';

function fail(message) {
  throw new Error(message);
}

/** The collector's configuration, parsed. */
function collectorConfig() {
  const config = YAML.parse(readFileSync(configPath, 'utf8'));
  if (config?.sources === undefined || config?.sinks === undefined)
    fail(`${configPath}: the collector configuration is missing`);
  return config;
}

/** What the manifest must say about the heartbeat, before it is run. */
function assertWiring(config) {
  const source = config.sources?.['heartbeat'];
  if (!source) fail('the collector has no heartbeat source');
  if (source.type !== 'demo_logs') fail(`the heartbeat source is ${String(source.type)}`);
  if (Number(source.interval) !== INTERVAL_SECONDS)
    fail(`the heartbeat interval is ${String(source.interval)}, not ${String(INTERVAL_SECONDS)}`);

  const transform = config.transforms?.['collector-heartbeat'];
  if (!transform) fail('the collector has no collector-heartbeat transform');
  if (transform.type !== 'remap') fail(`the heartbeat transform is ${String(transform.type)}`);
  if (!(transform.inputs ?? []).includes('heartbeat'))
    fail('the heartbeat transform does not read the heartbeat source');
  for (const field of ['module', 'container', 'heartbeat']) {
    if (!String(transform.source ?? '').includes(`"${field}"`))
      fail(`the heartbeat record does not name ${field}`);
  }

  const store = config.sinks?.['logs-store'];
  if (!(store?.inputs ?? []).includes('collector-heartbeat'))
    fail('the store sink does not carry the heartbeat');
  if (!(store?.inputs ?? []).includes('normalize'))
    fail('the store sink no longer carries the pod records');

  const canary = config.sinks?.['heartbeat-canary'];
  if (canary?.type !== 'console') fail('the heartbeat has no console sink');
  if (canary.target !== 'stdout') fail('the heartbeat canary does not write to stdout');
  if (JSON.stringify(canary.inputs) !== JSON.stringify(['collector-heartbeat']))
    fail(
      `the canary carries ${JSON.stringify(canary.inputs)}, not only the heartbeat event`
    );
}

/** Runs the committed heartbeat source and transform for a period. */
function runHeartbeat(directory, runner) {
  const config = collectorConfig();
  // Where the runner reads a written config and its sink from: the mounted
  // directory for the binary, /work inside the pinned image.
  const base = runner.basePath(directory);
  const path = (name) => (base === directory ? join(directory, name) : `${base}/${name}`);
  const runConfig = {
    data_dir: path('data'),
    sources: { heartbeat: config.sources['heartbeat'] },
    transforms: { 'collector-heartbeat': config.transforms['collector-heartbeat'] },
    sinks: {
      out: {
        type: 'file',
        path: path('heartbeat.jsonl'),
        inputs: ['collector-heartbeat'],
        encoding: { codec: 'json' },
      },
    },
  };
  writeFileSync(join(directory, 'vector.yaml'), YAML.stringify(runConfig));
  const stop = runner.startCollector({
    directory,
    configName: 'vector.yaml',
    containerName: CONTAINER,
    env: { VECTOR_SELF_NODE_NAME: 'node1' },
  });
  try {
    spawnSync('sleep', [String(RUN_SECONDS)]);
  } finally {
    stop();
  }
  return readFileSync(join(directory, 'heartbeat.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/** The record a heartbeat line must be, and one beat per period. */
function assertRecords(records) {
  if (records.length < 2)
    fail(`the collector emitted ${String(records.length)} heartbeat records in ${String(RUN_SECONDS)} s`);
  for (const record of records) {
    for (const [field, value] of Object.entries({
      module: 'collector-heartbeat',
      container: 'collector-heartbeat',
      namespace: 'lifemodel-logs',
      level: 'info',
      pod: '',
      stream: 'heartbeat',
      heartbeat: true,
    })) {
      if (record[field] !== value)
        fail(`a heartbeat record has ${field}=${JSON.stringify(record[field])}, not ${JSON.stringify(value)}`);
    }
    const at = Date.parse(record.timestamp);
    if (Number.isNaN(at)) fail(`a heartbeat record has no readable timestamp: ${String(record.timestamp)}`);
  }
  return records;
}

/** The read-back line through the committed normalizing program. */
function assertReadBack(directory, records, program, runner) {
  const line = JSON.stringify(records[0]);
  const kubernetes = (namespace) => ({
    pod_name: 'logs-collector-x2k9',
    pod_namespace: namespace,
    container_name: 'logs-collector',
    pod_node_name: 'node1',
    pod_labels: { 'app.kubernetes.io/name': 'logs-collector' },
  });
  const input = {
    timestamp: '2026-11-07T10:59:30.000000000Z',
    stream: 'stdout',
    message: line,
  };
  const condition = (checks) => [
    {
      extract_from: 'normalize',
      conditions: [{ type: 'vrl', source: checks.join('\n') }],
    },
  ];
  const config = {
    data_dir: '/work/data',
    transforms: { normalize: { type: 'remap', inputs: ['unused'], source: program } },
    tests: [
      {
        name: 'collector-heartbeat-read-back',
        inputs: [{ insert_at: 'normalize', type: 'log', log_fields: { ...input, kubernetes: kubernetes('lifemodel-logs') } }],
        outputs: condition([
          'assert_eq!(.module, "collector-heartbeat")',
          'assert_eq!(.pod, "logs-collector-x2k9")',
          'assert_eq!(.namespace, "lifemodel-logs")',
          'assert_eq!(.level, "info")',
          'assert!(contains(string!(.message), "collector heartbeat"))',
        ]),
      },
      {
        name: 'another-namespace-cannot-claim-the-heartbeat',
        inputs: [{ insert_at: 'normalize', type: 'log', log_fields: { ...input, kubernetes: kubernetes('lifemodel-motor') } }],
        outputs: condition([
          'assert_eq!(.module, "logs-collector")',
          'assert_eq!(.untrusted, true)',
        ]),
      },
    ],
  };
  writeFileSync(join(directory, 'read-back.json'), JSON.stringify(config, null, 2));
  const result = runner.test(directory, 'read-back.json');
  if (result.error) throw result.error;
  if (config.tests.length !== 2) fail('the read-back check lost a case');
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 0) fail(`the read-back did not pass:\n${output.trim()}`);
  return output;
}

/**
 * Runs the heartbeat end to end as far as a host without a cluster allows:
 * the committed source and transform, the committed normalizing program, and
 * the fields the page's two queries select.
 */
export function checkCollectorHeartbeat({ normalizeProgram, runner }) {
  assertWiring(collectorConfig());
  console.log('test heartbeat wiring (manifest) ... passed');
  const directory = mkdtempSync(join(tmpdir(), 'lifemodel-logs-heartbeat-'));
  try {
    const records = assertRecords(runHeartbeat(directory, runner));
    console.log(
      `test heartbeat cadence and record (${String(records.length)} records in ${String(RUN_SECONDS)} s) ... passed`
    );
    const readBack = assertReadBack(directory, records, normalizeProgram, runner);
    for (const line of readBack.split('\n').filter((entry) => entry.includes('... passed')))
      console.log(line.replace(/^test /, 'test heartbeat '));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
