/**
 * Lifemodel - Human-like proactive AI agent
 *
 * Entry point for the application.
 */

import { createContainer } from './core/container.js';

// Create the application container
const container = createContainer();

const { logger, agent } = container;

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
