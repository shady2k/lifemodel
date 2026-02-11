/**
 * Core Tools Index
 *
 * Exports all core tool factory functions and their types.
 */

// Tool factories
export { createMemoryTool } from './memory.js';
export { createTimeTool } from './time.js';
export { createStateTool } from './state.js';
export { createToolsMetaTool } from './tools-meta.js';
export { createThoughtTool } from './thought.js';
export { createAgentTool } from './agent.js';
export { createScheduleTool } from './schedule.js';
export { createRememberTool } from './remember.js';
export { createInterestTool } from './interest.js';
export { createSoulTool } from './soul.js';
export { createEscalateTool } from './escalate.js';
export { createDeferTool } from './defer.js';
export { createSayTool } from './say.js';
export { createCredentialTool } from './credential.js';
export { createApproveSkillTool } from './approve-skill.js';

// Types
export type {
  MemoryProvider,
  MemoryEntry,
  MemorySearchOptions,
  SearchResult,
  RecentByTypeOptions,
  BehaviorRuleOptions,
  BehaviorRule,
  MemoryToolDeps,
} from './memory.js';
export type { ConversationProvider, TimeToolDeps } from './time.js';
export type { AgentStateProvider, UserModelProvider, StateToolDeps } from './state.js';
export type { ToolSchema, SchemaProvider, ToolsMetaToolDeps } from './tools-meta.js';
export type { SoulToolDeps } from './soul.js';
export type { CredentialToolDeps } from './credential.js';
