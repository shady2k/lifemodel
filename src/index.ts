/**
 * Lifemodel - Human-like proactive AI agent
 *
 * Entry point for the application.
 */

import 'dotenv/config';

import { createContainerAsync, type Container } from './core/container.js';
import { armStopDeadlineExit, type ArmedStopDeadlineExit } from './core/hard-exit.js';

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
  process.exit(error ? 1 : 0);
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
