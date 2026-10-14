/**
 * Lifemodel - Human-like proactive AI agent
 *
 * Entry point for the application.
 */

import 'dotenv/config';

import {
  createContainerAsync,
  createSettingsReloadHandler,
  type Container,
  type StopStep,
} from './core/container.js';
import type { StopReport } from './core/core-loop.js';
import { armStopDeadlineExit, type ArmedStopDeadlineExit } from './core/hard-exit.js';
import {
  createSettingsServer,
  type SettingsServer,
  type SettingsServerOptions,
} from './settings/server.js';

let container: Container | undefined;
let settingsServer: SettingsServer | undefined;
let isShuttingDown = false;

async function main(): Promise<void> {
  // Create the application container with async initialization
  // This loads config, initializes storage, and restores state
  const active = await createContainerAsync();
  boundStopContainer(active);
  container = active;

  const { logger, agent, coreLoop, stateManager } = container;

  // lifemodel's own settings interface, on the port Caddy's root host reaches
  // (127.0.0.1:7100). It is started BEFORE the loop, so the instance is
  // configurable even when nothing else works yet - on the first start of an
  // instance the configuration document is empty, and this page is how it gets filled.
  await startSettingsInterface(logger, {
    config: container.configLoader,
    onSaved: createSettingsReloadHandler(container),
  });

  logger.info('Lifemodel starting...');
  logger.info(
    {
      name: agent.getName(),
      energy: agent.getEnergy(),
      mode: agent.getAlertnessMode(),
      state: agent.getState(),
    },
    'Agent ready'
  );

  // Log persistence status
  if (stateManager) {
    logger.info('State persistence enabled (auto-save every 5 minutes)');
  }

  // This core has no delivery channel; outbound events remain committed for the gateway.

  // Start the core loop (heartbeat)
  coreLoop.start();
}

/**
 * The container surface the stop coordinator must reach, named narrowly so
 * the same call drives a real stop and a test's CONTROLLED boundary (review
 * round 2, finding I: the stop order below is product code, not a fixture
 * copy).
 */
export interface StopTargets {
  logger: Container['logger'];
  coreLoop: { getStopDrainTimeoutMs(): number; stopReport(): StopReport };
  stopProgress: () => StopStep;
  shutdown: () => Promise<void>;
}

/**
 * The settings interface a test drives from the SAME wiring the real start
 * uses. `main()` awaits it; the returned server (or `settingsAddress()`)
 * carries its port.
 */
export interface SettingsStartOptions {
  config: SettingsServerOptions['config'];
  onSaved: SettingsServerOptions['onSaved'];
  onConnection?: SettingsServerOptions['onConnection'];
  closeGraceMs?: number;
  port?: number;
}

/**
 * Start lifemodel's settings interface (lifemodel-q4x.4.1).
 *
 * A port that cannot be taken is NOT fatal: lifemodel keeps running and says so
 * at error level, because exiting here would turn one bad input into a restart
 * loop the loader would count as deaths (AGENTS.md, lesson 3: the same input
 * fails the same way every time - the owner is told instead).
 */
export async function startSettingsInterface(
  logger: Container['logger'],
  options: SettingsStartOptions
): Promise<SettingsServer> {
  const server = createSettingsServer({
    config: options.config,
    logger,
    onSaved: options.onSaved,
    ...(options.port !== undefined && { port: options.port }),
    ...(options.closeGraceMs !== undefined && { closeGraceMs: options.closeGraceMs }),
    ...(options.onConnection !== undefined && { onConnection: options.onConnection }),
  });
  settingsServer = server;
  try {
    await server.listen();
    logger.info({ address: server.address() }, "lifemodel's settings interface is up");
  } catch (error) {
    logger.error(
      { address: server.address(), error: error instanceof Error ? error.message : String(error) },
      "lifemodel's settings interface could not listen: the instance runs, but its settings page does not"
    );
  }
  return server;
}

/**
 * The container the stop below drains. The real start sets the container it
 * built; a test resets the boundary with its controlled double (finding I).
 */
export function boundStopContainer(active: Container): void {
  container = active;
}

/**
 * ONE stop runs here whatever asks for it, on the container the start bound
 * (`boundStopContainer`) and the settings server the start opened. A signal, a
 * crash, or the settings page reaches the SAME coordination: `stopAndLeave`
 * only carries the dedup flag; the DEADLINE-FIRST ORDER below is the product
 * path, and a test drives exactly it (review round 2, finding I: a fixture
 * that re-typed the order proved nothing about this sequence).
 */
