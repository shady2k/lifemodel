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
 * (the input of the collector's generated ConfigMap), builds Vector unit tests
 * from tests/fixtures/logs-vrl/cases.json, and runs them in the digest-pinned
 * image or a `vector` binary named by `LIFEMODEL_VECTOR_BIN`
 * (`scripts/logs-vector-runner.mjs`; `scripts/logs-record-shape.mjs` owns the
 * run, so the suite's own record-shape check exercises the same code). It also
 * feeds the REAL output of the core's logger (pretty unset) and of the loader
 * image's logger through the same program (ADR-016 §9 points 1 and 2): those
 * lines come from the seed tests/fixtures/logs-vrl/real-logger-lines.ts run by
 * tsx, so this needs the checkout's node_modules. The CI job `ci-logs-vrl`
 * runs this script inside its check image, which carries both (no Docker socket
 * there); on the host the image is started through the Docker CLI.
 *
 * Then the turn's own lines (ADR-016 §9 point 4, check L02): a reply turn and a
 * recipient-less `thought` turn, written by the real CoreLoop and the real
 * cognition processor with the core's pino logger
 * (tests/fixtures/logs-vrl/turn-record-lines.ts). Each must store under the
 * conversation the turn ran for, and a tick-level line under none. No cluster.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectorProgram,
  recordShapeCases,
  runVrlCases,
  turnRecordRuns,
} from './logs-record-shape.mjs';
import { vectorRunner } from './logs-vector-runner.mjs';
import { realLoggerCases } from './logs-vrl-real-loggers.mjs';
import { checkCollectorHeartbeat } from './logs-heartbeat-check.mjs';
import { checkCollectorThrottle } from '../tests/fixtures/logs-vrl/throttle-check.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = join(root, 'tests', 'fixtures', 'logs-vrl', 'cases.json');

function main() {
  const runner = vectorRunner();
  if (!runner) {
    console.error(
      'logs VRL check: no VRL runner here. Set LIFEMODEL_VECTOR_BIN to a vector binary, ' +
        'or make the Docker CLI reach its daemon (the pinned image is pulled for it).'
    );
    return 2;
  }
  process.chdir(root);
  const program = collectorProgram(root);
  const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8'));
  if (!Array.isArray(fixtures.cases) || fixtures.cases.length === 0)
    throw new Error(`${fixturePath}: no cases`);
  const cases = [
    ...fixtures.cases,
    ...realLoggerCases(),
    ...recordShapeCases(turnRecordRuns(root)),
  ];
  console.log(`logs VRL check: ${String(cases.length)} cases through ${runner.label}`);
  const result = runVrlCases(cases, runner);
  if (result.output) console.log(result.output);
  if (!result.ok) {
    console.error('logs VRL check: the collector did not store the contract');
    return 1;
  }
  // The heartbeat is proved by running the committed source, not by reading
  // it: its record's fields and cadence, and the read-back line through the
  // program the pod records use (ADR-016 §4, check L14).
  checkCollectorThrottle({ runner });
  checkCollectorHeartbeat({ normalizeProgram: program, runner });
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`logs VRL check: ${error.message}`);
  process.exitCode = 2;
}
