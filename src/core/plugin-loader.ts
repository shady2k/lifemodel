/**
 * Plugin Loader
 *
 * Manages plugin lifecycle: loading, activation, hot-swap, and deactivation.
 * Validates manifests, checks dependencies, and creates plugin primitives.
 *
 * Dynamic Registration:
 * - Supports runtime load/unload/pause/resume of plugins
 * - Neuron plugins are registered with AUTONOMIC layer via callbacks
 * - Required plugins (e.g., alertness) cannot be paused/unloaded
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
  NeuronPluginV2,
  PluginStateInfo,
} from '../types/plugin.js';
import { isNeuronPlugin } from '../types/plugin.js';
import type { Intent } from '../types/intent.js';
import { createStoragePrimitive, type StoragePrimitiveImpl } from './storage-primitive.js';
import { createSchedulerPrimitive, type SchedulerPrimitiveImpl } from './scheduler-primitive.js';
import type { SchedulerService } from './scheduler-service.js';
import type { Neuron } from '../layers/autonomic/neuron-registry.js';
import {
  ValidationError,
  DependencyError,
  ActivationError,
  AlreadyLoadedError,
} from './plugin-errors.js';

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
 * Callback type for registering neurons with AUTONOMIC layer.
 */
export type NeuronRegisterCallback = (neuron: Neuron) => void;

/**
 * Callback type for unregistering neurons from AUTONOMIC layer.
 */
export type NeuronUnregisterCallback = (id: string) => void;

/**
 * Loaded plugin state.
 */
interface LoadedPluginState {
  plugin: PluginV2;
  storage: StoragePrimitiveImpl;
  scheduler: SchedulerPrimitiveImpl;
  loadedAt: Date;
  status: 'active' | 'paused';
  /** Unique instance ID (changes on reload for stale reference detection) */
  instanceId: string;
}

/**
 * Plugin loader configuration.
 */
export interface PluginLoaderConfig {
  /** Drain mode timeout in ms (default: 5 minutes) - reserved for future use */
  drainTimeoutMs?: number;
  /** Per-plugin configuration (keyed by plugin ID) */
  pluginConfigs?: Record<string, unknown>;
}

/**
 * Plugin loader - manages plugin lifecycle.
 */
export class PluginLoader {
  private readonly logger: Logger;
  private readonly coreStorage: Storage;
  private readonly schedulerService: SchedulerService;
  private readonly config: Partial<PluginLoaderConfig>;

  private readonly plugins = new Map<string, LoadedPluginState>();
  private readonly eventSchemas = new Map<string, EventSchema>();
  /** Track which schemas each plugin registered (for cleanup) */
  private readonly pluginSchemas = new Map<string, Set<string>>();
  /** Track neuron plugins separately for AUTONOMIC layer access */
  private readonly neuronPlugins: NeuronPluginV2[] = [];

  private signalCallback: SignalPushCallback | null = null;
  private intentCallback: IntentEmitCallback | null = null;
  private toolRegisterCallback: ToolRegisterCallback | null = null;
  private toolUnregisterCallback: ToolUnregisterCallback | null = null;
  private servicesProvider: (() => BasePluginServices) | null = null;
  private neuronRegisterCallback: NeuronRegisterCallback | null = null;
  private neuronUnregisterCallback: NeuronUnregisterCallback | null = null;

  /** Buffer for signals emitted before callback is set (capped at 100) */
  private signalBuffer: Signal[] = [];
  /** Buffer for intents emitted before callback is set (capped at 100) */
  private intentBuffer: Intent[] = [];
  /** Maximum buffer size to prevent unbounded growth */
  private static readonly MAX_BUFFER_SIZE = 100;

  /** Plugin state tracking for lifecycle management */
  private readonly pluginStates = new Map<string, PluginStateInfo>();

  /** Required plugins that cannot be paused/unloaded/restarted */
  private readonly requiredPlugins = new Set(['alertness']);

