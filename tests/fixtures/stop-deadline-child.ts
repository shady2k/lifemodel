/**
 * Child process fixture for the stop deadline (lifemodel-ctc.1.2).
 *
 * A REAL process with no other referenced handle: the reviewer's finding is
 * that an UNREF'D hard-exit timer lets Node leave with code 0 before the
 * deadline (a pending Promise keeps nothing alive). Run it through tsx:
 *
 *   tsx tests/fixtures/stop-deadline-child.ts hung   -> exits 1 at the deadline
 *   tsx tests/fixtures/stop-deadline-child.ts clean  -> exits 0, no hard exit
 *
 * Everything is written with writeSync(2, ...): a piped stderr may lose an
 * async write when process.exit follows it.
 */
import { writeSync } from 'node:fs';

import { armStopDeadlineExit } from '../../src/core/hard-exit.js';
import { shutdownSequence, type StopProgress } from '../../src/core/container.js';
import type { StopReport } from '../../src/core/core-loop.js';
import type { Logger } from '../../src/types/logger.js';

const BUDGET_MS = 250;
const mode = process.argv[2];

function say(line: string): void {
  writeSync(2, `${line}\n`);
}

const logger = {
  child: () => logger,
  info: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
  error: (obj: unknown, msg?: string) => {
    say(`HARD-EXIT ${JSON.stringify(obj)} ${msg ?? ''}`);
  },
} as unknown as Logger;

const report: StopReport = {
  loopStopped: false,
  tickInFlight: false,
  schedulerInFlight: false,
  turnInFlight: false,
  sendsOutstanding: 0,
  queuedSignals: 0,
};
const progress: StopProgress = { step: 'done' };
const coreLoop = {
  stop: async (): Promise<void> => undefined,
  stopReport: (): StopReport => report,
  closeDurableWrites: (): void => undefined,
};
const storage = { shutdown: async (): Promise<void> => undefined };
const stateManager = { shutdown: async (): Promise<void> => undefined };
const flush = { flush: async (): Promise<void> => undefined };

const armed = armStopDeadlineExit({
  logger,
  budgetMs: BUDGET_MS,
  pending: () => ({ step: progress.step, ...coreLoop.stopReport() }),
});

if (mode === 'hung') {
  // The intake stop NEVER returns. Nothing else in this process is referenced:
  // if the deadline timer is unref'd, Node leaves at once with code 0.
  const channel = {
    name: 'child',
    stopIntake: (): Promise<void> => new Promise<void>(() => undefined),
    stop: async (): Promise<void> => undefined,
  };
  void shutdownSequence({
    logger,
    deadline: Date.now() + BUDGET_MS,
    channels: [channel] as never,
    coreLoop: coreLoop as never,
    storage: storage as never,
    progress,
    stateManager: stateManager as never,
    recipientRegistry: flush as never,
    ackRegistry: flush as never,
  });
  say('ARMED-HUNG');
} else {
  const channel = {
    name: 'child',
    stopIntake: async (): Promise<void> => undefined,
    stop: async (): Promise<void> => undefined,
  };
  void (async () => {
    await shutdownSequence({
      logger,
      deadline: Date.now() + BUDGET_MS,
      channels: [channel] as never,
      coreLoop: coreLoop as never,
      storage: storage as never,
      progress,
      stateManager: stateManager as never,
      recipientRegistry: flush as never,
      ackRegistry: flush as never,
    });
    armed.disarm();
    say('DISARMED');
    // A REFERENCED handle keeps this process alive past the deadline: a timer
    // that was not disarmed would fire inside this window.
    setTimeout(() => {
      say('NO-FIRE');
      process.exit(0);
    }, BUDGET_MS * 3);
  })();
}
