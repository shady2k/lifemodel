/**
 * User-related type definitions.
 */

export type * from './person.js';
export type * from './user.js';

// Re-export factory functions
export { createPerson, isNameKnown } from './person.js';
export {
  createUser,
  createDefaultPatterns,
  createDefaultPreferences,
  createDefaultBeliefs,
} from './user.js';
