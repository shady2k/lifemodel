/**
 * Motor Cortex results across a stop (lifemodel-ctc.1.2, review round 1
 * finding 3).
 *
 * A run result is NOT regenerable by later ticks: a terminal run whose result
 * the pipeline never consumed - the stop dropped its queued signal, the process
 * died before a tick processed it - is re-emitted exactly once at the next
 * start. A result that WAS processed is marked consumed and never re-delivered
 * (CoreLoop calls acknowledgeResultProcessed through the container's
 * onSignalProcessed hook).
 *
 * Real MotorCortex + real MotorStateManager over real storage (JSONStorage
 * behind DeferredStorage). No run is executed: the terminal run is seeded the
 * way a completion leaves it.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createAgent } from '../../src/core/agent.js';
import { createMetrics } from '../../src/core/metrics.js';
import {
  createMotorCortex,
  type MotorCortex,
} from '../../src/runtime/motor-cortex/motor-cortex.js';
import {
  createMotorStateManager,
  type MotorStateManager,
} from '../../src/runtime/motor-cortex/motor-state.js';
import type { MotorRun } from '../../src/runtime/motor-cortex/motor-protocol.js';
import type { Signal } from '../../src/types/signal.js';

import type { DeferredStorage } from '../../src/storage/index.js';
import type { Logger } from '../../src/types/logger.js';

import { makeScratchDir, openStorage, rmDir } from '../helpers/core-loop-drain-harness.js';
import { createTestLogger } from '../helpers/test-logger.js';

const scratchRoots: string[] = [];

async function fresh(prefix: string): Promise<string> {
  const root = await makeScratchDir(prefix);
  scratchRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) {
    await rmDir(root);
  }
});

/** A terminal run, as the completion path leaves it in storage. */
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

interface MotorInstance {
  motor: MotorCortex;
  signals: Signal[];
}

/**
 * One "process": a MotorCortex over the SHARED storage handle (what the
 * container passes - its motor cortex, state manager and everything else write
 * through the one DeferredStorage), with its signals collected.
 */
async function startMotor(storage: DeferredStorage, logger: Logger): Promise<MotorInstance> {
  const motor = createMotorCortex({
    llm: {} as never,
    storage,
    logger,
    energyModel: createAgent({
      logger: logger as never,
      metrics: createMetrics(),
    }).getEnergyModel(),
  });
  const signals: Signal[] = [];
  motor.setSignalCallback((signal) => signals.push(signal));
  return { motor, signals };
}

/** The pieces of one test: one storage handle, one logger, one state manager. */
async function openCase(storagePath: string): Promise<{
  storage: DeferredStorage;
  logger: Logger;
  stateManager: MotorStateManager;
}> {
  const logger = createTestLogger('warn');
  const storage = await openStorage(storagePath, logger);
  return { storage, logger, stateManager: createMotorStateManager(storage, logger) };
}

/** What a stop does to a result signal that was never processed: nothing. */
function resultSignals(signals: Signal[], runId: string): Signal[] {
  return signals.filter((signal) => {
    const data = signal.data as { kind?: string; runId?: string } | undefined;
    return data?.kind === 'motor_result' && data.runId === runId;
  });
}

describe('Motor Cortex results across a stop (lifemodel-ctc.1.2)', () => {
  it('re-emits the result of an unconsumed terminal run, and only until it is consumed', async () => {
    const storagePath = await fresh('ctc-motor-');
    const { storage, logger, stateManager } = await openCase(storagePath);

    // 1st start: nothing to recover, but the result-consumption marker is set
    // (runs from before it are not evidence of an unconsumed result).
    const first = await startMotor(storage, logger);
    await first.motor.recoverOnRestart();
    expect(first.signals).toEqual([]);

    // a run completes while COGNITION is busy: its result is queued, deferred,
    // and the stop drops it - so it is never consumed
    await stateManager.createRun(completedRun('run-1'));

    // 2nd start: the result is re-emitted exactly once
    const second = await startMotor(storage, logger);
    await second.motor.recoverOnRestart();
    expect(resultSignals(second.signals, 'run-1')).toHaveLength(1);
    const data = resultSignals(second.signals, 'run-1')[0]!.data as {
      status: string;
      isRecovery?: boolean;
      result?: { summary: string };
    };
    expect(data.status).toBe('completed');
    expect(data.isRecovery).toBe(true);
    expect(data.result?.summary).toBe('the thing is done');

    // the pipeline processed it: the run is consumed
    await second.motor.acknowledgeResultProcessed('run-1');
    expect((await stateManager.getRun('run-1'))?.resultConsumedAt).toBeDefined();

    // 3rd start: nothing is delivered again
    const third = await startMotor(storage, logger);
    await third.motor.recoverOnRestart();
    expect(resultSignals(third.signals, 'run-1')).toHaveLength(0);
  });

  it('re-emits a terminal result again when the process dies before it was consumed', async () => {
    const storagePath = await fresh('ctc-motor-die-');
    const { storage, logger, stateManager } = await openCase(storagePath);

    const first = await startMotor(storage, logger);
    await first.motor.recoverOnRestart();
    await stateManager.createRun(completedRun('run-2'));

    // a start that re-emits and then dies (no acknowledgement, no stop)
    const second = await startMotor(storage, logger);
    await second.motor.recoverOnRestart();
    expect(resultSignals(second.signals, 'run-2')).toHaveLength(1);

    const third = await startMotor(storage, logger);
    await third.motor.recoverOnRestart();
    expect(resultSignals(third.signals, 'run-2')).toHaveLength(1);

    // and once consumed, never again
    await third.motor.acknowledgeResultProcessed('run-2');
    const fourth = await startMotor(storage, logger);
    await fourth.motor.recoverOnRestart();
    expect(resultSignals(fourth.signals, 'run-2')).toHaveLength(0);
  });

  it('does not re-deliver terminal runs that predate the result-consumption marker', async () => {
    const storagePath = await fresh('ctc-motor-migrate-');
    const { storage, logger, stateManager } = await openCase(storagePath);

    // A run from the version before the marker: its result WAS delivered then,
    // so a missing marker is not evidence of an unconsumed result.
    await stateManager.createRun(completedRun('run-old'));

    const first = await startMotor(storage, logger);
    await first.motor.recoverOnRestart();
    expect(resultSignals(first.signals, 'run-old')).toHaveLength(0);
    expect((await stateManager.getRun('run-old'))?.resultConsumedAt).toBeDefined();

    // and a NEW run after the marker is still re-delivered when unconsumed
    await stateManager.createRun(completedRun('run-new'));
    const second = await startMotor(storage, logger);
    await second.motor.recoverOnRestart();
    expect(resultSignals(second.signals, 'run-new')).toHaveLength(1);
  });

  it('acknowledges only terminal runs, and only once', async () => {
    const storagePath = await fresh('ctc-motor-ack-');
    const { storage, logger, stateManager } = await openCase(storagePath);
    await stateManager.createRun(completedRun('run-3'));

    const instance = await startMotor(storage, logger);
    await instance.motor.acknowledgeResultProcessed('run-3');
    const consumed = (await stateManager.getRun('run-3'))?.resultConsumedAt;
    expect(consumed).toBeDefined();

    // a second acknowledgement keeps the first timestamp
    await instance.motor.acknowledgeResultProcessed('run-3');
    expect((await stateManager.getRun('run-3'))?.resultConsumedAt).toBe(consumed);

    // an unknown run is ignored, never created
    await instance.motor.acknowledgeResultProcessed('never-existed');
    expect(await stateManager.getRun('never-existed')).toBeNull();
  });
});
