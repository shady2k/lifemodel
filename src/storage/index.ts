/**
 * Storage module exports.
 */

export type { Storage } from './storage.js';
export type {
  PersistableState,
  PersistableRuleState,
  PersistableNeuronWeights,
} from './persistable-state.js';
export {
  PERSISTABLE_STATE_VERSION,
  createEmptyPersistableState,
  serializeState,
  deserializeState,
} from './persistable-state.js';
export type { StateManagerConfig } from './state-manager.js';
export { StateManager, createStateManager } from './state-manager.js';
export type { ConversationMessage, GetHistoryOptions } from './conversation-manager.js';
export { ConversationManager, createConversationManager } from './conversation-manager.js';
export { PostgresConversationStore } from './postgres-conversation-store.js';
export type { VectorStore, VectorSearchOptions, VectorSearchResult } from './vector-store.js';
export type { Embedder, EmbedderConfig } from './embedder.js';
export { createEmbedder } from './embedder.js';
export type {
  GraphStore,
  GraphEntity,
  GraphRelation,
  EntityType,
  RelationType,
  TraversalOptions,
  TraversalResult,
  SpreadingActivationOptions,
  ActivationResult,
} from './graph-store.js';

export {
  SnapshotStore,
  createSnapshotStore,
  SNAPSHOT_VERSION,
  StaleSnapshotEpochError,
} from './snapshot-store.js';
export type {
  SnapshotEnvelope,
  SnapshotSectionOwner,
  SnapshotStoreConfig,
} from './snapshot-store.js';

export { PostgresStorage } from './postgres-storage.js';
