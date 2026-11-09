#!/usr/bin/env node
/**
 * The collector's record contract (ADR-016 §2), checked with the pinned Vector
 * binary.
 *
 * The isolated test boundary has no Docker socket, so this check cannot run
 * inside it. Run it on the host, under the shared lock so it does not compete
 * for memory with a launcher run:
 *
 *   flock /work/check.lock node scripts/check-logs-vrl.mjs
 *
 * It extracts the remap program from deploy/platform/logs/config/vector.yaml
 * (the input of the collector's generated ConfigMap), builds
 * Vector unit tests from tests/fixtures/logs-vrl/cases.json, and runs them in
 * the digest-pinned image. It also feeds the REAL output of the core's logger
 * (pretty unset) and of the loader image's logger through the same program
 * (ADR-016 §9 points 1 and 2): those lines come from the seed
 * tests/fixtures/logs-vrl/real-logger-lines.ts run by tsx, so this needs the
 * checkout's node_modules. No cluster.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { realLoggerCases } from './logs-vrl-real-loggers.mjs';
import { checkCollectorHeartbeat } from './logs-heartbeat-check.mjs';

const IMAGE =
  'docker.io/timberio/vector@sha256:f6c23b5a7e16fb2838d33619ef7acf4bad2289a7cf22bc90efc2371f520c4ea2';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The configuration is the generator's input for the logs step's ConfigMap
// (deploy/platform/logs/kustomization.yaml); the pod mounts it as vector.yaml.
const configPath = join(root, 'deploy', 'platform', 'logs', 'config', 'vector.yaml');
const fixturePath = join(root, 'tests', 'fixtures', 'logs-vrl', 'cases.json');

/** The remap program is the `source` of the configuration's normalize transform. */
function extractProgram(text) {
  const config = YAML.parse(text);
  const source = config?.transforms?.normalize?.source;
  if (typeof source !== 'string')
    throw new Error(`${configPath}: the normalize transform has no remap source`);
  const program = source.trimEnd();
  for (const required of ['parse_json', 'strip_ansi_escape_codes', 'untrusted', 'conversation_id']) {
    if (!program.includes(required))
      throw new Error(`${configPath}: the remap program no longer contains ${required}`);
  }
  return program;
}

/** A VRL literal for a fixture value. JSON string escaping is valid VRL. */
function literal(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  throw new Error(`unsupported fixture value: ${JSON.stringify(value)}`);
}

function buildConfig(program, cases) {
  const tests = cases.map((testCase) => {
    const conditions = [
      // §2 makes the kubelet's CRI timestamp the record's time.
      ...(typeof testCase.input.timestamp === 'string'
        ? [`assert_eq!(.timestamp, ${literal(testCase.input.timestamp)})`]
        : ['assert_eq!(.timestamp == null, false)']),
      ...Object.entries(testCase.expect).map(
        ([field, value]) => `assert_eq!(.${field}, ${literal(value)})`
      ),
      ...(testCase.absent ?? []).map((field) => `assert_eq!(.${field}, null)`),
    ];
    return {
      name: testCase.name,
      inputs: [{ insert_at: 'normalize', type: 'log', log_fields: testCase.input }],
      outputs: [
        {
          extract_from: 'normalize',
          conditions: [{ type: 'vrl', source: conditions.join('\n') }],
        },
      ],
    };
  });
  return {
    data_dir: '/tmp/vector-test-data',
    transforms: { normalize: { type: 'remap', inputs: ['unused'], source: program } },
    tests,
  };
}

function main() {
  const program = extractProgram(readFileSync(configPath, 'utf8'));
  const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8'));
  if (!Array.isArray(fixtures.cases) || fixtures.cases.length === 0)
    throw new Error(`${fixturePath}: no cases`);
  const config = buildConfig(program, [...fixtures.cases, ...realLoggerCases()]);

  const directory = mkdtempSync(join(tmpdir(), 'lifemodel-logs-vrl-'));
  try {
    const configPath = join(directory, 'vector-test.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const result = spawnSync(
      'docker',
      ['run', '--rm', '-v', `${directory}:/work:ro`, IMAGE, 'test', '/work/vector-test.json'],
      { stdio: 'inherit' }
    );
    if (result.error) throw result.error;
    if ((result.status ?? 1) !== 0) return result.status ?? 1;
    // The heartbeat is proved by running the committed source, not by reading
    // it: its record's fields and cadence, and the read-back line through the
    // program the pod records use (ADR-016 §4, check L14).
    checkCollectorHeartbeat({ normalizeProgram: program });
    return 0;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`logs VRL check: ${error.message}`);
  process.exitCode = 2;
}
