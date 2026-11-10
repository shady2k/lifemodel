/**
 * Check L02's record-shape cases (ADR-016 §2 and §9 point 4), built from the
 * real turn's own lines, and the run through the collector's real VRL program
 * with the pinned Vector binary.
 *
 * The runner (`scripts/logs-vector-runner.mjs`) is the pinned binary itself when
 * `LIFEMODEL_VECTOR_BIN` names one - the CI job's check image ships it
 * (`docker/logs-vrl/Dockerfile`) - and otherwise the Docker CLI with the
 * digest-pinned image.
 *
 * Neither is reachable from the isolated test boundary (it mounts no Docker
 * socket and attaches the test container to no network), so
 * `tests/unit/logs-record-shape.test.ts` asserts the lines themselves there and
 * prints why the VRL half did not run. The CI job `ci-logs-vrl` runs the whole
 * case list on the GitHub runner for a change that touches what it reads, and a
 * person can run it on the host with:
 *
 *   flock /work/check.lock node scripts/check-logs-vrl.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import YAML from 'yaml';

/** The generator's input for the logs step's ConfigMap; the pod mounts it. */
export const COLLECTOR_CONFIG = 'deploy/platform/logs/config/vector.yaml';

const TURN_SEED = 'tests/fixtures/logs-vrl/turn-record-lines.ts';
const TIMESTAMP = '2026-11-07T10:00:00.000000000Z';
const PINO_LEVELS = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
/** The turn's own outcome line: it names the span the turn's lines share. */
const TURN_OUTCOME = '🔄 Agent turn complete';

/** The remap program is the `source` of the configuration's normalize transform. */
export function collectorProgram(root = process.cwd()) {
  const path = join(root, COLLECTOR_CONFIG);
  const config = YAML.parse(readFileSync(path, 'utf8'));
  const source = config?.transforms?.normalize?.source;
  if (typeof source !== 'string')
    throw new Error(`${path}: the normalize transform has no remap source`);
  const program = source.trimEnd();
  for (const required of ['parse_json', 'strip_ansi_escape_codes', 'untrusted', 'conversation_id']) {
    if (!program.includes(required)) {
      throw new Error(`${path}: the remap program no longer contains ${required}`);
    }
  }
  return program;
}

function seed(args, root) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', join(root, TURN_SEED), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`the real turn seed failed (${String(result.status)}): ${result.stderr.trim().slice(0, 2000)}`);
  }
  return result.stdout;
}

/** One record per stdout line: the collector stores one record per line. */
function records(stdout) {
  const lines = stdout.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`stdout line ${String(index)} is not one JSON record: ${line.slice(0, 200)}`);
    }
  });
}

/**
 * The real lines of a turn, produced by the core's own logger through the real
 * CoreLoop and the real cognition processor (only the LLM provider is
 * scripted): `reply` carries its own recipientId, `thought` has none and must
 * fall back to the primary recipient. `levels` is one record per pino level.
 */
export function turnRecordRuns(root = process.cwd()) {
  const runs = { levels: records(seed(['levels'], root)) };
  for (const mode of ['reply', 'thought']) {
    const resultDirectory = mkdtempSync(join(tmpdir(), 'lifemodel-l02-result-'));
    const resultPath = join(resultDirectory, 'result.json');
    try {
      runs[mode] = {
        lines: records(seed([mode, '--result', resultPath], root)),
        result: JSON.parse(readFileSync(resultPath, 'utf8')),
      };
    } finally {
      rmSync(dirname(resultPath), { recursive: true, force: true });
    }
  }
  return runs;
}

