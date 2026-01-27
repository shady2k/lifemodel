/**
 * Lifemodel - Human-like proactive AI agent
 *
 * Entry point for the application.
 */

import { createContainer } from './core/container.js';

// Create the application container
const container = createContainer();

const { logger, agent, eventLoop, telegramChannel, messageComposer, primaryUserChatId } = container;

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

// Handle shutdown
process.on('SIGINT', () => {
  void container.shutdown().then(() => {
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  void container.shutdown().then(() => {
    process.exit(0);
  });
});
