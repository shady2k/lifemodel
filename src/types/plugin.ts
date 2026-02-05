import type { Event, EventQueue } from './event.js';
import type { Logger } from './logger.js';
import type { Intent } from './intent.js';
import type { Metrics } from './metrics.js';
import type { PluginEventData } from './signal.js';
// Zod is optional - used for event schema validation if available

interface ZodType<T> {
  parse: (data: unknown) => T;
  safeParse: (data: unknown) => { success: boolean; data?: T; error?: { message: string } };
}

/**
 * Plugin types supported by the system (legacy V1).
 */
export type PluginType = 'rule' | 'llm-provider' | 'channel' | 'storage';

/**
 * Plugin component types for V2 manifest.
 */
export type PluginComponentType = 'neuron' | 'channel' | 'tool' | 'provider' | 'filter';

/**
 * Plugin primitives that can be requested.
 */
export type PluginPrimitive = 'scheduler' | 'storage' | 'signalEmitter' | 'logger';

/**
 * Plugin manifest - describes a plugin's identity and requirements.
 */
export interface PluginManifest {
  /** Unique plugin identifier */
  id: string;

  /** Human-readable name */
  name: string;

  /** Semantic version */
  version: string;

  /** Plugin type */
  type: PluginType;

  /** Other plugins this one depends on */
  dependencies?: string[];

  /** Configuration schema (JSON Schema) */
  configSchema?: Record<string, unknown>;

  /** Description of what this plugin does */
  description?: string;
}

/**
 * Context provided to plugins during activation.
 */
export interface PluginContext {
  /** Plugin's own configuration */
  config: Record<string, unknown>;

  /** Scoped logger for this plugin */
  logger: Logger;

  /** Event queue for emitting events */
  eventQueue: EventQueue;

  /** Metrics interface */
  metrics: Metrics;

  /** Emit intents (for rules) */
  emitIntents?: (intents: Intent[]) => void;

  /** Subscribe to events (for channels, rules) */
  subscribe?: (
    source: string,
    handler: (event: Event) => void | Promise<void>,
    channel?: string
  ) => () => void;

  /** Get current agent state (read-only) */
  getState?: () => Readonly<Record<string, unknown>>;
}

/**
 * Plugin interface - all plugins must implement this.
 */
export interface Plugin {
  /** Plugin metadata */
  manifest: PluginManifest;

  /**
   * Called when plugin is loaded.
   * Use this to set up connections, subscribe to events, etc.
   */
  activate(context: PluginContext): Promise<void>;

  /**
   * Called when plugin is being unloaded.
   * Use this to clean up resources, close connections, etc.
   */
  deactivate?(): Promise<void>;

  /**
   * Health check - returns true if plugin is functioning.
   */
  healthCheck?(): Promise<boolean>;
}

/**
 * Plugin loader result.
 */
export interface LoadedPlugin {
  plugin: Plugin;
  source: 'bundled' | 'external';
  path: string;
  loadedAt: Date;
}

/**
 * Plugin registry - tracks loaded plugins.
 */
export interface PluginRegistry {
  /** Get plugin by ID */
  get(id: string): LoadedPlugin | undefined;

  /** Get all plugins of a specific type */
  getByType(type: PluginType): LoadedPlugin[];

  /** Register a loaded plugin */
  register(loaded: LoadedPlugin): void;

  /** Unregister a plugin */
  unregister(id: string): void;

  /** Get all registered plugins */
  all(): LoadedPlugin[];
}

// ============================================================
// Plugin Lifecycle States
// ============================================================

/**
 * Plugin lifecycle state.
 * - pending: Plugin discovered but not yet loading
 * - loading: Plugin is being activated
 * - active: Plugin is running and functional
 * - paused: Plugin is temporarily disabled (keeps state)
 * - failed: Plugin failed to load or crashed
 */
export type PluginState = 'pending' | 'loading' | 'active' | 'paused' | 'failed';

/**
 * Plugin state information for tracking lifecycle.
 */
export interface PluginStateInfo {
  /** Current plugin state */
  state: PluginState;

  /** Number of failed activation attempts */
  failureCount: number;

  /** Last error message if failed */
  lastError?: string;

  /** Timestamp of last load attempt */
  lastAttemptAt?: Date;

  /** Timestamp when plugin was paused */
  pausedAt?: Date;

  /** Schedule IDs created from manifest (for cleanup on unload) */
  manifestScheduleIds?: string[] | undefined;
}

// ============================================================
// V2 Plugin System
// ============================================================

/**
 * Schedule options for the scheduler primitive.
 */
