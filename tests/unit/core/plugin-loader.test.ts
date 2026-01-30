/**
 * Tests for PluginLoader dynamic plugin management.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PluginLoader, createPluginLoader } from '../../../src/core/plugin-loader.js';
import type { PluginV2, NeuronPluginV2, PluginManifestV2 } from '../../../src/types/plugin.js';
import type { SchedulerService } from '../../../src/core/scheduler-service.js';
import type { Storage } from '../../../src/storage/storage.js';
import { createMockLogger } from '../../helpers/factories.js';
import {
  ValidationError,
  DependencyError,
  ActivationError,
  AlreadyLoadedError,
} from '../../../src/core/plugin-errors.js';

/**
 * Create a minimal mock manifest.
 */
function createMockManifest(id: string, overrides: Partial<PluginManifestV2> = {}): PluginManifestV2 {
  return {
    manifestVersion: 2,
    id,
    name: `Test Plugin ${id}`,
    version: '1.0.0',
    provides: [{ type: 'tool', id: 'test' }],
    requires: [],
    ...overrides,
  };
}

/**
 * Create a minimal mock plugin.
 */
function createMockPlugin(id: string, options: {
  activateError?: Error;
  deactivateError?: Error;
} = {}): PluginV2 {
  return {
    manifest: createMockManifest(id),
    lifecycle: {
      activate: vi.fn().mockImplementation(async () => {
        if (options.activateError) throw options.activateError;
      }),
      deactivate: vi.fn().mockImplementation(async () => {
        if (options.deactivateError) throw options.deactivateError;
      }),
    },
    tools: [],
  };
}

/**
 * Create a mock neuron plugin.
 */
function createMockNeuronPlugin(id: string): NeuronPluginV2 {
  return {
    manifest: {
      ...createMockManifest(id),
      provides: [{ type: 'neuron', id }],
    },
    lifecycle: {
      activate: vi.fn(),
      deactivate: vi.fn(),
    },
    neuron: {
      create: vi.fn().mockReturnValue({
        id,
        signalType: 'test_signal',
        source: `neuron.${id}`,
        description: `Mock neuron ${id}`,
        check: vi.fn(),
        reset: vi.fn(),
        getLastValue: vi.fn(),
      }),
      defaultConfig: {},
    },
  };
}

/**
 * Create mock storage that matches the Storage interface.
 */
