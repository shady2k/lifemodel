/**
 * Prompts — re-export all prompt builders.
 */

export { buildSystemPrompt } from './system-prompt.js';
export { buildTriggerPrompt } from './trigger-prompt.js';
export {
  formatAge,
  buildUserProfileSection,
  buildRecentThoughtsSection,
  buildPendingIntentionsSection,
  buildSoulSection,
  buildUnresolvedTensionsSection,
  buildRuntimeSnapshotSection,
  buildCompletedActionsSection,
} from './context-sections.js';
export {
  buildProactiveContactSection,
  buildPluginEventSection,
  buildThoughtTriggerSection,
  buildReactionTriggerSection,
} from './trigger-sections.js';
export {
  shouldIncludeRuntimeSnapshot,
  getRuntimeSnapshotScope,
  isStateQuery,
  isUserStateQuery,
  matchesAny,
  asNumber,
  describeLevel,
  getTriggerText,
  isProactiveTrigger,
} from './runtime-snapshot.js';