export interface ScheduleOptions {
  /** Unique schedule ID (auto-generated if not provided) */
  id?: string;

  /** When to fire (UTC for one-time, localTime for recurring) */
  fireAt: Date;

  /** Recurrence specification (null for one-time) */
  recurrence?: RecurrenceSpec | null;

  /** User's timezone for recurring schedules (IANA timezone name) */
  timezone?: string;

  /** Data to include in the fired signal */
  data: Record<string, unknown>;
}

/**
 * Constraint for finding dates relative to an anchor day.
 */
export type RecurrenceConstraint =
  | 'next-weekend' // First Saturday-Sunday on or after anchor
  | 'next-weekday' // First Mon-Fri on or after anchor
  | 'next-saturday' // First Saturday on or after anchor
  | 'next-sunday'; // First Sunday on or after anchor

/**
 * Recurrence specification for scheduled events.
 */
export interface RecurrenceSpec {
  /** Recurrence frequency */
  frequency: 'daily' | 'weekly' | 'monthly' | 'custom';

  /** Interval (e.g., every 2 days) */
  interval: number;

  /** Days of week for weekly recurrence (0=Sunday, 6=Saturday) */
  daysOfWeek?: number[];

  /** Day of month for monthly recurrence (fixed day approach) */
  dayOfMonth?: number;

  /**
   * Anchor day for constraint-based scheduling (1-31).
   * Used with 'constraint' for patterns like "weekend after 10th".
   */
  anchorDay?: number;

  /**
   * Constraint to apply after anchor day.
   * E.g., anchorDay=10 + constraint='next-weekend' = "first weekend after 10th"
   */
  constraint?: RecurrenceConstraint;

  /** Cron expression for custom recurrence */
  cron?: string;

  /** End date for recurrence (null = indefinite) */
  endDate?: Date | null;

  /** Maximum occurrences (null = indefinite) */
  maxOccurrences?: number | null;
}

/**
 * Persisted schedule entry.
 */
export interface ScheduleEntry {
  /** Unique schedule ID */
  id: string;

  /** Plugin ID that owns this schedule */
  pluginId: string;

  /** Next fire time (UTC) */
  nextFireAt: Date;

  /** Recurrence spec (null for one-time) */
  recurrence: RecurrenceSpec | null;

  /** User's timezone for DST-aware recurring */
  timezone: string | null;

  /** Local time for recurring (hour:minute) */
  localTime: string | null;

  /** Data to include in fired signal */
  data: Record<string, unknown>;

  /** When schedule was created */
  createdAt: Date;

  /** Number of times fired */
  fireCount: number;
}

/**
 * Storage query options for the storage primitive.
 */
export interface StorageQueryOptions {
  /** Required prefix for keys - no full scans allowed */
  prefix: string;

  /** In-memory filter after fetch */
  filter?: (value: unknown) => boolean;

  /** Maximum results (default: 100, max: 1000) */
  limit?: number;

  /** Pagination offset */
  offset?: number;

  /** Order by field */
  orderBy?: 'key' | 'createdAt';

  /** Sort order */
  order?: 'asc' | 'desc';

  /** Include values or just keys (default: true) */
  includeValues?: boolean;
}

/**
 * Migration bundle passed to plugin.migrate() during hot-swap.
 */
export interface MigrationBundle {
  /** All plugin storage keys and values */
  storage: Record<string, unknown>;

  /** Active schedules */
  schedules: ScheduleEntry[];

  /** Plugin configuration */
  config: Record<string, unknown>;
}

/**
 * V2 Plugin manifest with component-based architecture.
 */
export interface PluginManifestV2 {
  /** Manifest version (must be 2) */
  manifestVersion: 2;

  /** Unique plugin identifier (e.g., "com.lifemodel.reminder") */
  id: string;

  /** Human-readable name */
  name: string;

  /** Semantic version */
  version: string;

  /** Components this plugin provides */
  provides: { type: PluginComponentType; id: string }[];

  /** Primitives this plugin requires */
  requires: PluginPrimitive[];

  /** Dependencies on other plugins */
  dependencies?: {
    id: string;
    minVersion?: string;
    maxVersion?: string;
  }[];

  /** Configuration schema (JSON Schema or Zod) */
  configSchema?: Record<string, unknown>;

  /** Optional hard limits (soft limits always tracked) */
  limits?: {
    /** Maximum schedules (default: unlimited, warning at 1000) */
    maxSchedules?: number;
    /** Maximum storage in MB (default: unlimited, warning at 50MB) */
    maxStorageMB?: number;
    /** Signals per minute (default: unlimited, warning at 120) */
    signalsPerMinute?: number;
  };

