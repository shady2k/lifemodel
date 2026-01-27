/**
 * Lifemodel - Human-like proactive AI agent
 *
 * Entry point for the application.
 */

import { createContainer } from './core/container.js';

// Create the application container
const container = createContainer();

container.logger.info('Lifemodel starting...');

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
