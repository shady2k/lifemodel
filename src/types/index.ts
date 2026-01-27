/**
 * Core type definitions for Lifemodel.
 */

// Core types
export type * from './priority.js';
export type * from './event.js';
export type * from './intent.js';
export type * from './plugin.js';
export type * from './metrics.js';
export type * from './thought.js';
export type * from './logger.js';

// Agent types
export type * from './agent/index.js';

// User types
export type * from './user/index.js';

// Re-export Priority enum as value (needed for runtime use)
export { Priority, PRIORITY_DISTURBANCE_WEIGHT } from './priority.js';

// Re-export agent factory functions
export {
  createDefaultAgentState,
  createDefaultSleepState,
  createDefaultIdentity,
} from './agent/index.js';

// Re-export user factory functions
export {
  createPerson,
  createUser,
  createDefaultPatterns,
  createDefaultPreferences,
} from './user/index.js';