  /** Description of what this plugin does */
  description?: string;

  /**
   * Declarative schedules managed by core.
   * Core creates these on plugin load and cancels on unload.
   */
  schedules?: PluginScheduleDefinition[];
}

/**
 * Declarative schedule definition in plugin manifest.
 *
 * Schedules declared here are created by core during plugin load
 * and automatically cancelled on unload. This gives core visibility
 * and control over all plugin schedules.
 */
export interface PluginScheduleDefinition {
  /** Unique schedule ID within this plugin (e.g., "poll_feeds") */
  id: string;

  // Cron expression (e.g., "0 */2 * * *" for every 2 hours)
  cron: string;

  /** Event kind to emit when schedule fires (e.g., "news:poll_feeds") */
  eventKind: string;

  /** Whether this schedule is enabled (default: true) */
  enabled?: boolean;

  /** Initial delay before first fire in ms (default: interval-based) */
  initialDelayMs?: number;

  /**
   * Whether to emit a signal to cognition when this schedule fires (default: true).
   * Set to false for internal events where the plugin handles everything via onEvent()
   * and emits its own meaningful signals (e.g., article_batch instead of poll_feeds).
   */
  emitSignal?: boolean;
}

/**
 * Snapshot of user's behavioral patterns.
 * Null values indicate pattern not yet learned.
 */
export interface UserPatternsSnapshot {
  /** Typical wake time (hour, 0-23) */
  wakeHour: number | null;
  /** Typical sleep time (hour, 0-23) */
  sleepHour: number | null;
}

/**
 * Snapshot of a user property with metadata.
 */
export interface UserPropertySnapshot {
  /** The property value */
  value: unknown;
  /** Confidence in this value (0-1) */
  confidence: number;
  /** How the value was determined */
  source: 'explicit' | 'inferred' | 'default';
  /** When the property was last updated */
  updatedAt: Date;
}

/**
 * Base services provided to plugins (from container).
 * PluginLoader adds registerEventSchema on top of this.
 */
export interface BasePluginServices {
  /** Get timezone for a recipient (IANA name). Returns 'UTC' if not found. */
  getTimezone: (recipientId?: string) => string;

  /**
   * Get user's behavioral patterns (wake/sleep hours).
   * Returns null if no user model exists or patterns not yet learned.
   */
  getUserPatterns: (recipientId?: string) => UserPatternsSnapshot | null;

  /**
   * Get a specific user property by attribute name.
   * Returns null if property doesn't exist or no user model.
   */
  getUserProperty: (attribute: string, recipientId?: string) => UserPropertySnapshot | null;

  /**
   * Set a user property atomically.
   * Use this for tool-driven writes when the user explicitly sets a value.
   * Properties are stored with confidence and source for conflict resolution.
   */
  setUserProperty: (attribute: string, value: unknown, recipientId?: string) => Promise<void>;
}

/**
 * Full services provided to plugins (includes schema registration).
 */
export interface PluginServices extends BasePluginServices {
  /**
   * Register an event schema for validation.
   * Call this in activate() for each event kind the plugin emits.
   * @param kind Full event kind (e.g., 'com.lifemodel.reminder:reminder_due')
   * @param schema Zod schema for validation
   */
  registerEventSchema: (kind: string, schema: EventSchema) => void;
}

/**
 * Primitives provided to plugins during activation.
 */
export interface PluginPrimitives {
  /** Scoped logger for this plugin */
  logger: Logger;

  /** Scheduler for time-based events */
  scheduler: SchedulerPrimitive;

  /** Namespaced storage */
  storage: StoragePrimitive;

  /** Intent emitter for sending messages and signals */
  intentEmitter: IntentEmitterPrimitive;

  /** Shared services (timezone, etc.) */
  services: PluginServices;

  /** Read-only access to memory (plugin's own facts only) */
  memorySearch: MemorySearchPrimitive;
}

/**
 * Scheduler primitive interface.
 */
export interface SchedulerPrimitive {
  /** Schedule a new event */
  schedule(options: ScheduleOptions): Promise<string>;

  /** Cancel a scheduled event */
  cancel(scheduleId: string): Promise<boolean>;

  /** Get all active schedules */
  getSchedules(): ScheduleEntry[] | Promise<ScheduleEntry[]>;

  /**
   * Update data for an existing schedule.
   * Used to sync manifest changes (like emitSignal) to existing schedules.
   * @returns true if schedule was found and updated, false if not found
   */
  updateScheduleData(scheduleId: string, data: Record<string, unknown>): Promise<boolean>;
}

/**
 * Storage primitive interface (namespaced).
 */
