/**
 * Core type definitions for Lifemodel.
 */

export type * from './priority.js';
export type * from './event.js';
export type * from './intent.js';
export type * from './plugin.js';
export type * from './metrics.js';
export type * from './thought.js';
export type * from './logger.js';
export type * from './agent-state.js';
export type * from './agent-identity.js';

// Re-export Priority enum as value (needed for runtime use)
export { Priority, PRIORITY_DISTURBANCE_WEIGHT } from './priority.js';

// Re-export factory functions for state/identity defaults
export { createDefaultAgentState, createDefaultSleepState } from './agent-state.js';
export { createDefaultIdentity } from './agent-identity.js';
