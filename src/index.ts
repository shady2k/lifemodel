/**
 * Lifemodel - Human-like proactive AI agent
 *
 * Entry point for the application.
 */

import 'dotenv/config';

import { createContainerAsync, type Container } from './core/container.js';

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

// Handle shutdown gracefully
async function shutdown(reason: string, error?: unknown): Promise<void> {
  if (isShuttingDown) {
    return; // Already shutting down, ignore duplicate signals
  }
  isShuttingDown = true;

  if (container) {
    if (error) {
      container.logger.fatal({ err: error }, 'Shutdown triggered: %s', reason);
    } else {
      container.logger.info('Shutdown triggered: %s', reason);
    }
    await container.shutdown();
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
