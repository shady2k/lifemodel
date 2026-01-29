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
export type PluginComponentType = 'neuron' | 'channel' | 'tool' | 'provider';

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
}

/**
 * Base services provided to plugins (from container).
 * PluginLoader adds registerEventSchema on top of this.
 */
export interface BasePluginServices {
  /**
   * Get timezone for a chat (IANA name).
   * Resolution: chat override -> user default -> 'UTC'
   */
  getTimezone: (chatId?: string) => string;
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

  /** Signal emitter for the pipeline */
  signalEmitter: SignalEmitterPrimitive;

  /** Shared services (timezone, etc.) */
  services: PluginServices;
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
 * Signal emitter primitive interface.
 */
export interface SignalEmitterPrimitive {
  /**
   * Emit a signal into the pipeline.
   * @returns signalId - UUID for tracing/logging
   */
  emit(signal: PluginSignalInput): string;
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
  }[];

  /** Tool executor */
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Event schema for validation (using Zod or compatible).
 * Uses the signal PluginEventData format from signal.ts.
 */
export type EventSchema = ZodType<PluginEventData>;
