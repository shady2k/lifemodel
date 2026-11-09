/**
 * The real logger lines a cluster module writes, as cases for the collector's
 * VRL (ADR-016 §9 points 1 and 2, check L02).
 *
 * Two defects this catches that no hand-written fixture can: the core's stdout
 * in the cluster must be JSON, not coloured pino-pretty text (a coloured line's
 * level word is not found by the VRL's text-word rule, so the page shows
 * `unknown`), and the loader image's line must carry no `component` because the
 * pod's own label names the module (§2).
 *
 * The lines come from the real loggers, through the seed
 * `tests/fixtures/logs-vrl/real-logger-lines.ts` run by tsx: this needs the
 * checkout's `node_modules`. `scripts/check-logs-vrl.mjs` calls it from the
 * host, where Docker and the pinned Vector binary live.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seed = join(root, 'tests', 'fixtures', 'logs-vrl', 'real-logger-lines.ts');
const loaderMain = join(root, 'loader', 'src', 'main.ts');

/** The kubelet's own timestamp, which the collector makes the record's time. */
const TIMESTAMP = '2026-11-07T10:00:00.000000000Z';

/**
 * The loader image runs the model gateway, the storage module and the task
 * launcher; each is named by its pod label (§2), never by a fixed component.
 */
const LOADER_MODULE = 'model-gateway';

const LEVEL_NUMBERS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

function run(args, env) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: env ?? process.env,
  });
  if (result.error) throw result.error;
  return result;
}

/** The records the seed logs, at the levels the page filters on. */
export function realLoggerPlan() {
  const result = run(['--import', 'tsx', seed, 'plan']);
  if (result.status !== 0) throw new Error(`the logger seed did not plan: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout).records;
}

/**
 * One stdout line per record. A formatter that writes a record over several
 * lines makes the collector store several records for one event, so the count
 * is part of the contract, not a convenience.
 */
export function realLoggerLines(mode) {
  const plan = realLoggerPlan();
  const result = run(['--import', 'tsx', seed, mode]);
  if (result.status !== 0) throw new Error(`the ${mode} logger did not run: ${result.stderr.trim()}`);
  const lines = result.stdout.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== plan.length) {
    throw new Error(
      `the ${mode} logger wrote ${String(lines.length)} stdout lines for ${String(plan.length)} records: one record became several`
    );
  }
  return { plan, lines };
}

/** The loader image's fatal line, written to stderr when its config is invalid. */
export function loaderFatalLine() {
  const result = run(['--import', 'tsx', loaderMain], {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '',
  });
  if (result.status !== 1) {
    throw new Error(`the loader exited ${String(result.status)}: ${result.stderr}`.slice(0, 400));
  }
  const lines = result.stderr.split('\n').filter((line) => line.trim() !== '');
  if (lines.length !== 1) {
    throw new Error(`the loader's fatal record took ${String(lines.length)} lines`);
  }
  return lines[0];
}

function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** The line's own fields must name a level and must not claim a module. */
function assertJsonLine(mode, line, record) {
  const object = parse(line);
  if (object === null) return null;
  if ('component' in object) {
    throw new Error(`the ${mode} line still carries component=${JSON.stringify(object.component)}`);
  }
  if (object.msg !== record.message) {
    throw new Error(
      `the ${mode} line's msg is ${JSON.stringify(object.msg)}, not ${JSON.stringify(record.message)}`
    );
  }
  if (object.level !== record.level && object.level !== LEVEL_NUMBERS[record.level]) {
    throw new Error(
      `the ${mode} line's level is ${JSON.stringify(object.level)}, not ${record.level} or ${String(LEVEL_NUMBERS[record.level])}`
    );
  }
  return object;
}

function caseFor(module, name, line, index, expect, stream = 'stdout') {
  const pod = `${module}-real-${String(index)}`;
  return {
    name: `real-${module}-${name}`,
    input: {
      timestamp: TIMESTAMP,
      stream,
      message: line,
      kubernetes: {
        pod_name: pod,
        pod_namespace: 'lifemodel-system',
        container_name: module,
        pod_node_name: 'lifemodel',
        pod_labels: { 'app.kubernetes.io/name': module },
      },
    },
    expect: {
      module,
      namespace: 'lifemodel-system',
      pod,
      container: module,
      stream,
      untrusted: false,
      ...expect,
    },
  };
}

/** The cases `scripts/check-logs-vrl.mjs` adds to its hand-written fixtures. */
export function realLoggerCases() {
  const cases = [];
  for (const [mode, module] of [
    ['core', 'core'],
    ['loader', LOADER_MODULE],
  ]) {
    const { plan, lines } = realLoggerLines(mode);
    lines.forEach((line, index) => {
      const record = plan[index];
      assertJsonLine(mode, line, record);
      // The record's message is the line with ANSI stripped (§2), so a line
      // that regressed to pretty text fails on its LEVEL (a coloured level word
      // is not found), not only on a literal it cannot build.
      cases.push(
        caseFor(module, record.level, line, index, {
          level: record.level,
          message: stripVTControlCharacters(line),
        })
      );
    });
  }
  // The loader image's fatal line, written before anything else is up.
  const fatal = loaderFatalLine();
  const fatalObject = parse(fatal);
  if (fatalObject === null) throw new Error("the loader's fatal record is not JSON");
  if ('component' in fatalObject) {
    throw new Error(
      `the loader's fatal record still carries component=${JSON.stringify(fatalObject.component)}`
    );
  }
  if (fatalObject.level !== 'error') {
    throw new Error(`the loader's fatal record's level is ${JSON.stringify(fatalObject.level)}`);
  }
  cases.push(
    caseFor(LOADER_MODULE, 'fatal', fatal, 9, { level: 'error', message: fatal }, 'stderr')
  );
  // Pretty output stays a development choice: an explicitly pretty run prints
  // readable text (ANSI is stripped) over one line per record. Its level word
  // sits behind a colour escape, so its level is not part of the cluster
  // contract; the JSON default above is.
  const pretty = realLoggerLines('core-pretty');
  pretty.lines.forEach((line, index) => {
    if (parse(line) !== null) throw new Error('the pretty core logger wrote JSON, not pretty text');
    cases.push(
      caseFor('core', `pretty-${String(index)}`, line, index, {
        message: stripVTControlCharacters(line),
      })
    );
  });
  return cases;
}