function createMockStorage(): Storage {
  const data = new Map<string, unknown>();
  return {
    load: vi.fn((key: string) => Promise.resolve(data.get(key) ?? null)),
    save: vi.fn((key: string, value: unknown) => {
      data.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => {
      const had = data.has(key);
      data.delete(key);
      return Promise.resolve(had);
    }),
    exists: vi.fn((key: string) => Promise.resolve(data.has(key))),
    keys: vi.fn(() => Promise.resolve(Array.from(data.keys()))),
  } as Storage;
}

/**
 * Create mock scheduler service.
 */
function createMockSchedulerService(): SchedulerService {
  const schedulers = new Map();
  const pausedPlugins = new Set<string>();

  return {
    registerScheduler: vi.fn((id, scheduler) => schedulers.set(id, scheduler)),
    unregisterScheduler: vi.fn((id) => schedulers.delete(id)),
    queueUnregister: vi.fn(),
    getScheduler: vi.fn((id) => schedulers.get(id) ?? {
      getSchedules: () => [],
      getMigrationData: () => [],
      restoreFromMigration: vi.fn(),
    }),
    pausePlugin: vi.fn((id) => pausedPlugins.add(id)),
    resumePlugin: vi.fn((id) => pausedPlugins.delete(id)),
    isPluginPaused: vi.fn((id) => pausedPlugins.has(id)),
    setSignalCallback: vi.fn(),
    setPluginEventCallback: vi.fn(),
    tick: vi.fn(),
    applyPendingChanges: vi.fn(),
    getRegisteredPlugins: vi.fn(() => Array.from(schedulers.keys())),
    getTotalScheduleCount: vi.fn(() => 0),
  } as unknown as SchedulerService;
}

describe('PluginLoader', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let storage: Storage;
  let schedulerService: ReturnType<typeof createMockSchedulerService>;
  let pluginLoader: PluginLoader;

  beforeEach(() => {
    logger = createMockLogger();
    storage = createMockStorage();
    schedulerService = createMockSchedulerService();
    pluginLoader = createPluginLoader(logger, storage, schedulerService);
  });

  describe('load', () => {
    it('loads and activates a plugin', async () => {
      const plugin = createMockPlugin('test-plugin');

      await pluginLoader.load({ default: plugin });

      expect(plugin.lifecycle.activate).toHaveBeenCalled();
      expect(pluginLoader.getPlugin('test-plugin')).toBe(plugin);
    });

    it('throws AlreadyLoadedError for duplicate plugin', async () => {
      const plugin = createMockPlugin('test-plugin');

      await pluginLoader.load({ default: plugin });

      await expect(pluginLoader.load({ default: plugin })).rejects.toThrow(AlreadyLoadedError);
    });

    it('throws ValidationError for invalid manifest', async () => {
      const plugin = createMockPlugin('test-plugin');
      // @ts-expect-error - intentionally invalid for testing
      plugin.manifest.manifestVersion = 1;

      await expect(pluginLoader.load({ default: plugin })).rejects.toThrow(ValidationError);
    });

    it('throws ActivationError on activation failure', async () => {
      const plugin = createMockPlugin('test-plugin', {
        activateError: new Error('Connection failed'),
      });

      await expect(pluginLoader.load({ default: plugin })).rejects.toThrow(ActivationError);
    });

    it('cleans up scheduler on activation failure', async () => {
      const plugin = createMockPlugin('test-plugin', {
        activateError: new Error('Failed'),
      });

      await expect(pluginLoader.load({ default: plugin })).rejects.toThrow();

      expect(schedulerService.unregisterScheduler).toHaveBeenCalledWith('test-plugin');
    });

    it('registers neuron via callback for neuron plugins', async () => {
      const neuronPlugin = createMockNeuronPlugin('test-neuron');
      const registerCallback = vi.fn();
      const unregisterCallback = vi.fn();

      pluginLoader.setNeuronCallbacks(registerCallback, unregisterCallback);
      await pluginLoader.load({ default: neuronPlugin });

      expect(registerCallback).toHaveBeenCalled();
    });
  });

  describe('unload', () => {
    it('unloads a plugin', async () => {
      const plugin = createMockPlugin('test-plugin');
      await pluginLoader.load({ default: plugin });

      const result = await pluginLoader.unload('test-plugin');

      expect(result).toBe(true);
      expect(plugin.lifecycle.deactivate).toHaveBeenCalled();
      expect(pluginLoader.getPlugin('test-plugin')).toBeUndefined();
    });

    it('returns false for unknown plugin', async () => {
      const result = await pluginLoader.unload('non-existent');
      expect(result).toBe(false);
    });

    it('returns false for required plugin', async () => {
      // alertness is marked as required
      const plugin = createMockPlugin('alertness');
      await pluginLoader.load({ default: plugin });

      const result = await pluginLoader.unload('alertness');

      expect(result).toBe(false);
      expect(pluginLoader.getPlugin('alertness')).toBe(plugin);
    });

    it('queues scheduler unregistration', async () => {
      const plugin = createMockPlugin('test-plugin');
      await pluginLoader.load({ default: plugin });

      await pluginLoader.unload('test-plugin');

      expect(schedulerService.queueUnregister).toHaveBeenCalledWith('test-plugin');
    });

    it('unregisters neuron via callback', async () => {
      const neuronPlugin = createMockNeuronPlugin('test-neuron');
      const registerCallback = vi.fn();
      const unregisterCallback = vi.fn();

      pluginLoader.setNeuronCallbacks(registerCallback, unregisterCallback);
      await pluginLoader.load({ default: neuronPlugin });
      await pluginLoader.unload('test-neuron');

      expect(unregisterCallback).toHaveBeenCalledWith('test-neuron');
    });
  });

  describe('pause', () => {
    it('pauses an active plugin', async () => {
      const plugin = createMockPlugin('test-plugin');
      await pluginLoader.load({ default: plugin });

      const result = await pluginLoader.pause('test-plugin');

      expect(result).toBe(true);
      expect(schedulerService.pausePlugin).toHaveBeenCalledWith('test-plugin');
      expect(pluginLoader.getPluginState('test-plugin')?.state).toBe('paused');
    });

    it('returns false for required plugin', async () => {
      const plugin = createMockPlugin('alertness');
      await pluginLoader.load({ default: plugin });

      const result = await pluginLoader.pause('alertness');

      expect(result).toBe(false);
      expect(schedulerService.pausePlugin).not.toHaveBeenCalled();
    });

    it('returns false for unknown plugin', async () => {
      const result = await pluginLoader.pause('non-existent');
      expect(result).toBe(false);
    });

    it('returns false for already paused plugin', async () => {
      const plugin = createMockPlugin('test-plugin');
      await pluginLoader.load({ default: plugin });

      await pluginLoader.pause('test-plugin');
      const result = await pluginLoader.pause('test-plugin');

      expect(result).toBe(false);
    });

    it('calls deactivate lifecycle hook', async () => {
      const plugin = createMockPlugin('test-plugin');
      await pluginLoader.load({ default: plugin });

      await pluginLoader.pause('test-plugin');

      expect(plugin.lifecycle.deactivate).toHaveBeenCalled();
    });

    it('unregisters neuron on pause', async () => {
      const neuronPlugin = createMockNeuronPlugin('test-neuron');
      const unregisterCallback = vi.fn();

      pluginLoader.setNeuronCallbacks(vi.fn(), unregisterCallback);
      await pluginLoader.load({ default: neuronPlugin });
      await pluginLoader.pause('test-neuron');

      expect(unregisterCallback).toHaveBeenCalledWith('test-neuron');
    });
  });

  describe('resume', () => {
    it('resumes a paused plugin', async () => {
      const plugin = createMockPlugin('test-plugin');
      await pluginLoader.load({ default: plugin });
      await pluginLoader.pause('test-plugin');

      const result = await pluginLoader.resume('test-plugin');

      expect(result).toBe(true);
      expect(schedulerService.resumePlugin).toHaveBeenCalledWith('test-plugin');
      expect(pluginLoader.getPluginState('test-plugin')?.state).toBe('active');
    });

    it('returns false for non-paused plugin', async () => {
      const plugin = createMockPlugin('test-plugin');
      await pluginLoader.load({ default: plugin });

      const result = await pluginLoader.resume('test-plugin');

      expect(result).toBe(false);
    });

    it('re-registers neuron on resume', async () => {
      const neuronPlugin = createMockNeuronPlugin('test-neuron');
      const registerCallback = vi.fn();

      pluginLoader.setNeuronCallbacks(registerCallback, vi.fn());
      await pluginLoader.load({ default: neuronPlugin });
      registerCallback.mockClear(); // Clear initial registration

      await pluginLoader.pause('test-neuron');
      await pluginLoader.resume('test-neuron');

      expect(registerCallback).toHaveBeenCalled();
    });
  });

  describe('restart', () => {
    it('restarts a plugin with fresh state', async () => {
      const plugin = createMockPlugin('test-plugin');
      await pluginLoader.load({ default: plugin });

      const result = await pluginLoader.restart('test-plugin');

      expect(result).toBe(true);
      // Should be called twice - once for initial load, once for restart
      expect(plugin.lifecycle.activate).toHaveBeenCalledTimes(2);
    });

    it('returns false for required plugin', async () => {
      const plugin = createMockPlugin('alertness');
      await pluginLoader.load({ default: plugin });

      const result = await pluginLoader.restart('alertness');

      expect(result).toBe(false);
    });

    it('returns false for unknown plugin', async () => {
      const result = await pluginLoader.restart('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('loadWithRetry', () => {
    it('succeeds on first attempt', async () => {
      const plugin = createMockPlugin('test-plugin');

      await pluginLoader.loadWithRetry({ default: plugin });

      expect(plugin.lifecycle.activate).toHaveBeenCalledTimes(1);
    });

    it('retries on transient failure', async () => {
      let attempts = 0;
      const plugin = createMockPlugin('test-plugin');
      plugin.lifecycle.activate = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts < 2) throw new Error('Transient failure');
      });

      await pluginLoader.loadWithRetry({ default: plugin }, 3, 10);

      expect(attempts).toBe(2);
    });

    it('does not retry ValidationError', async () => {
      const plugin = createMockPlugin('test-plugin');
      // @ts-expect-error - intentionally invalid
      plugin.manifest.manifestVersion = 1;

      await expect(
        pluginLoader.loadWithRetry({ default: plugin }, 3, 10)
      ).rejects.toThrow(ValidationError);
    });

    it('does not retry DependencyError', async () => {
      const plugin = createMockPlugin('test-plugin');
      plugin.manifest.dependencies = [{ id: 'missing-dep' }];

      await expect(
        pluginLoader.loadWithRetry({ default: plugin }, 3, 10)
      ).rejects.toThrow(DependencyError);
    });

    it('throws ActivationError after max retries', async () => {
      const plugin = createMockPlugin('test-plugin', {
        activateError: new Error('Persistent failure'),
      });

      await expect(
        pluginLoader.loadWithRetry({ default: plugin }, 2, 10)
      ).rejects.toThrow(ActivationError);
    });
  });

  describe('setNeuronCallbacks', () => {
    it('registers neurons from already-loaded plugins', async () => {
      const neuronPlugin = createMockNeuronPlugin('test-neuron');
      await pluginLoader.load({ default: neuronPlugin });

      const registerCallback = vi.fn();
      pluginLoader.setNeuronCallbacks(registerCallback, vi.fn());

      expect(registerCallback).toHaveBeenCalled();
    });
  });

  describe('isRequiredPlugin', () => {
    it('returns true for alertness', () => {
      expect(pluginLoader.isRequiredPlugin('alertness')).toBe(true);
    });

    it('returns false for other plugins', () => {
      expect(pluginLoader.isRequiredPlugin('test-plugin')).toBe(false);
    });
  });

  describe('getPluginState', () => {
    it('returns state info after load', async () => {
      const plugin = createMockPlugin('test-plugin');
      await pluginLoader.load({ default: plugin });

      const state = pluginLoader.getPluginState('test-plugin');

      expect(state).toBeDefined();
      expect(state?.state).toBe('active');
      expect(state?.failureCount).toBe(0);
    });

    it('tracks failure count', async () => {
      const plugin = createMockPlugin('test-plugin', {
        activateError: new Error('Failed'),
      });

      await expect(pluginLoader.load({ default: plugin })).rejects.toThrow();

      const state = pluginLoader.getPluginState('test-plugin');
      expect(state?.state).toBe('failed');
      expect(state?.failureCount).toBe(1);
    });
  });
});
