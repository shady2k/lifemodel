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
    eventLoop,
    telegramChannel,
    messageComposer,
    primaryUserChatId,
    stateManager,
    learningEngine,
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

  // Log learning status
  if (learningEngine) {
    const stats = learningEngine.getStats();
    logger.info({ stats }, 'Learning engine enabled');
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

  // Start the event loop (heartbeat)
  eventLoop.start();
}

// Handle shutdown gracefully
async function shutdown(): Promise<void> {
  if (isShuttingDown) {
    return; // Already shutting down, ignore duplicate signals
  }
  isShuttingDown = true;

  if (container) {
    await container.shutdown();
  }
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown();
});

process.on('SIGTERM', () => {
  void shutdown();
});

// Handle uncaught errors
process.on('uncaughtException', (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Uncaught exception:', error);
  void shutdown();
});

process.on('unhandledRejection', (reason: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Unhandled rejection:', reason);
  void shutdown();
});

// Start the application
main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start:', error);
  process.exit(1);
});