  /** Map pluginId to neuron ID (for correct unregistration) */
  private readonly pluginNeuronIds = new Map<string, string>();

  constructor(
    logger: Logger,
    coreStorage: Storage,
    schedulerService: SchedulerService,
    config: Partial<PluginLoaderConfig> = {}
  ) {
    this.logger = logger.child({ component: 'plugin-loader' });
    this.coreStorage = coreStorage;
    this.schedulerService = schedulerService;
    this.config = config;
  }

  /**
   * Set the callback for pushing signals into the pipeline.
   * Flushes any buffered signals from plugin activation.
   */
  setSignalCallback(callback: SignalPushCallback): void {
    this.signalCallback = callback;

    // Flush buffered signals
    if (this.signalBuffer.length > 0) {
      this.logger.debug({ count: this.signalBuffer.length }, 'Flushing buffered signals');
      for (const signal of this.signalBuffer) {
        callback(signal);
      }
      this.signalBuffer = [];
    }
  }

  /**
   * Set the callback for emitting intents.
   * Used by IntentEmitter to route intents to core loop.
   * Flushes any buffered intents from plugin activation.
   */
  setIntentCallback(callback: IntentEmitCallback): void {
    this.intentCallback = callback;

    // Flush buffered intents
    if (this.intentBuffer.length > 0) {
      this.logger.debug({ count: this.intentBuffer.length }, 'Flushing buffered intents');
      for (const intent of this.intentBuffer) {
        callback(intent);
      }
      this.intentBuffer = [];
    }
  }

