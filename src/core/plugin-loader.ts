/**
 * Plugin Loader
 *
 * Manages plugin lifecycle: loading, activation, hot-swap, and deactivation.
 * Validates manifests, checks dependencies, and creates plugin primitives.
 */

import { randomUUID } from 'node:crypto';
import * as semver from 'semver';
import type { Logger } from '../types/logger.js';
import type { Storage } from '../storage/storage.js';
import type { Signal, PluginEventData as SignalPluginEventData } from '../types/signal.js';
import type {
  PluginV2,
  PluginManifestV2,
  PluginPrimitives,
  PluginServices,
  BasePluginServices,
  IntentEmitterPrimitive,
  EmitSignalResult,
  PluginSignalInput,
  PluginTool,
  MigrationBundle,
  EventSchema,
} from '../types/plugin.js';
import type { Intent } from '../types/intent.js';
import { createStoragePrimitive, type StoragePrimitiveImpl } from './storage-primitive.js';
import { createSchedulerPrimitive, type SchedulerPrimitiveImpl } from './scheduler-primitive.js';
import type { SchedulerService } from './scheduler-service.js';

/**
 * Callback type for pushing signals into the pipeline.
 */
export type SignalPushCallback = (signal: Signal) => void;

/**
 * Callback type for registering tools.
 */
export type ToolRegisterCallback = (tool: PluginTool) => void;

/**
 * Callback type for unregistering tools.
 */
export type ToolUnregisterCallback = (toolName: string) => boolean;

/**
 * Callback type for emitting intents.
 * Used by IntentEmitter to route intents to core loop.
 */
export type IntentEmitCallback = (intent: Intent) => void;

/**
 * Loaded plugin state.
 */
interface LoadedPluginState {
  plugin: PluginV2;
  storage: StoragePrimitiveImpl;
  scheduler: SchedulerPrimitiveImpl;
  loadedAt: Date;
  status: 'active' | 'inactive';
}

/**
 * Plugin loader configuration.
 * Reserved for future features (e.g., drain mode TTL).
 */
export interface PluginLoaderConfig {
  /** Drain mode timeout in ms (default: 5 minutes) - reserved for future use */
  drainTimeoutMs?: number;
}

/**
 * Plugin loader - manages plugin lifecycle.
 */
export class PluginLoader {
  private readonly logger: Logger;
  private readonly coreStorage: Storage;
  private readonly schedulerService: SchedulerService;

  private readonly plugins = new Map<string, LoadedPluginState>();
  private readonly eventSchemas = new Map<string, EventSchema>();
  /** Track which schemas each plugin registered (for cleanup) */
  private readonly pluginSchemas = new Map<string, Set<string>>();

  private signalCallback: SignalPushCallback | null = null;
  private intentCallback: IntentEmitCallback | null = null;
  private toolRegisterCallback: ToolRegisterCallback | null = null;
  private toolUnregisterCallback: ToolUnregisterCallback | null = null;
  private servicesProvider: (() => BasePluginServices) | null = null;

  constructor(
    logger: Logger,
    coreStorage: Storage,
    schedulerService: SchedulerService,
    _config: Partial<PluginLoaderConfig> = {}
  ) {
    this.logger = logger.child({ component: 'plugin-loader' });
    this.coreStorage = coreStorage;
    this.schedulerService = schedulerService;
    // Config reserved for future features (e.g., drain mode TTL)
  }

  /**
   * Set the callback for pushing signals into the pipeline.
   */
  setSignalCallback(callback: SignalPushCallback): void {
    this.signalCallback = callback;
  }

  /**
   * Set the callback for emitting intents.
   * Used by IntentEmitter to route intents to core loop.
   */
  setIntentCallback(callback: IntentEmitCallback): void {
    this.intentCallback = callback;
  }

  /**
   * Set callbacks for tool registration.
   */
  setToolCallbacks(register: ToolRegisterCallback, unregister: ToolUnregisterCallback): void {
    this.toolRegisterCallback = register;
    this.toolUnregisterCallback = unregister;
  }

