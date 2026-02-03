/**
 * Core type definitions for Lifemodel.
 */

// Belief system
export type * from './belief.js';
export {
  createBelief,
  updateBelief,
  updateNumericBelief,
  decayBelief,
  isBeliefStale,
  getBeliefValue,
} from './belief.js';

// Core types
export type * from './priority.js';
export type * from './event.js';
export type * from './intent.js';
export type * from './plugin.js';
export type * from './metrics.js';
export type * from './thought.js';
export type * from './logger.js';
export type * from './rule.js';
export type * from './news.js';

// 4-layer architecture types
export type * from './signal.js';
export type * from './layers.js';

// Agent types
export type * from './agent/index.js';

// User types
export type * from './user/index.js';

// Re-export Priority enum as value (needed for runtime use)
export { Priority, PRIORITY_DISTURBANCE_WEIGHT } from './priority.js';

// Re-export signal utilities
export {
  SIGNAL_TTL,
  THOUGHT_LIMITS,
  createSignal,
  createUserMessageSignal,
  createMessageReactionSignal,
  createThoughtSignal,
  isSignalExpired,
  createSignalBuffer,
} from './signal.js';

// Re-export layer constants
export { DEFAULT_WAKE_THRESHOLDS } from './layers.js';

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

// Re-export rule factory functions
export { createRule } from './rule.js';

// Re-export user interests factory functions
export { createDefaultInterests } from './user/interests.js';

// Channel types (re-exported from channels module)
export type { Channel, CircuitStats, SendOptions, SendResult } from '../channels/channel.js';

/**
 * Round a number to 3 decimal places.
 * Use this for all state values to avoid floating point noise.
 */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