export interface StoragePrimitive {
  /** Get a value by key */
  get<T>(key: string): Promise<T | null>;

  /** Set a value */
  set(key: string, value: unknown): Promise<void>;

  /** Delete a key */
  delete(key: string): Promise<boolean>;

  /** List keys matching optional pattern */
  keys(pattern?: string): Promise<string[]>;

  /** Query with filters */
  query<T>(options: StorageQueryOptions): Promise<T[]>;

  /** Clear all plugin data */
  clear(): Promise<void>;
}

/**
 * Options for plugin memory search.
 */
export interface MemorySearchOptions {
  /** Max results (default: 10, max: 50) */
  limit?: number;
  /** Skip first N results for pagination */
  offset?: number;
  /** Minimum confidence threshold (0-1, default: 0.3) */
  minConfidence?: number;
}

/**
 * Memory entry visible to plugins (subset of core MemoryEntry).
 */
export interface PluginMemoryEntry {
  id: string;
  content: string;
  timestamp: Date;
  tags: string[];
  confidence: number;
  metadata: Record<string, unknown>;
}

/**
 * Result from plugin memory search.
 */
export interface MemorySearchResult {
  entries: PluginMemoryEntry[];
  pagination: {
    page: number;
    totalPages: number;
    hasMore: boolean;
    total: number;
  };
}

/**
 * Memory search primitive interface.
 * Read-only access to core memory, scoped to plugin's own facts.
 */
export interface MemorySearchPrimitive {
  /**
   * Search for facts created by this plugin.
   * Results are automatically filtered to metadata.pluginId === callingPlugin.
   * Only returns type: 'fact' entries (enforced in core).
   */
  searchOwnFacts: (query: string, options?: MemorySearchOptions) => Promise<MemorySearchResult>;
}

/**
 * Result of emitting a signal.
 */
export interface EmitSignalResult {
  /** Whether the signal was emitted successfully */
  success: boolean;
  /** Signal ID if successful */
  signalId?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Intent emitter interface.
 * Plugins use this to emit intents - core applies them.
 */
export interface IntentEmitterPrimitive {
  /** Emit a SEND_MESSAGE intent. Core resolves recipientId to channel+destination. */
  emitSendMessage(recipientId: string, text: string, replyTo?: string): void;

  /** Emit an arbitrary intent. */
  emitIntent(intent: Intent): void;

  /**
   * Emit a signal into the pipeline.
   * Returns result with signalId on success, or error on failure.
   * Fails soft on rate limit (doesn't throw).
   */
  emitSignal(signal: PluginSignalInput): EmitSignalResult;

  /**
   * Emit a thought signal for COGNITION to process.
   * Thoughts bypass energy gate and wake COGNITION immediately.
   * Core handles deduplication via similarity matching.
   *
   * @param content The thought content for COGNITION to process
   * @returns Result with signalId on success, or error on failure (e.g., rate limit, budget exceeded)
   */
  emitThought(content: string): EmitSignalResult;
}

/**
 * Input for emitting a plugin signal.
 */
export interface PluginSignalInput {
  /** Signal priority (1=high, 2=normal, 3=low) */
  priority?: number;

  /** Signal data */
  data: PluginSignalData;
}

/**
 * Plugin signal data envelope (for signal emitter input).
 */
export interface PluginSignalData {
  /** Namespaced kind: '{pluginId}:{eventType}' */
  kind: string;

  /** Plugin ID (must match prefix of kind) */
  pluginId: string;

  /** Idempotency key for scheduled signals */
  fireId?: string;

  /** Additional plugin-specific fields */
  [key: string]: unknown;
}

/**
 * V2 Plugin lifecycle interface.
 */
export interface PluginLifecycleV2 {
  /**
   * Called when plugin is loaded.
   * Use this to set up state, register tools, etc.
   */
  activate(primitives: PluginPrimitives): Promise<void> | void;

  /**
   * Called when plugin is being unloaded.
   * Use this to clean up resources.
   */
  deactivate?(): Promise<void> | void;

  /**
   * Health check - returns healthy status and optional message.
   */
  healthCheck?(): Promise<{ healthy: boolean; message?: string }>;

  /**
   * Migration hook for hot-swap.
   * If not provided, hot-swap is refused.
   * Returned bundle is authoritative and persisted by core.
   */
  migrate?(
    fromVersion: string,
    bundle: MigrationBundle
  ): Promise<MigrationBundle> | MigrationBundle;

