/**
 * Plugin Port - Hexagonal Architecture
 *
 * Defines interfaces for plugins and the capabilities they receive.
 * Plugins are domain extensions that don't know about infrastructure.
 *
 * Key principles:
 * - Plugins emit intents, not direct actions
 * - Plugins use opaque recipientIds, not channel-specific IDs
 * - Plugins receive capabilities through DI, not globals
 */

import type { ILogger } from './logger.js';
import type { StorageQueryOptions } from './storage.js';
import type { ScheduleOptions, ScheduleEntry } from './scheduler.js';

/**
 * Plugin manifest - metadata about the plugin.
 */
export interface PluginManifest {
  /** Unique plugin ID (lowercase, alphanumeric with hyphens) */
  id: string;
  /** Human-readable name */
  name: string;
  /** Semantic version */
  version: string;
  /** Short description */
  description?: string;
  /** Author information */
  author?: string;
  /** Required capabilities */
  capabilities?: PluginCapabilityName[];
}

/**
 * Available capability names.
 */
export type PluginCapabilityName = 'schedule' | 'storage' | 'emit' | 'log' | 'timezone' | 'schema';

/**
 * Intent types that plugins can emit.
 */
export interface PluginIntent {
  type: string;
  payload: Record<string, unknown>;
  source?: string;
}

/**
 * Result of emitting a signal.
 */
export interface EmitResult {
  /** Whether the emit succeeded */
  success: boolean;
  /** Signal ID if successful */
  signalId?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Signal input from plugins.
 */
export interface PluginSignalInput {
  /** Signal priority (1=high, 2=normal, 3=low) */
  priority?: number;
  /** Signal data */
  data: {
    /** Namespaced kind: '{pluginId}:{eventType}' */
    kind: string;
    /** Plugin ID (must match prefix of kind) */
    pluginId: string;
    /** Idempotency key for scheduled signals */
    fireId?: string;
    /** Additional fields */
    [key: string]: unknown;
  };
}

/**
 * IIntentEmitter - Port for plugins to emit intents.
 *
 * Plugins use this to request actions from the core.
 * Core applies intents, plugins never perform side effects directly.
 */
export interface IIntentEmitter {
  /**
   * Emit a SEND_MESSAGE intent.
   * Core resolves recipientId to channel+destination.
   *
   * @param recipientId - Opaque recipient ID (not chatId!)
   * @param text - Message content
   * @param replyTo - Optional message ID to reply to
   */
  emitSendMessage(recipientId: string, text: string, replyTo?: string): void;

  /**
   * Emit an arbitrary intent.
   * Core validates and applies the intent.
   */
  emitIntent(intent: PluginIntent): void;

  /**
   * Emit a signal into the pipeline.
   * Fails soft on rate limit (returns error, doesn't throw).
   */
  emitSignal(signal: PluginSignalInput): EmitResult;
}

/**
 * ITimezoneService - Port for timezone operations.
 */
export interface ITimezoneService {
  /**
   * Get timezone for a recipient.
   * Returns IANA timezone (e.g., "America/New_York").
   */
  get(recipientId: string): string;

  /**
   * Set timezone for a recipient.
   */
  set(recipientId: string, timezone: string): void;

  /**
   * Get default timezone.
   */
  getDefault(): string;
}

/**
 * Event schema for validation.
 */
export interface EventSchema {
  /** JSON schema for event data */
  schema: Record<string, unknown>;
  /** Description of when this event fires */
  description?: string;
}

/**
 * ISchemaRegistry - Port for event schema registration.
 */
export interface ISchemaRegistry {
  /**
   * Register a schema for an event kind.
   */
  register(eventKind: string, schema: EventSchema): void;

  /**
   * Get schema for an event kind.
   */
  get(eventKind: string): EventSchema | null;

  /**
   * Validate data against a registered schema.
   */
  validate?(eventKind: string, data: unknown): { valid: boolean; errors?: string[] };
}

/**
 * Resource limits for plugins.
 */
export interface PluginLimits {
  /** Maximum storage size in bytes */
  maxStorageBytes?: number;
  /** Maximum schedules */
  maxSchedules?: number;
  /** Maximum signals per minute */
  maxSignalsPerMinute?: number;
}

/**
 * IPluginCapabilities - All capabilities provided to a plugin.
 *
 * Plugins receive this on activation and use it for all operations.
 * This is the "secondary port" - core provides these to plugins.
 */
export interface IPluginCapabilities {
  /** Scoped logger */
  logger: ILogger;