export async function runStopSequence(options: {
  reason: string;
  code: number;
  error?: unknown;
  container?: StopTargets | undefined;
  settingsServer?: SettingsServer | undefined;
}): Promise<void> {
  const { reason, code, error } = options;
  const active = options.container;

  // The ONE stop deadline is ARMED FIRST, before anything is awaited: even the
  // settings close below stands inside it. Previously the close was awaited
  // BEFORE the timer was armed - an HTTP request that never finished (fastify's
  // requestTimeout is 0; a POST with a Content-Length and half a body is
  // enough) stalled this await, the deadline never started, and the loader
  // killed lifemodel instead of letting it drain.
  let hardExit: ArmedStopDeadlineExit | undefined;
  if (error) {
    active?.logger.fatal({ err: error }, 'Shutdown triggered: %s', reason);
  } else {
    active?.logger.info('Shutdown triggered: %s', reason);
  }
  if (active) {
    // Armed BEFORE the stop starts and disarmed when it resolved: the same
    // budget the container's own stop deadline uses (its deadline starts a
    // moment later, so this timer can only fire while the stop is unfinished).
    hardExit = armStopDeadlineExit({
      logger: active.logger,
      budgetMs: active.coreLoop.getStopDrainTimeoutMs(),
      pending: () => ({ step: active.stopProgress(), ...active.coreLoop.stopReport() }),
    });
  } else {
    // eslint-disable-next-line no-console
    console.error(`Shutdown triggered: ${reason}`, error ?? '');
  }

  // Intake stops FIRST, as in the loader's own stop: no new settings save is
  // accepted while lifemodel is draining (a save that arrived now would write
  // a config the running core would never apply, and the reload it asks
  // for would be swallowed by the stop already running). The answer to the
  // save that started THIS stop has already gone out. The close is BOUNDED
  // (src/settings/server.ts): an outstanding request that does not end within
  // the grace is destroyed here, never waited on past the deadline.
  await options.settingsServer?.close();

  // A THROWING stop leaves the timer armed on purpose: the process then
  // still leaves at the deadline (with the exit code of the hard exit)
  // instead of hanging on a stop that will never finish.
  if (active) {
    await active.shutdown();
    hardExit?.disarm();
  }
  process.exit(code);
}

/**
 * Handle a shutdown signal.
 *
 * The stop is BOUNDED by one deadline (`shutdownDrainTimeoutMs`, default
 * 90 s): intake stops, the turn in flight and its sends are drained, state
 * and storage are flushed, the channels are released. Whatever still hangs at
 * the deadline - a stalled intake stop, a stalled tick, a hung send, a stalled
 * flush - is abandoned: the armed hard exit leaves the process with a
 * non-zero code and one error line naming what was still pending. What is lost
 * by leaving is what was only queued in memory (a schedule firing, a Motor
 * Cortex result, a reaction); the durable inbound log still replays unanswered
 * messages - see docs/architecture.md.
 */
async function shutdown(reason: string, error?: unknown): Promise<void> {
  await stopAndLeave(reason, error ? 1 : 0, error);
}

/**
 * The stop, as the entry point asks for it: the dedup flag lives here - ONE
 * stop runs here whatever asks for it - and the coordination is
 * `runStopSequence`, the same call a test drives (review round 2, finding I).
 */
async function stopAndLeave(reason: string, code: number, error?: unknown): Promise<void> {
  if (isShuttingDown) {
    return; // Already shutting down, ignore duplicate signals
  }
  isShuttingDown = true;
  await runStopSequence({ reason, code, error, container, settingsServer });
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

// Handle uncaught errors
process.on('uncaughtException', (error: unknown) => {
  void shutdown('uncaughtException', error);
});

process.on('unhandledRejection', (reason: unknown) => {
  void shutdown('unhandledRejection', reason);
});

// Start the application - unless a caller drives the exported pieces
// directly (the entry-point tests, review finding I): importing this module
// must never start a second container against the running one.
if (process.env['LIFEMODEL_ENTRYPOINT_AUTOSTART'] === '0') {
  // The pieces are imported; wiring belongs to the caller.
} else {
  main().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start:', error);
    process.exit(1);
  });
}