  /**
   * Set callbacks for tool registration.
   * Also registers tools from any already-loaded plugins.
   */
  setToolCallbacks(register: ToolRegisterCallback, unregister: ToolUnregisterCallback): void {
    this.toolRegisterCallback = register;
    this.toolUnregisterCallback = unregister;

    // Register tools from already-loaded plugins (handles case where plugins load before layers)
    for (const [pluginId, state] of this.plugins) {
      const tools = state.plugin.tools;
      if (tools && tools.length > 0) {
        this.registerPluginTools(pluginId, tools);
      }
    }
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
   * Set callbacks for neuron registration with AUTONOMIC layer.
   * Must be called before loading any neuron plugins.
   *
   * Also registers neurons from any already-loaded plugins (handles startup order).
   */
  setNeuronCallbacks(register: NeuronRegisterCallback, unregister: NeuronUnregisterCallback): void {
    this.neuronRegisterCallback = register;
    this.neuronUnregisterCallback = unregister;

    // Register neurons from already-loaded plugins (handles case where plugins load before layers)
    for (const plugin of this.neuronPlugins) {
      const config = this.getPluginConfig(plugin.manifest.id) ?? plugin.neuron.defaultConfig;
      const neuron = plugin.neuron.create(this.logger, config);
      this.neuronRegisterCallback(neuron);
      // Track neuron ID for correct unregistration
      this.pluginNeuronIds.set(plugin.manifest.id, neuron.id);
      this.logger.debug(
        { pluginId: plugin.manifest.id, neuronId: neuron.id },
        'Neuron registered from already-loaded plugin'
      );
    }
  }

  /**
   * Check if a plugin can be removed (paused/unloaded/restarted).
   * Required plugins cannot be removed.
   */
  private canRemove(pluginId: string): boolean {
    if (this.requiredPlugins.has(pluginId)) {
      this.logger.error({ pluginId }, 'Cannot remove required plugin');
      return false;
    }
    return true;
  }

  /**
   * Load and activate a plugin.
   *
   * @throws ValidationError if manifest is invalid
   * @throws DependencyError if dependencies are not met
   * @throws AlreadyLoadedError if plugin is already loaded
   * @throws ActivationError if activation fails
   */
  async load(pluginModule: { default: PluginV2 }): Promise<void> {
    const plugin = pluginModule.default;
    const { manifest } = plugin;

    // Update state tracking
    this.pluginStates.set(manifest.id, {
      state: 'loading',
      failureCount: this.pluginStates.get(manifest.id)?.failureCount ?? 0,
      lastAttemptAt: new Date(),
    });

    // Validate manifest (throws ValidationError)
    try {
      this.validateManifest(manifest);
    } catch (error) {
      this.pluginStates.set(manifest.id, {
        state: 'failed',
        failureCount: (this.pluginStates.get(manifest.id)?.failureCount ?? 0) + 1,
        lastError: error instanceof Error ? error.message : String(error),
        lastAttemptAt: new Date(),
      });
      throw error;
    }

    // Check if already loaded
    if (this.plugins.has(manifest.id)) {
      // Don't mark as failed - plugin is loaded, just can't load again
      throw new AlreadyLoadedError(manifest.id);
    }

    // Check dependencies (throws DependencyError)
    try {
      this.checkDependencies(manifest);
    } catch (error) {
      this.pluginStates.set(manifest.id, {
        state: 'failed',
        failureCount: (this.pluginStates.get(manifest.id)?.failureCount ?? 0) + 1,
        lastError: error instanceof Error ? error.message : String(error),
        lastAttemptAt: new Date(),
      });
      throw error;
    }

    // Create primitives
    let primitives: PluginPrimitives;
    try {
      primitives = await this.createPrimitives(plugin);
    } catch (error) {
      this.pluginStates.set(manifest.id, {
        state: 'failed',
        failureCount: (this.pluginStates.get(manifest.id)?.failureCount ?? 0) + 1,
        lastError: `Primitive creation failed: ${error instanceof Error ? error.message : String(error)}`,
        lastAttemptAt: new Date(),
      });
      throw new ActivationError(
        manifest.id,
        `Failed to create primitives: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Activate plugin
    try {
      await plugin.lifecycle.activate(primitives);
    } catch (error) {
      // Clean up ALL resources on activation failure
      await primitives.storage.clear();
      this.schedulerService.unregisterScheduler(manifest.id);

      // Update state tracking
      const prevState = this.pluginStates.get(manifest.id);
      this.pluginStates.set(manifest.id, {
        state: 'failed',
        failureCount: (prevState?.failureCount ?? 0) + 1,
        lastError: error instanceof Error ? error.message : String(error),
        lastAttemptAt: new Date(),
      });

      throw new ActivationError(
        manifest.id,
        error instanceof Error ? error.message : String(error)
      );
    }

    // Register tools (read after activation - tools may be created during activate())
    const tools = plugin.tools;
    if (tools && tools.length > 0) {
      this.registerPluginTools(manifest.id, tools);
    }

    // Track and register neuron plugins
    if (isNeuronPlugin(plugin)) {
      this.neuronPlugins.push(plugin);

      // Register neuron with AUTONOMIC layer if callback is set
      if (this.neuronRegisterCallback) {
        const config = this.getPluginConfig(manifest.id) ?? plugin.neuron.defaultConfig;
        const neuron = plugin.neuron.create(this.logger, config);
        this.neuronRegisterCallback(neuron);
        // Track neuron ID for correct unregistration (neuron.id may differ from pluginId)
        this.pluginNeuronIds.set(manifest.id, neuron.id);
      }

      this.logger.debug({ pluginId: manifest.id }, 'Registered as neuron plugin');
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
      instanceId: randomUUID(),
    };
    this.plugins.set(manifest.id, state);

    // Update state tracking
    this.pluginStates.set(manifest.id, {
      state: 'active',
      failureCount: 0,
    });

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

    // Unregister old tools (use same naming as registerPluginTools: plugin.${name})
    const oldTools = oldState.plugin.tools;
    if (oldTools) {
      for (const tool of oldTools) {
        this.toolUnregisterCallback?.(`plugin.${tool.name}`);
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
      instanceId: randomUUID(),
    };
    this.plugins.set(pluginId, newState);

    // Handle neuron plugin updates (unregister old, register new)
    const oldNeuronIndex = this.neuronPlugins.findIndex((p) => p.manifest.id === pluginId);
    const wasNeuron = oldNeuronIndex !== -1;

    if (wasNeuron) {
      this.neuronPlugins.splice(oldNeuronIndex, 1);
      // Unregister old neuron using tracked ID
      const oldNeuronId = this.pluginNeuronIds.get(pluginId);
      if (oldNeuronId) {
        this.neuronUnregisterCallback?.(oldNeuronId);
        this.pluginNeuronIds.delete(pluginId);
      }
    }

    if (isNeuronPlugin(newPlugin)) {
      this.neuronPlugins.push(newPlugin);
      // Register new neuron and track its ID
      if (this.neuronRegisterCallback) {
        const config = this.getPluginConfig(pluginId) ?? newPlugin.neuron.defaultConfig;
        const neuron = newPlugin.neuron.create(this.logger, config);
        this.neuronRegisterCallback(neuron);
        this.pluginNeuronIds.set(pluginId, neuron.id);
      }
      this.logger.debug({ pluginId }, 'Neuron plugin updated in hot-swap');
    }

    // Update state tracking
    this.pluginStates.set(pluginId, { state: 'active', failureCount: 0 });

    this.logger.info({ pluginId, oldVersion, newVersion }, 'Hot-swap completed successfully');
  }

  /**
   * Unload a plugin completely.
   * Clears storage, unregisters all components, removes from registry.
   *
   * @returns true if unloaded, false if not loaded or is required plugin
   */
  async unload(pluginId: string): Promise<boolean> {
    // Block unloading required plugins
    if (!this.canRemove(pluginId)) {
      return false;
    }

    const state = this.plugins.get(pluginId);
    if (!state) {
      this.logger.warn({ pluginId }, 'Cannot unload unknown plugin');
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
        this.toolUnregisterCallback?.(`plugin.${tool.name}`);
      }
    }

    // Unregister neuron from AUTONOMIC layer (use tracked neuron ID, not pluginId)
    if (isNeuronPlugin(state.plugin)) {
      const neuronId = this.pluginNeuronIds.get(pluginId);
      if (neuronId) {
        this.neuronUnregisterCallback?.(neuronId);
        this.pluginNeuronIds.delete(pluginId);
      }
    }

    // Unregister scheduler (queued for tick boundary in SchedulerService)
    this.schedulerService.queueUnregister(pluginId);

    // Unregister event schemas (using tracked schema keys)
    const schemas = this.pluginSchemas.get(pluginId);
    if (schemas) {
      for (const schemaKey of schemas) {
        this.eventSchemas.delete(schemaKey);
        this.logger.debug({ pluginId, schemaKey }, 'Event schema unregistered');
      }
      this.pluginSchemas.delete(pluginId);
    }

    // Remove from neuron plugins list
    const neuronIndex = this.neuronPlugins.findIndex((p) => p.manifest.id === pluginId);
    if (neuronIndex !== -1) {
      this.neuronPlugins.splice(neuronIndex, 1);
      this.logger.debug({ pluginId }, 'Neuron plugin removed from list');
    }

    // Clear storage (unload is a full removal)
    await state.storage.clear();

    // Remove from loaded plugins
    this.plugins.delete(pluginId);

    // Update state tracking
    this.pluginStates.delete(pluginId);

    this.logger.info({ pluginId }, 'Plugin unloaded');
    return true;
  }

  /**
   * Pause a plugin (deactivate but keep state).
   * Paused plugins can be resumed with their state intact.
   *
   * @returns true if paused, false if required plugin, unknown, or already paused
   */
  async pause(pluginId: string): Promise<boolean> {
    // Block pausing required plugins
    if (!this.canRemove(pluginId)) {
      return false;
    }

    const state = this.plugins.get(pluginId);
    if (!state) {
      this.logger.warn({ pluginId }, 'Cannot pause unknown plugin');
      return false;
    }

    if (state.status !== 'active') {
      this.logger.warn(
        { pluginId, status: state.status },
        'Cannot pause plugin not in active state'
      );
      return false;
    }

    // IMMEDIATE: Mark scheduler as paused (stops firing immediately)
    this.schedulerService.pausePlugin(pluginId);

    // QUEUED: Unregister neuron (applied at tick boundary, use tracked neuron ID)
    if (isNeuronPlugin(state.plugin)) {
      const neuronId = this.pluginNeuronIds.get(pluginId);
      if (neuronId) {
        this.neuronUnregisterCallback?.(neuronId);
        // Don't delete from pluginNeuronIds - we'll re-register on resume
      }
    }

    // IMMEDIATE: Unregister tools (safe, no iteration issues)
    if (state.plugin.tools) {
      for (const tool of state.plugin.tools) {
        this.toolUnregisterCallback?.(`plugin.${tool.name}`);
      }
    }

    // IMMEDIATE: Unregister event schemas (paused plugin should not process events)
    const schemas = this.pluginSchemas.get(pluginId);
    if (schemas) {
      for (const schemaKey of schemas) {
        this.eventSchemas.delete(schemaKey);
      }
      // Keep the schema keys list for re-registration on resume
    }

    // Call plugin's deactivate if exists
    if (state.plugin.lifecycle.deactivate) {
      try {
        await state.plugin.lifecycle.deactivate();
      } catch (error) {
        this.logger.warn(
          { pluginId, error: error instanceof Error ? error.message : String(error) },
          'Plugin deactivation during pause failed'
        );
      }
    }

    // Update state
    state.status = 'paused';
    this.pluginStates.set(pluginId, {
      state: 'paused',
      failureCount: 0,
      pausedAt: new Date(),
    });

    this.logger.info({ pluginId }, 'Plugin paused');
    return true;
  }

  /**
   * Resume a paused plugin.
   * Re-activates the plugin with its preserved state.
   *
   * @returns true if resumed, false if not paused or resume failed
   */
  async resume(pluginId: string): Promise<boolean> {
    const state = this.plugins.get(pluginId);
    if (!state) {
      this.logger.warn({ pluginId }, 'Cannot resume unknown plugin');
      return false;
    }

    if (state.status !== 'paused') {
      this.logger.warn(
        { pluginId, status: state.status },
        'Cannot resume plugin not in paused state'
      );
      return false;
    }

    // Re-create primitives and reactivate
    let primitives: PluginPrimitives;
    try {
      primitives = await this.createPrimitives(state.plugin);
      await state.plugin.lifecycle.activate(primitives);
    } catch (error) {
      this.logger.error(
        { pluginId, error: error instanceof Error ? error.message : String(error) },
        'Plugin resume failed'
      );
      return false;
    }

    // Resume scheduler
    this.schedulerService.resumePlugin(pluginId);

    // Re-register neuron if applicable
    if (isNeuronPlugin(state.plugin)) {
      const config = this.getPluginConfig(pluginId) ?? state.plugin.neuron.defaultConfig;
      const neuron = state.plugin.neuron.create(this.logger, config);
      this.neuronRegisterCallback?.(neuron);
      // Update tracked neuron ID (may have changed if neuron factory changed)
      this.pluginNeuronIds.set(pluginId, neuron.id);
    }

    // Re-register tools
    if (state.plugin.tools) {
      this.registerPluginTools(pluginId, state.plugin.tools);
    }

    // Note: Event schemas would need to be re-registered by the plugin in activate()

    // Update state with new primitives references
    const newScheduler = this.schedulerService.getScheduler(pluginId);
    if (newScheduler) {
      state.scheduler = newScheduler;
    }
    state.storage = primitives.storage as StoragePrimitiveImpl;
    state.loadedAt = new Date();
    state.instanceId = randomUUID();
    state.status = 'active';
    this.pluginStates.set(pluginId, { state: 'active', failureCount: 0 });

    this.logger.info({ pluginId }, 'Plugin resumed');
    return true;
  }

  /**
   * Restart a plugin (unload + load with fresh state).
   *
   * @returns true if restarted, false if required plugin or restart failed
   */
  async restart(pluginId: string): Promise<boolean> {
    // Block restarting required plugins
    if (!this.canRemove(pluginId)) {
      return false;
    }

    const state = this.plugins.get(pluginId);
    if (!state) {
      this.logger.warn({ pluginId }, 'Cannot restart unknown plugin');
      return false;
    }

    // Save plugin reference before unload
    const plugin = state.plugin;

    try {
      // Full unload (clears storage, unregisters everything)
      await this.unload(pluginId);
    } catch (unloadError) {
      this.logger.error(
        {
          pluginId,
          error: unloadError instanceof Error ? unloadError.message : String(unloadError),
        },
        'Restart failed: unload error'
      );
      return false;
    }

    try {
      // Fresh load with clean state
      await this.load({ default: plugin });
      this.logger.info({ pluginId }, 'Plugin restarted');
      return true;
    } catch (loadError) {
      // Load failed after unload - plugin is now inactive
      this.logger.error(
        { pluginId, error: loadError instanceof Error ? loadError.message : String(loadError) },
        'Restart failed: reload error, plugin inactive'
      );
      return false;
    }
  }

  /**
   * Load plugin with retry logic for transient failures.
   * Does not retry validation or dependency errors.
   *
   * @param pluginModule The plugin module to load
   * @param maxRetries Maximum retry attempts (default: 3)
   * @param baseBackoffMs Base backoff delay in ms (default: 1000)
   */
  async loadWithRetry(
    pluginModule: { default: PluginV2 },
    maxRetries = 3,
    baseBackoffMs = 1000
  ): Promise<void> {
    const pluginId = pluginModule.default.manifest.id;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.load(pluginModule);
        return; // Success
      } catch (error) {
        // Don't retry validation, dependency, or already-loaded errors
        if (
          error instanceof ValidationError ||
          error instanceof DependencyError ||
          error instanceof AlreadyLoadedError
        ) {
          throw error;
        }

        if (attempt === maxRetries) {
          throw new ActivationError(
            pluginId,
            `Failed after ${String(maxRetries)} attempts: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        // Clean up scheduler before retry (prevents leaks)
        this.schedulerService.unregisterScheduler(pluginId);

        const delay = baseBackoffMs * Math.pow(2, attempt - 1);
        this.logger.warn({ pluginId, attempt, nextRetryMs: delay }, 'Retrying plugin load');
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  /**
   * Get the state info for a plugin.
   */
  getPluginState(pluginId: string): PluginStateInfo | undefined {
    return this.pluginStates.get(pluginId);
  }

  /**
   * Check if a plugin is a required plugin.
   */
  isRequiredPlugin(pluginId: string): boolean {
    return this.requiredPlugins.has(pluginId);
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
   * Get all loaded neuron plugins.
   * Used by AUTONOMIC layer to instantiate neurons from plugins.
   */
  getNeuronPlugins(): NeuronPluginV2[] {
    return [...this.neuronPlugins];
  }

  /**
   * Get configuration for a specific plugin.
   * Returns undefined if no config is set for this plugin.
   */
  getPluginConfig(pluginId: string): unknown {
    return this.config.pluginConfigs?.[pluginId];
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
   * @throws ValidationError if manifest is invalid
   */
  private validateManifest(manifest: PluginManifestV2): void {
    // Runtime check - manifestVersion could be wrong in invalid plugins
    if ((manifest.manifestVersion as number) !== 2) {
      // manifest.id might be missing in truly invalid manifests
      const pluginId = typeof manifest.id === 'string' ? manifest.id : 'unknown';
      throw new ValidationError(
        pluginId,
        `Unsupported manifest version: ${String(manifest.manifestVersion)}`
      );
    }

    if (!manifest.id || typeof manifest.id !== 'string') {
      throw new ValidationError('unknown', 'Plugin manifest must have a valid id');
    }

    // Validate plugin ID format: lowercase alphanumeric with hyphens or dots, no colons or whitespace
    // Allows: my-plugin, com.example.plugin, reminder
    // Disallows: My-Plugin (uppercase), plugin:name (colons break event namespacing)
    const pluginIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
    if (!pluginIdPattern.test(manifest.id)) {
      throw new ValidationError(
        manifest.id,
        `Invalid plugin ID format. ` +
          `Must be lowercase alphanumeric with hyphens or dots (e.g., 'my-plugin', 'com.example.plugin'), ` +
          `no colons, whitespace, or leading numbers.`
      );
    }

    if (!manifest.version || !semver.valid(manifest.version)) {
      // Use explicit check since TS thinks manifest.version is always defined
      const versionStr = manifest.version || 'undefined';
      throw new ValidationError(manifest.id, `Invalid version: ${versionStr}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!manifest.provides || manifest.provides.length === 0) {
      throw new ValidationError(manifest.id, 'Must provide at least one component');
    }

    // Validate that provides IDs are unique
    const provideIds = manifest.provides.map((p) => `${p.type}:${p.id}`);
    const uniqueIds = new Set(provideIds);
    if (uniqueIds.size !== provideIds.length) {
      throw new ValidationError(manifest.id, 'Has duplicate provides entries');
    }
  }

  /**
   * Check plugin dependencies.
   * @throws DependencyError if dependencies are not satisfied
   */
  private checkDependencies(manifest: PluginManifestV2): void {
    if (!manifest.dependencies) return;

    for (const dep of manifest.dependencies) {
      const loadedPlugin = this.plugins.get(dep.id);

      if (!loadedPlugin) {
        throw new DependencyError(manifest.id, dep.id);
      }

      const loadedVersion = loadedPlugin.plugin.manifest.version;

      // Check minVersion (inclusive)
      if (dep.minVersion && semver.lt(loadedVersion, dep.minVersion)) {
        throw new DependencyError(
          manifest.id,
          dep.id,
          `requires ${dep.id} >= ${dep.minVersion}, but ${loadedVersion} is loaded`
        );
      }

      // Check maxVersion (exclusive)
      if (dep.maxVersion && semver.gte(loadedVersion, dep.maxVersion)) {
        throw new DependencyError(
          manifest.id,
          dep.id,
          `requires ${dep.id} < ${dep.maxVersion}, but ${loadedVersion} is loaded`
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
      } else {
        // Buffer signal until callback is set (during plugin activation)
        if (this.signalBuffer.length < PluginLoader.MAX_BUFFER_SIZE) {
          this.signalBuffer.push(signal);
          this.logger.debug({ pluginId }, 'Signal buffered (callback not yet registered)');
        } else {
          this.logger.warn({ pluginId }, 'Signal buffer full, dropping signal');
        }
      }
      return { success: true, signalId };
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
          // Buffer intent until callback is set (during plugin activation)
          if (this.intentBuffer.length < PluginLoader.MAX_BUFFER_SIZE) {
            this.intentBuffer.push(intent);
            this.logger.debug(
              { pluginId, recipientId },
              'Intent buffered (callback not yet registered)'
            );
          } else {
            this.logger.warn({ pluginId, recipientId }, 'Intent buffer full, dropping intent');
          }
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
          // Buffer intent until callback is set (during plugin activation)
          if (this.intentBuffer.length < PluginLoader.MAX_BUFFER_SIZE) {
            this.intentBuffer.push(intentWithSource as Intent);
            this.logger.debug(
              { pluginId, intentType: intent.type },
              'Intent buffered (callback not yet registered)'
            );
          } else {
            this.logger.warn(
              { pluginId, intentType: intent.type },
              'Intent buffer full, dropping intent'
            );
          }
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
