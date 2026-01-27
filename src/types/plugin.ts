import type { Event, EventQueue } from './event.js';
import type { Logger } from './logger.js';
import type { Intent } from './intent.js';
import type { Metrics } from './metrics.js';

/**
 * Plugin types supported by the system.
 */
export type PluginType = 'rule' | 'llm-provider' | 'channel' | 'storage';

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
