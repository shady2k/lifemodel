/**
 * Lifemodel - Human-like proactive AI agent
 *
 * Entry point for the application.
 */

import 'dotenv/config';

import { createContainerAsync, type Container } from './core/container.js';
import { armStopDeadlineExit, type ArmedStopDeadlineExit } from './core/hard-exit.js';
import { createConfigLoader, resolveConfigDir } from './config/index.js';
import { createSettingsServer } from './settings/server.js';
import { RESTART_EXIT_CODE } from './settings/restart.js';

let container: Container | undefined;
let isShuttingDown = false;

async function main(): Promise<void> {
  // Create the application container with async initialization
  // This loads config, initializes storage, and restores state
  container = await createContainerAsync();

  const {
    logger,
    agent,
    coreLoop,
    telegramChannel,
    messageComposer,
    primaryUserChatId,
    stateManager,
  } = container;

  // lifemodel's own settings interface, on the port Caddy's root host reaches
  // (127.0.0.1:7100). It is started BEFORE the loop, so the instance is
  // configurable even when nothing else works yet - on the first start of an
  // instance the config file is empty, and this page is how it gets filled.
  await startSettingsInterface(logger);

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

  // Log proactive messaging capability
  if (messageComposer && primaryUserChatId && telegramChannel) {
    logger.info({ chatId: primaryUserChatId }, 'Proactive messaging enabled');
  } else {
    logger.info(
      {
        hasComposer: !!messageComposer,
        hasChatId: !!primaryUserChatId,
        hasTelegram: !!telegramChannel,
      },
      'Proactive messaging not fully configured'
    );
  }

  // Start Telegram channel if configured
  if (telegramChannel) {
    void telegramChannel.start();
  }

  // Start the core loop (heartbeat)
  coreLoop.start();
}

/**
 * Start lifemodel's settings interface (lifemodel-q4x.4.1).
 *
 * A port that cannot be taken is NOT fatal: lifemodel keeps running and says so
 * at error level, because exiting here would turn one bad input into a restart
 * loop the loader would count as deaths (AGENTS.md, lesson 3: the same input
 * fails the same way every time - the owner is told instead).
 */
async function startSettingsInterface(logger: Container['logger']): Promise<void> {
  const server = createSettingsServer({
    // The same config file the container loaded its configuration from: one
    // resolution (resolveConfigDir), so the interface writes where the next
    // start reads.
    config: createConfigLoader(resolveConfigDir()),
    logger,
    onSaved: () => {
      void restartAfterSettingsSaved();
    },
  });
  try {
    await server.listen();
    logger.info({ address: server.address() }, "lifemodel's settings interface is up");
  } catch (error) {
    logger.error(
      { address: server.address(), error: error instanceof Error ? error.message : String(error) },
      "lifemodel's settings interface could not listen: the instance runs, but its settings page does not"
    );
  }
}

/**
 * lifemodel's settings were saved: stop as on any other stop (the turn in
 * flight is drained, state and storage are flushed, the channels are released),
 * then leave with the code the loader restarts on - see src/settings/restart.ts
 * and loader/src/supervisor.ts. Nothing is reconfigured underneath a running
 * turn: the next start reads the new config.
 */
async function restartAfterSettingsSaved(): Promise<void> {
  await stopAndLeave('settings saved: restarting lifemodel', RESTART_EXIT_CODE);
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
 * The stop itself, with the code the process leaves with.
 *
 * `code` 0 is an ordinary end, 1 a failure, and `RESTART_EXIT_CODE` the restart
 * a saved settings page asks for - the loader answers that one by starting
 * lifemodel again at once. ONE stop runs here whatever asks for it: a signal, a
 * crash, or the settings page, and later callers get the first one's outcome.
 */
async function stopAndLeave(reason: string, code: number, error?: unknown): Promise<void> {
  if (isShuttingDown) {
    return; // Already shutting down, ignore duplicate signals
  }
  isShuttingDown = true;

  let hardExit: ArmedStopDeadlineExit | undefined;
  const active = container;
  if (active) {
    if (error) {
      active.logger.fatal({ err: error }, 'Shutdown triggered: %s', reason);
    } else {
      active.logger.info('Shutdown triggered: %s', reason);
    }
    // Armed BEFORE the stop starts and disarmed when it resolved: the same
    // budget the container's own stop deadline uses (its deadline starts a
    // moment later, so this timer can only fire while the stop is unfinished).
    hardExit = armStopDeadlineExit({
      logger: active.logger,
      budgetMs: active.coreLoop.getStopDrainTimeoutMs(),
      pending: () => ({ step: active.stopProgress(), ...active.coreLoop.stopReport() }),
    });
    // A THROWING stop leaves the timer armed on purpose: the process then
    // still leaves at the deadline (with the exit code of the hard exit)
    // instead of hanging on a stop that will never finish.
    await active.shutdown();
    hardExit.disarm();
  } else {
    // eslint-disable-next-line no-console
    console.error(`Shutdown triggered: ${reason}`, error ?? '');
  }
  process.exit(code);
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

// Start the application
main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start:', error);
  process.exit(1);
});