/** How a record's fields are asserted: the fixture value must be found. */
function caseFor(name, line, { module, level, conversationId, absent = [] }) {
  return {
    name,
    input: {
      timestamp: TIMESTAMP,
      stream: 'stdout',
      message: line,
      kubernetes: {
        pod_name: `${module}-l02`,
        pod_namespace: 'lifemodel-system',
        container_name: module,
        pod_node_name: 'lifemodel',
        pod_labels: { 'app.kubernetes.io/name': module },
      },
    },
    expect: {
      module,
      namespace: 'lifemodel-system',
      pod: `${module}-l02`,
      container: module,
      stream: 'stdout',
      untrusted: false,
      level,
      message: line,
      ...(conversationId === undefined ? {} : { conversation_id: conversationId }),
    },
    absent,
  };
}

/**
 * The lines the turn itself wrote: the trigger's trace under the turn's own
 * span. The signal's normalization shares the trace id (it runs before the
 * turn), so the span is what separates the two.
 */
export function turnLines(run) {
  const outcome = run.lines.find(
    (line) => line.traceId === run.result.triggerSignalId && line.msg === TURN_OUTCOME
  );
  if (outcome === undefined) {
    throw new Error(`the ${run.result.triggerType} turn wrote no ${JSON.stringify(TURN_OUTCOME)} line`);
  }
  return run.lines.filter(
    (line) => line.traceId === run.result.triggerSignalId && line.spanId === outcome.spanId
  );
}

/** The first line a tick itself wrote (its span is the loop's tick span). */
export function tickLine(run) {
  const line = run.lines.find((candidate) => String(candidate.spanId ?? '').startsWith('tick_'));
  if (line === undefined) throw new Error('the run wrote no tick-level line');
  return line;
}

/**
 * L02's turn fixtures: the lines of a reply turn and of a recipient-less
 * `thought` turn, each under the conversation the turn ran for, and the tick
 * line that must carry none. Every level comes from the real logger too.
 */
export function recordShapeCases(runs) {
  const cases = [];
  for (const mode of ['reply', 'thought']) {
    const { result } = runs[mode];
    const turn = turnLines(runs[mode]);
    for (const [index, line] of turn.entries()) {
      // The expectation comes from the conversation the TURN ran for, never
      // from the line: a line that dropped the key (or spelled it camelCase)
      // must fail in the collector, not be read as "no conversation".
      cases.push(
        caseFor(`turn-${mode}-${String(index)}`, JSON.stringify(line), {
          module: 'core',
          level: PINO_LEVELS[line.level],
          conversationId: result.conversationId,
        })
      );
    }
    const outside = tickLine(runs[mode]);
    cases.push(
      caseFor(`turn-${mode}-tick-line`, JSON.stringify(outside), {
        module: 'core',
        level: PINO_LEVELS[outside.level],
        absent: ['conversation_id'],
      })
    );
  }
  for (const [index, line] of runs.levels.entries()) {
    cases.push(
      caseFor(`pino-level-${String(index)}`, JSON.stringify(line), {
        module: 'core',
        level: PINO_LEVELS[line.level],
        absent: ['conversation_id'],
      })
    );
  }
  return cases;
}

/** A VRL literal for a fixture value. JSON string escaping is valid VRL. */
function literal(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  throw new Error(`unsupported fixture value: ${JSON.stringify(value)}`);
}

/** Vector's unit-test configuration: the committed program, one case each. */
export function buildVectorTestConfig(program, cases) {
  const tests = cases.map((testCase) => {
    const conditions = [
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
        { extract_from: 'normalize', conditions: [{ type: 'vrl', source: conditions.join('\n') }] },
      ],
    };
  });
  return {
    data_dir: '/tmp/vector-test-data',
    transforms: { normalize: { type: 'remap', inputs: ['unused'], source: program } },
    tests,
  };
}

/** Run the cases through the program: the collector's own verdict. */
export function runVrlCases(cases, runner) {
  const program = collectorProgram();
  const directory = mkdtempSync(join(tmpdir(), 'lifemodel-logs-record-'));
  try {
    const name = 'vector-test.json';
    writeFileSync(join(directory, name), JSON.stringify(buildVectorTestConfig(program, cases), null, 2));
    const result = runner.test(directory, name);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    return { ok: result.error === undefined && result.status === 0, output, cases: cases.length };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
