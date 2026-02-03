/**
 * Agent-related type definitions.
 */

export type * from './state.js';
export type * from './identity.js';
export type * from './soul.js';
export type * from './parliament.js';
export type * from './socratic.js';

// Re-export factory functions
export { createDefaultAgentState, createDefaultSleepState } from './state.js';
export { createDefaultIdentity } from './identity.js';
export {
  createDefaultConstitution,
  createDefaultCaseLaw,
  createDefaultNarrative,
  createDefaultSelfModel,
  createDefaultSoulBudget,
  createDefaultSoulState,
  DEFAULT_SOUL_BUDGET,
  SOUL_STATE_VERSION,
} from './soul.js';
export {
  createDefaultParliament,
  createEmptyDeliberation,
  PARLIAMENT_VERSION,
} from './parliament.js';
export {
  createDefaultSocraticEngine,
  createDefaultUnanswerableCore,
  createSelfQuestion,
  DEFAULT_QUESTION_TEMPLATES,
  SOCRATIC_ENGINE_VERSION,
} from './socratic.js';