  /** Namespaced storage */
  storage: IPluginStorage;

  /** Scheduler for time-based events */
  scheduler: IPluginScheduler;

  /** Intent emitter for actions */
  emit: IIntentEmitter;

  /** Timezone service */
  timezone: ITimezoneService;

  /** Schema registry */
  schema: ISchemaRegistry;

  /** Resource limits */
  limits: PluginLimits;
}

/**
 * IPluginStorage - Storage interface for plugins.
 * Namespaced to prevent cross-plugin data access.
 */
export interface IPluginStorage {
  /** Get a value */
  get<T>(key: string): Promise<T | null>;
  /** Set a value */
  set(key: string, value: unknown): Promise<void>;
  /** Delete a key */
  delete(key: string): Promise<boolean>;
  /** List keys */
  keys(pattern?: string): Promise<string[]>;
  /** Query with filters */
  query<T>(options: StorageQueryOptions): Promise<T[]>;
  /** Clear all plugin data */
  clear(): Promise<void>;
  /** Namespace identifier */
  readonly namespace: string;
}

/**
 * IPluginScheduler - Scheduler interface for plugins.
 */
export interface IPluginScheduler {
  /** Schedule an event */
  schedule(options: ScheduleOptions): Promise<string>;
  /** Cancel a schedule */
  cancel(scheduleId: string): Promise<boolean>;
  /** Get active schedules */
  getSchedules(): ScheduleEntry[] | Promise<ScheduleEntry[]>;
}

/**
 * Plugin tool definition.
 */
export interface PluginTool {
  /** Tool name (will be prefixed with pluginId:) */
  name: string;
  /** Tool description for LLM */
  description: string;
  /** JSON schema for parameters */
  parameters: Record<string, unknown>;
  /** Tool execution function */
  execute: (
    args: Record<string, unknown>,
    context: PluginToolContext
  ) => Promise<PluginToolResult> | PluginToolResult;
  /** Capability tags for discovery */
  tags?: string[];
}

/**
 * Context provided to tool execution.
 */
export interface PluginToolContext {
  /** Opaque recipient ID (not chatId!) */
  recipientId: string;
  /** User's message that triggered the tool */
  userMessage?: string;
  /** Timezone for the recipient */
  timezone: string;
}

/**
 * Result from tool execution.
 */
export interface PluginToolResult {
  /** Whether the tool succeeded */
  success: boolean;
  /** Result message for LLM */
  message?: string;
  /** Structured result data */
  data?: Record<string, unknown>;
  /** Error details if failed */
  error?: string;
}

/**
 * Plugin event (from scheduler, etc.).
 */
export interface PluginEvent {
  /** Event kind (e.g., "reminder:due") */
  kind: string;
  /** Fire ID for idempotency */
  fireId: string;
  /** Event payload */
  payload: Record<string, unknown>;
  /** When the event was scheduled to fire */
  scheduledAt: Date;
  /** When the event actually fired */
  firedAt: Date;
}

/**
 * IPlugin - Primary plugin port.
 *
 * All plugins implement this interface.
 */
export interface IPlugin {
  /** Plugin manifest (metadata) */
  readonly manifest: PluginManifest;

  /**
   * Activate the plugin.
   * Called once when plugin is loaded.
   * Use to initialize state, register tools, etc.
   */
  activate(capabilities: IPluginCapabilities): Promise<void> | void;

  /**
   * Deactivate the plugin (optional).
   * Called when plugin is unloaded.
   * Use to clean up resources.
   */
  deactivate?(): Promise<void> | void;

  /**
   * Get tools provided by this plugin.
   */
  getTools(): PluginTool[];

  /**
   * Handle a plugin event (optional).
   * Called when a scheduled event fires.
   */
  onEvent?(event: PluginEvent): Promise<void> | void;

  /**
   * Health check (optional).
   */
  healthCheck?(): Promise<{ healthy: boolean; message?: string }>;
}

/**
 * Validate a plugin ID.
 * Must be lowercase alphanumeric with hyphens, 3-50 chars.
 */
export function isValidPluginId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(id) && !id.includes('--');
}
