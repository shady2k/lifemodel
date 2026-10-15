/** Process-level regression for fatal stops through the entrypoint coordinator. */
import { createServer } from 'node:http';
import { writeSync } from 'node:fs';

import type { StopTargets } from '../../src/index.js';
import type { Logger } from '../../src/types/logger.js';

process.env['LIFEMODEL_ENTRYPOINT_AUTOSTART'] = '0';
const { boundStopContainer, runStopSequence } = await import('../../src/index.js');
const mode = process.argv[2];
const logger = {
  child: () => logger,
  info: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
  error: (_obj: unknown, msg?: string) => writeSync(2, `${msg ?? ''}\n`),
} as unknown as Logger;
const coreLoop = {
  getStopDrainTimeoutMs: () => 200,
  stopReport: () => ({
    loopStopped: false,
    tickInFlight: false,
    schedulerInFlight: false,
    turnInFlight: false,
    sendsOutstanding: 0,
    queuedSignals: 0,
  }),
};
const active: StopTargets = {
  logger,
  coreLoop,
  stopProgress: () => 'registry_flush',
  shutdown: () => (mode === 'stalled' ? new Promise<void>(() => undefined) : Promise.resolve()),
};
boundStopContainer(active as never);
const listener = createServer();
listener.listen(0, '127.0.0.1', () => {
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('listener did not bind');
  writeSync(1, `LISTENING ${address.port}\n`);
  void runStopSequence({
    reason: 'fatal normalization',
    code: 1,
    error: new Error('fatal'),
    container: active,
  });
});
