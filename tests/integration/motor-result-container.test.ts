/**
 * The container re-emits a Motor Cortex result the pipeline never consumed
 * (lifemodel-ctc.1.2, review round 1 finding 3).
 *
 * The REAL container over a seeded data directory: a terminal run whose result
 * was never consumed is re-emitted into the loop's queue at start (recovery),
 * and nothing else delivers it. The other half of the chain - the loop reports
 * the signal only once a tick processed it, and the hook then marks the run
 * consumed - is pinned by tests/integration/signal-ack-after-processing.test.ts
 * and tests/integration/motor-result-restart.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createContainerAsync, type Container } from '../../src/core/container.js';
import type { MotorRun } from '../../src/runtime/motor-cortex/motor-protocol.js';

const quiet = {
  child: () => quiet,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
};

const scratch: string[] = [];
const containers: Container[] = [];

afterEach(async () => {
  for (const container of containers.splice(0)) {
    await container.shutdown().catch(() => undefined);
  }
  for (const dir of scratch.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  delete process.env['DATA_PATH'];
  vi.unstubAllGlobals();
});

/** A terminal run, as the completion path leaves it in the state file. */
function completedRun(id: string): MotorRun {
  const now = new Date().toISOString();
  return {
    id,
    status: 'completed',
    task: 'do the thing',
    tools: ['read'],
    attempts: [
      {
        id: `${id}-att0`,
        index: 0,
        status: 'completed',
        messages: [],
        stepCursor: 3,
        maxIterations: 20,
        startedAt: now,
        completedAt: now,
        trace: {
          runId: id,
          task: 'do the thing',
          status: 'completed',
          steps: [],
          totalIterations: 3,
          totalDurationMs: 1_000,
          totalEnergyCost: 0.1,
          llmCalls: 3,
          toolCalls: 2,
          errors: 0,
        },
      },
    ],
    currentAttemptIndex: 0,
    maxAttempts: 3,
    result: {
      ok: true,
      runId: id,
      summary: 'the thing is done',
      stats: { iterations: 3, durationMs: 1_000, energyCost: 0.1, errors: 0 },
    },
    startedAt: now,
    completedAt: now,
    energyConsumed: 0.1,
    config: { syntheticTools: [] },
  };
}

/** Seed the data directory: one unconsumed terminal run, marker already set. */
async function seedUnconsumedRun(dataPath: string, runId: string): Promise<void> {
  const statePath = join(dataPath, 'state');
  await mkdir(statePath, { recursive: true });
  await writeFile(
    join(statePath, 'motor-runs.json'),
    JSON.stringify({ runs: [completedRun(runId)] }),
    'utf-8'
  );
  // the result-consumption marker: this run is from AFTER the change, so its
  // missing resultConsumedAt means its result was really never consumed
  await writeFile(
    join(statePath, 'motor-result-consumption-migrated.json'),
    JSON.stringify({ at: new Date().toISOString() }),
    'utf-8'
  );
}

async function freshDataPath(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  process.env['DATA_PATH'] = dir;
  return dir;
}

describe(
  'container: a Motor Cortex result is consumed once (lifemodel-ctc.1.2)',
  { timeout: 60_000 },
  () => {
    it("re-emits an unconsumed terminal result into the loop's queue at start", async () => {
      const dataPath = await freshDataPath('ctc-motor-container-');
      await seedUnconsumedRun(dataPath, 'run-container-1');

      const container = await createContainerAsync({
        logDir: join(dataPath, 'logs'),
        logToFile: false,
        logger: quiet as never,
        // Motor Cortex exists only with an LLM provider configured. No call is
        // made here: the loop is never started, the test reads the queue.
        llm: { openRouterApiKey: 'test-key-not-used' },
      });
      containers.push(container);

      // the recovery re-emitted the result into the loop's queue, exactly once
      const queued = container.coreLoop.queuedSignalsForTest();
      const results = queued.filter((signal) => {
        const data = signal.data as { kind?: string; runId?: string } | undefined;
        return data?.kind === 'motor_result' && data.runId === 'run-container-1';
      });
      expect(results).toHaveLength(1);

      // nothing consumed it yet: the result waits in the queue
      expect(
        (await container.motorCortex?.getRunStatus('run-container-1'))?.resultConsumedAt
      ).toBeUndefined();

      // the container's hook is what marks it consumed, and the loop reports a
      // signal only once a tick processed it (tests/integration/
      // signal-ack-after-processing.test.ts pins that half; the queue above is
      // this container's half).
      await container.shutdown();
      const stored = JSON.parse(
        await readFile(join(dataPath, 'state', 'motor-runs.json'), 'utf-8')
      ) as { runs: MotorRun[] };
      expect(stored.runs[0]?.resultConsumedAt).toBeUndefined();
    });
  }
);