  /**
   * Called when a plugin event is fired (e.g., from scheduler).
   * Use this to handle scheduled events, update internal state, etc.
   * Called BEFORE the signal reaches cognition layer.
   */
  onEvent?(eventKind: string, payload: Record<string, unknown>): Promise<void>;
}

/**
 * V2 Plugin instance with manifest and lifecycle.
 */
export interface PluginV2 {
  /** Plugin manifest */
  manifest: PluginManifestV2;

  /** Plugin lifecycle hooks */
  lifecycle: PluginLifecycleV2;

  /** Tools provided by this plugin (if any) */
  tools?: PluginTool[];
}

/**
 * Execution context for plugin tools.
 * Contains system information NOT visible to LLM.
 */
export interface PluginToolContext {
  /** Opaque recipient identifier. Core resolves to channel+destination. */
  recipientId: string;

  /** Current user ID */
  userId?: string | undefined;

  /** Correlation ID for tracing */
  correlationId: string;
}

/**
 * Result of validating tool arguments.
 */
export type PluginValidationResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * Tool definition from a plugin.
 */
export interface PluginTool {
  /** Tool name (will be prefixed with plugin ID in registry) */
  name: string;

  /** Tool description for LLM */
  description: string;

  /** Capability tags for tool discovery (e.g., ['recurring', 'one-time']) */
  tags?: string[];

  /** Tool parameters */
  parameters: {
    name: string;
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    description: string;
    required: boolean;
    default?: unknown;
    /** Enum values for string parameters */
    enum?: readonly string[];
  }[];

  /**
   * Raw JSON Schema for complex parameter validation.
   * When provided, this is used directly instead of converting `parameters`.
   * Useful for nested objects, discriminated unions, oneOf, anyOf, etc.
   * Must include type: 'object', properties, required, and additionalProperties: false.
   */
  rawParameterSchema?: Record<string, unknown>;

  /**
   * Validate arguments before execution.
   * Returns ValidationResult with data on success, or error message on failure.
   */
  validate: (args: unknown) => PluginValidationResult;

  /**
   * Tool executor
   * @param args - Arguments from the LLM
   * @param context - Execution context (NOT visible to LLM) - contains chatId, userId, etc.
   */
  execute: (args: Record<string, unknown>, context?: PluginToolContext) => Promise<unknown>;
}

/**
 * Event schema for validation (using Zod or compatible).
 * Uses the signal PluginEventData format from signal.ts.
 */
export type EventSchema = ZodType<PluginEventData>;

// ============================================================
// Neuron Plugin Extension
// ============================================================

import type { Neuron } from '../layers/autonomic/neuron-registry.js';

/**
 * Extended plugin interface for neuron plugins.
 * Neurons are state monitors in the AUTONOMIC layer that emit signals
 * when meaningful changes occur.
 */
export interface NeuronPluginV2 extends PluginV2 {
  /** Neuron factory and configuration */
  neuron: {
    /**
     * Create a neuron instance.
     * @param logger Scoped logger for the neuron
     * @param config Optional configuration (from plugins.configs or defaultConfig)
     */
    create: (logger: Logger, config?: unknown) => Neuron;

    /** Default configuration if none provided in plugins.configs */
    defaultConfig?: unknown;
  };
}

/**
 * Type guard to check if a plugin is a neuron plugin.
 */
export function isNeuronPlugin(plugin: PluginV2): plugin is NeuronPluginV2 {
  return (
    'neuron' in plugin && plugin.manifest.provides.some((component) => component.type === 'neuron')
  );
}

// ============================================================
// Filter Plugin Extension
// ============================================================

import type { SignalFilter } from '../layers/autonomic/filter-registry.js';
import type { SignalType } from './signal.js';

/**
 * Extended plugin interface for filter plugins.
 * Filters are signal processors in the AUTONOMIC layer that transform
 * or classify incoming signals.
 *
 * Unlike neurons (which monitor state), filters react to incoming signals.
 * Example: NewsSignalFilter processes article batches and classifies them
 * as urgent/interesting/noise.
 */
export interface FilterPluginV2 extends PluginV2 {
  /** Filter factory and configuration */
  filter: {
    /**
     * Create a signal filter instance.
     * @param logger Scoped logger for the filter
     */
    create: (logger: Logger) => SignalFilter;

    /**
     * Signal types this filter handles (for validation).
     * Must match what the created filter returns in its `handles` property.
     */
    handles: SignalType[];

    /** Priority for filter ordering (lower = runs first, default 100) */
    priority?: number;
  };
}

/**
 * Type guard to check if a plugin is a filter plugin.
 */
export function isFilterPlugin(plugin: PluginV2): plugin is FilterPluginV2 {
  return (
    'filter' in plugin && plugin.manifest.provides.some((component) => component.type === 'filter')
  );
}