  /**
   * Set the services provider function.
   * Called to get shared services for plugins.
   * PluginLoader will add registerEventSchema on top of provided services.
   */
  setServicesProvider(provider: () => BasePluginServices): void {
    this.servicesProvider = provider;
  }

  /**
   * Load and activate a plugin.
   */
  async load(pluginModule: { default: PluginV2 }): Promise<void> {
    const plugin = pluginModule.default;
    const { manifest } = plugin;

    // Validate manifest
    this.validateManifest(manifest);

    // Check if already loaded
    if (this.plugins.has(manifest.id)) {
      throw new Error(`Plugin ${manifest.id} is already loaded. Use hotSwap() to update.`);
    }

    // Check dependencies
    this.checkDependencies(manifest);

    // Create primitives
    const primitives = await this.createPrimitives(plugin);

    // Activate plugin
    try {
      await plugin.lifecycle.activate(primitives);
    } catch (error) {
      // Clean up on activation failure
      await primitives.storage.clear();
      throw new Error(
        `Plugin ${manifest.id} activation failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Register tools (read after activation - tools may be created during activate())
    const tools = plugin.tools;
    if (tools && tools.length > 0) {
      this.registerPluginTools(manifest.id, tools);
    }

    // Store loaded state
    const scheduler = this.schedulerService.getScheduler(manifest.id);
    if (!scheduler) {
      throw new Error(`Scheduler not registered for plugin ${manifest.id}`);
    }
    const state: LoadedPluginState = {
      plugin,
      storage: primitives.storage as StoragePrimitiveImpl,
      scheduler,
      loadedAt: new Date(),
      status: 'active',
    };
    this.plugins.set(manifest.id, state);

    this.logger.info(
      {
        pluginId: manifest.id,
        version: manifest.version,
        provides: manifest.provides.map((p) => `${p.type}:${p.id}`),
      },
      'Plugin loaded and activated'
    );
  }

  /**
   * Hot-swap a plugin with a new version.
   */
  async hotSwap(pluginId: string, newModule: { default: PluginV2 }): Promise<void> {
    const oldState = this.plugins.get(pluginId);
    if (!oldState) {
      // Not loaded yet, just do a regular load
      await this.load(newModule);
      return;
    }

    const newPlugin = newModule.default;
    const { manifest: newManifest } = newPlugin;

    // Validate new manifest
    this.validateManifest(newManifest);

    if (newManifest.id !== pluginId) {
      throw new Error(`Plugin ID mismatch: expected ${pluginId}, got ${newManifest.id}`);
    }

    // Check dependencies for new version
    this.checkDependencies(newManifest);

    const oldManifest = oldState.plugin.manifest;
    const oldVersion = oldManifest.version;
    const newVersion = newManifest.version;

    this.logger.info({ pluginId, oldVersion, newVersion }, 'Starting hot-swap');

    // Gather migration bundle
    const bundle: MigrationBundle = {
      storage: await oldState.storage.getAllData(),
      schedules: oldState.scheduler.getMigrationData(),
      config: {}, // TODO: Load from config
    };

    // Check if new plugin has migrate hook
    let migratedBundle: MigrationBundle;
    if (newPlugin.lifecycle.migrate) {
      try {
        migratedBundle = await newPlugin.lifecycle.migrate(oldVersion, bundle);
      } catch (error) {
        this.logger.error(
          { pluginId, error: error instanceof Error ? error.message : String(error) },
          'Migration hook failed, aborting hot-swap'
        );
        throw error;
      }
    } else {
      // No migrate hook - refuse hot-swap (drain mode requires complex coordination)
      // User must restart the application to update this plugin
      this.logger.error(
        { pluginId, oldVersion, newVersion },
        'Hot-swap requires migrate() hook. Restart application to update this plugin.'
      );
      throw new Error(
        `Plugin ${pluginId} does not support hot-swap (no migrate hook). ` +
          `Restart the application to update from v${oldVersion} to v${newVersion}.`
      );
    }

    // Deactivate old plugin
    if (oldState.plugin.lifecycle.deactivate) {
      try {
        await oldState.plugin.lifecycle.deactivate();
      } catch (error) {
        this.logger.warn(
          { pluginId, error: error instanceof Error ? error.message : String(error) },
          'Old plugin deactivation failed, continuing with hot-swap'
        );
      }
    }

    // Unregister old tools
    const oldTools = oldState.plugin.tools;
    if (oldTools) {
      for (const tool of oldTools) {
        this.toolUnregisterCallback?.(`${pluginId}:${tool.name}`);
      }
    }

    // Create new primitives
    const newPrimitives = await this.createPrimitives(newPlugin);

    // Restore migrated data
    await (newPrimitives.storage as StoragePrimitiveImpl).restoreData(migratedBundle.storage);
    const newScheduler = this.schedulerService.getScheduler(pluginId);
    if (!newScheduler) {
      throw new Error(`Scheduler not found for plugin ${pluginId}`);
    }
    await newScheduler.restoreFromMigration(migratedBundle.schedules);

    // Activate new plugin
    try {
      await newPlugin.lifecycle.activate(newPrimitives);
    } catch (error) {
      // Rollback on activation failure
      this.logger.error({ pluginId }, 'New plugin activation failed, attempting rollback');
      // Re-activate old plugin with old data
      const oldPrimitives = await this.createPrimitives(oldState.plugin);
      await (oldPrimitives.storage as StoragePrimitiveImpl).restoreData(bundle.storage);
      await oldState.scheduler.restoreFromMigration(bundle.schedules);
      await oldState.plugin.lifecycle.activate(oldPrimitives);
      throw new Error(
        `Hot-swap failed, rolled back: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Register new tools (read after activation)
    const newTools = newPlugin.tools;
    if (newTools && newTools.length > 0) {
      this.registerPluginTools(pluginId, newTools);
    }

    // Update state
    const updatedScheduler = this.schedulerService.getScheduler(pluginId);
    if (!updatedScheduler) {
      throw new Error(`Scheduler not found for plugin ${pluginId} after hot-swap`);
    }
    const newState: LoadedPluginState = {
      plugin: newPlugin,
      storage: newPrimitives.storage as StoragePrimitiveImpl,
      scheduler: updatedScheduler,
      loadedAt: new Date(),
      status: 'active',
    };
    this.plugins.set(pluginId, newState);

    this.logger.info({ pluginId, oldVersion, newVersion }, 'Hot-swap completed successfully');
  }

  /**
   * Unload a plugin.
   */
  async unload(pluginId: string): Promise<boolean> {
    const state = this.plugins.get(pluginId);
    if (!state) {
      return false;
    }

    // Deactivate
    if (state.plugin.lifecycle.deactivate) {
      try {
        await state.plugin.lifecycle.deactivate();
      } catch (error) {
        this.logger.warn(
          { pluginId, error: error instanceof Error ? error.message : String(error) },
          'Plugin deactivation failed'
        );
      }
    }

    // Unregister tools
    if (state.plugin.tools) {
      for (const tool of state.plugin.tools) {
        this.toolUnregisterCallback?.(`${pluginId}:${tool.name}`);
      }
    }

    // Unregister scheduler
    this.schedulerService.unregisterScheduler(pluginId);

    // Unregister event schemas (using tracked schema keys)
    const schemas = this.pluginSchemas.get(pluginId);
    if (schemas) {
      for (const schemaKey of schemas) {
        this.eventSchemas.delete(schemaKey);
        this.logger.debug({ pluginId, schemaKey }, 'Event schema unregistered');
      }
      this.pluginSchemas.delete(pluginId);
    }

    // Remove from loaded plugins
    this.plugins.delete(pluginId);

    this.logger.info({ pluginId }, 'Plugin unloaded');
    return true;
  }

  /**
   * Register an event schema for validation.
   * @param kind The event kind (e.g., 'com.lifemodel.reminder:reminder_due')
   * @param schema The Zod schema for validation
   * @param pluginId Optional plugin ID for cleanup tracking
   */
  registerEventSchema(kind: string, schema: EventSchema, pluginId?: string): void {
    this.eventSchemas.set(kind, schema);

    // Track for cleanup if pluginId provided
    if (pluginId) {
      let schemas = this.pluginSchemas.get(pluginId);
      if (!schemas) {
        schemas = new Set();
        this.pluginSchemas.set(pluginId, schemas);
      }
      schemas.add(kind);
    }

    this.logger.debug({ kind, pluginId }, 'Event schema registered');
  }

  /**
   * Get an event schema for validation.
   */
  getEventSchema(kind: string): EventSchema | undefined {
    return this.eventSchemas.get(kind);
  }

  /**
   * Validate a plugin event against its schema.
   * Returns true if valid, false if schema not found or invalid.
   */
  validatePluginEvent(data: SignalPluginEventData): { valid: boolean; error?: string } {
    const schema = this.eventSchemas.get(data.eventKind);
    if (!schema) {
      return { valid: false, error: `No schema registered for event kind: ${data.eventKind}` };
    }

    const result = schema.safeParse(data);
    if (!result.success) {
      return { valid: false, error: result.error?.message ?? 'Validation failed' };
    }

    return { valid: true };
  }

  /**
   * Get a loaded plugin by ID.
   */
  getPlugin(pluginId: string): PluginV2 | undefined {
    return this.plugins.get(pluginId)?.plugin;
  }

  /**
   * Get all loaded plugin IDs.
   */
  getLoadedPluginIds(): string[] {
    return Array.from(this.plugins.keys());
  }

  /**
   * Dispatch an event to a plugin's onEvent handler.
   * Called by scheduler service when events fire.
   */
  async dispatchPluginEvent(
    pluginId: string,
    eventKind: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const state = this.plugins.get(pluginId);
    if (!state) {
      this.logger.warn({ pluginId, eventKind }, 'Plugin not found for event dispatch');
      return;
    }

    if (state.plugin.lifecycle.onEvent) {
      await state.plugin.lifecycle.onEvent(eventKind, payload);
    }
  }

  /**
   * Run health checks on all plugins.
   */
  async healthCheck(): Promise<Map<string, { healthy: boolean; message?: string }>> {
    const results = new Map<string, { healthy: boolean; message?: string }>();

    for (const [pluginId, state] of this.plugins) {
      if (state.plugin.lifecycle.healthCheck) {
        try {
          const result = await state.plugin.lifecycle.healthCheck();
          results.set(pluginId, result);
        } catch (error) {
          results.set(pluginId, {
            healthy: false,
            message: `Health check threw: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      } else {
        results.set(pluginId, { healthy: true, message: 'No health check defined' });
      }
    }

    return results;
  }

  /**
   * Validate a plugin manifest.
   */
  private validateManifest(manifest: PluginManifestV2): void {
    // Runtime check - manifestVersion could be wrong in invalid plugins
    if ((manifest.manifestVersion as number) !== 2) {
      throw new Error(`Unsupported manifest version: ${String(manifest.manifestVersion)}`);
    }

    if (!manifest.id || typeof manifest.id !== 'string') {
      throw new Error('Plugin manifest must have a valid id');
    }

    // Validate plugin ID format: lowercase alphanumeric with hyphens or dots, no colons or whitespace
    // Allows: my-plugin, com.example.plugin, reminder
    // Disallows: My-Plugin (uppercase), plugin:name (colons break event namespacing)
    const pluginIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
    if (!pluginIdPattern.test(manifest.id)) {
      throw new Error(
        `Plugin ID '${manifest.id}' is invalid. ` +
          `Must be lowercase alphanumeric with hyphens or dots (e.g., 'my-plugin', 'com.example.plugin'), ` +
          `no colons, whitespace, or leading numbers.`
      );
    }

    if (!manifest.version || !semver.valid(manifest.version)) {
      throw new Error(`Plugin ${manifest.id} has invalid version: ${manifest.version}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!manifest.provides || manifest.provides.length === 0) {
      throw new Error(`Plugin ${manifest.id} must provide at least one component`);
    }

    // Validate that provides IDs are unique
    const provideIds = manifest.provides.map((p) => `${p.type}:${p.id}`);
    const uniqueIds = new Set(provideIds);
    if (uniqueIds.size !== provideIds.length) {
      throw new Error(`Plugin ${manifest.id} has duplicate provides entries`);
    }
  }

  /**
   * Check plugin dependencies.
   */
  private checkDependencies(manifest: PluginManifestV2): void {
    if (!manifest.dependencies) return;

    for (const dep of manifest.dependencies) {
      const loadedPlugin = this.plugins.get(dep.id);

      if (!loadedPlugin) {
        throw new Error(`Plugin ${manifest.id} requires ${dep.id} which is not loaded`);
      }

      const loadedVersion = loadedPlugin.plugin.manifest.version;

      // Check minVersion (inclusive)
      if (dep.minVersion && semver.lt(loadedVersion, dep.minVersion)) {
        throw new Error(
          `Plugin ${manifest.id} requires ${dep.id} >= ${dep.minVersion}, but ${loadedVersion} is loaded`
        );
      }

      // Check maxVersion (exclusive)
      if (dep.maxVersion && semver.gte(loadedVersion, dep.maxVersion)) {
        throw new Error(
          `Plugin ${manifest.id} requires ${dep.id} < ${dep.maxVersion}, but ${loadedVersion} is loaded`
        );
      }
    }
  }

  /**
   * Create primitives for a plugin.
   */
  private async createPrimitives(plugin: PluginV2): Promise<PluginPrimitives> {
    const { manifest } = plugin;
    const pluginLogger = this.logger.child({ plugin: manifest.id });

    // Create storage primitive
    const storageLimits = manifest.limits?.maxStorageMB
      ? { maxSizeMB: manifest.limits.maxStorageMB }
      : {};
    const storage = createStoragePrimitive(
      this.coreStorage,
      manifest.id,
      pluginLogger,
      storageLimits
    );

    // Create scheduler primitive
    const schedulerLimits = manifest.limits?.maxSchedules
      ? { maxSchedules: manifest.limits.maxSchedules }
      : {};
    const scheduler = createSchedulerPrimitive(manifest.id, storage, pluginLogger, schedulerLimits);
    await scheduler.initialize();

    // Register scheduler with service
    this.schedulerService.registerScheduler(manifest.id, scheduler);

    // Create intent emitter
    const intentEmitter = this.createIntentEmitter(manifest.id, manifest.limits?.signalsPerMinute);

    // Get base services from provider (registerEventSchema added below)
    const baseServices = this.servicesProvider?.() ?? {
      getTimezone: () => 'UTC',
    };

    // Create services with schema registration bound to this plugin
    const services: PluginServices = {
      ...baseServices,
      registerEventSchema: (kind: string, schema) => {
        this.registerEventSchema(kind, schema, manifest.id);
      },
    };

    return {
      logger: pluginLogger,
      scheduler,
      storage,
      intentEmitter,
      services,
    };
  }

  /**
   * Create an intent emitter for a plugin.
   */
  private createIntentEmitter(pluginId: string, signalRateLimit?: number): IntentEmitterPrimitive {
    // Rate limiting for signals
    let emitCount = 0;
    let lastMinuteStart = Date.now();
    const warningThreshold = signalRateLimit ?? 120;
    let warningLogged = false;

    const emitSignalImpl = (input: PluginSignalInput): EmitSignalResult => {
      const now = Date.now();
      if (now - lastMinuteStart > 60_000) {
        emitCount = 0;
        lastMinuteStart = now;
        warningLogged = false;
      }

      emitCount++;

      if (!warningLogged && emitCount >= warningThreshold) {
        this.logger.warn(
          { pluginId, emitCount, threshold: warningThreshold },
          'Plugin signal rate approaching limit'
        );
        warningLogged = true;
      }

      // Fail-soft on rate limit: drop signal and return error instead of throwing
      if (signalRateLimit && emitCount > signalRateLimit) {
        const error = `Signal rate limit exceeded for plugin ${pluginId}: ${String(signalRateLimit)}/minute`;
        this.logger.error({ pluginId, emitCount, limit: signalRateLimit }, error);
        return { success: false, error };
      }

      // Type guard: eventKind must be a string to call startsWith
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive check for runtime safety
      const eventKind = input.data?.kind;
      if (typeof eventKind !== 'string') {
        const error = `Invalid event kind: expected string, got ${typeof eventKind}`;
        this.logger.error({ pluginId, eventKind }, error);
        return { success: false, error };
      }

      if (!eventKind.startsWith(`${pluginId}:`)) {
        const error = `Invalid event kind '${eventKind}': must start with '${pluginId}:'`;
        this.logger.error({ pluginId, eventKind }, error);
        return { success: false, error };
      }

      // Deep clone payload to prevent external mutation after emit
      // Sanitize: strip any pluginId from input.data to prevent spoofing
      let sanitizedPayload: Record<string, unknown>;
      try {
        // input.data is guaranteed to exist here (checked via eventKind access above)
        sanitizedPayload = structuredClone(input.data) as Record<string, unknown>;
        delete sanitizedPayload['pluginId'];
      } catch (cloneError) {
        const error = `Failed to clone signal payload: ${cloneError instanceof Error ? cloneError.message : String(cloneError)}`;
        this.logger.error({ pluginId, error: cloneError }, error);
        return { success: false, error };
      }

      const signalId = randomUUID();
      const signal: Signal = {
        id: signalId,
        type: 'plugin_event',
        source: `plugin.${pluginId}`,
        timestamp: new Date(),
        priority: input.priority ?? 2,
        metrics: { value: 1, confidence: 1 },
        data: {
          kind: 'plugin_event',
          eventKind,
          pluginId, // Authoritative pluginId set by loader, not from input
          fireId: input.data.fireId,
          payload: sanitizedPayload,
        } as SignalPluginEventData,
        expiresAt: new Date(Date.now() + 60_000),
      };

      if (this.signalCallback) {
        this.signalCallback(signal);
        return { success: true, signalId };
      } else {
        this.logger.warn({ pluginId }, 'Signal emitted but no callback registered');
        return { success: false, error: 'No signal callback registered' };
      }
    };

    return {
      emitSendMessage: (recipientId: string, text: string, replyTo?: string): void => {
        const intent: Intent = {
          type: 'SEND_MESSAGE',
          payload: { recipientId, text, ...(replyTo && { replyTo }) },
          source: `plugin.${pluginId}`, // Provenance: which plugin emitted this
        };

        if (this.intentCallback) {
          this.intentCallback(intent);
        } else {
          this.logger.warn({ pluginId, recipientId }, 'Intent emitted but no callback registered');
        }
      },

      emitIntent: (intent: Intent): void => {
        // Add source provenance if not already set
        const intentWithSource = {
          ...intent,
          source: (intent as { source?: string }).source ?? `plugin.${pluginId}`,
        };

        if (this.intentCallback) {
          this.intentCallback(intentWithSource as Intent);
        } else {
          this.logger.warn(
            { pluginId, intentType: intent.type },
            'Intent emitted but no callback registered'
          );
        }
      },

      emitSignal: emitSignalImpl,
    };
  }

  /**
   * Register tools from a plugin.
   */
  private registerPluginTools(pluginId: string, tools: PluginTool[]): void {
    if (!this.toolRegisterCallback) {
      this.logger.warn(
        { pluginId },
        'Tool registration callback not set, skipping tool registration'
      );
      return;
    }

    for (const tool of tools) {
      // Prefix tool name with "plugin." for clear categorization
      // Results in names like "plugin.reminder", "plugin.weather"
      const prefixedTool: PluginTool = {
        ...tool,
        name: `plugin.${tool.name}`,
      };
      this.toolRegisterCallback(prefixedTool);
      this.logger.debug({ pluginId, toolName: prefixedTool.name }, 'Tool registered');
    }
  }
}

/**
 * Create a plugin loader.
 */
export function createPluginLoader(
  logger: Logger,
  coreStorage: Storage,
  schedulerService: SchedulerService,
  config?: Partial<PluginLoaderConfig>
): PluginLoader {
  return new PluginLoader(logger, coreStorage, schedulerService, config);
}
