/**
 * Tests for SchedulerService dynamic plugin management.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SchedulerService, createSchedulerService } from '../../../src/core/scheduler-service.js';
import type { SchedulerPrimitiveImpl } from '../../../src/core/scheduler-primitive.js';
import { createMockLogger } from '../../helpers/factories.js';

/**
 * Create a mock scheduler primitive for testing.
 */
function createMockSchedulerPrimitive(
  pluginId: string,
  options: { dueSchedules?: Array<{ entry: { id: string; data: Record<string, unknown> }; fireId: string }> } = {}
): SchedulerPrimitiveImpl {
  const { dueSchedules = [] } = options;

  return {
    checkDueSchedules: vi.fn().mockResolvedValue(dueSchedules),
    markFired: vi.fn().mockResolvedValue(undefined),
    getSchedules: vi.fn().mockReturnValue([]),
    getMigrationData: vi.fn().mockReturnValue([]),
    restoreFromMigration: vi.fn().mockResolvedValue(undefined),
    schedule: vi.fn().mockResolvedValue('schedule-id'),
    cancel: vi.fn().mockResolvedValue(true),
    initialize: vi.fn().mockResolvedValue(undefined),
  } as unknown as SchedulerPrimitiveImpl;
}

describe('SchedulerService', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let service: SchedulerService;

  beforeEach(() => {
    logger = createMockLogger();
    service = createSchedulerService(logger);
  });

  describe('registerScheduler', () => {
    it('registers a scheduler for a plugin', () => {
      const scheduler = createMockSchedulerPrimitive('test-plugin');

      service.registerScheduler('test-plugin', scheduler);

      expect(service.getScheduler('test-plugin')).toBe(scheduler);
    });

    it('replaces existing scheduler with warning', () => {
      const scheduler1 = createMockSchedulerPrimitive('test-plugin');
      const scheduler2 = createMockSchedulerPrimitive('test-plugin');

      service.registerScheduler('test-plugin', scheduler1);
      service.registerScheduler('test-plugin', scheduler2);

      expect(service.getScheduler('test-plugin')).toBe(scheduler2);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('unregisterScheduler', () => {
    it('removes a scheduler', () => {
      const scheduler = createMockSchedulerPrimitive('test-plugin');
      service.registerScheduler('test-plugin', scheduler);

      const removed = service.unregisterScheduler('test-plugin');

      expect(removed).toBe(true);
      expect(service.getScheduler('test-plugin')).toBeUndefined();
    });

    it('returns false for non-existent scheduler', () => {
      const removed = service.unregisterScheduler('non-existent');
      expect(removed).toBe(false);
    });

    it('also removes from pausedPlugins set', () => {
      const scheduler = createMockSchedulerPrimitive('test-plugin');
      service.registerScheduler('test-plugin', scheduler);
      service.pausePlugin('test-plugin');

      expect(service.isPluginPaused('test-plugin')).toBe(true);

      service.unregisterScheduler('test-plugin');

      expect(service.isPluginPaused('test-plugin')).toBe(false);
    });
  });

  describe('queueUnregister', () => {
    it('queues scheduler for unregistration', () => {
      const scheduler = createMockSchedulerPrimitive('test-plugin');
      service.registerScheduler('test-plugin', scheduler);

      service.queueUnregister('test-plugin');

      // Should still be registered
      expect(service.getScheduler('test-plugin')).toBe(scheduler);
    });

    it('deduplicates queue entries', () => {
      const scheduler = createMockSchedulerPrimitive('test-plugin');
      service.registerScheduler('test-plugin', scheduler);

      service.queueUnregister('test-plugin');
      service.queueUnregister('test-plugin');
      service.queueUnregister('test-plugin');

      // Should work without issues
      expect(() => service.applyPendingChanges()).not.toThrow();
      expect(service.getScheduler('test-plugin')).toBeUndefined();
    });
  });

  describe('pausePlugin / resumePlugin', () => {
    it('marks plugin as paused', () => {
      service.pausePlugin('test-plugin');
      expect(service.isPluginPaused('test-plugin')).toBe(true);
    });

    it('marks plugin as resumed', () => {
      service.pausePlugin('test-plugin');
      service.resumePlugin('test-plugin');
      expect(service.isPluginPaused('test-plugin')).toBe(false);
    });

    it('pause is idempotent', () => {
      service.pausePlugin('test-plugin');
      service.pausePlugin('test-plugin');
      service.pausePlugin('test-plugin');
      expect(service.isPluginPaused('test-plugin')).toBe(true);
    });

    it('resume is idempotent', () => {
      service.pausePlugin('test-plugin');
      service.resumePlugin('test-plugin');
      service.resumePlugin('test-plugin');
      expect(service.isPluginPaused('test-plugin')).toBe(false);
    });
  });

  describe('applyPendingChanges', () => {
    it('unregisters queued schedulers', () => {
      const scheduler = createMockSchedulerPrimitive('test-plugin');
      service.registerScheduler('test-plugin', scheduler);

      service.queueUnregister('test-plugin');
      service.applyPendingChanges();

      expect(service.getScheduler('test-plugin')).toBeUndefined();
    });

    it('clears queue after applying', () => {
      const scheduler = createMockSchedulerPrimitive('test-plugin');
      service.registerScheduler('test-plugin', scheduler);

      service.queueUnregister('test-plugin');
      service.applyPendingChanges();

      // Re-register
      service.registerScheduler('test-plugin', scheduler);

      // Second apply should not unregister again
      service.applyPendingChanges();
      expect(service.getScheduler('test-plugin')).toBe(scheduler);
    });

    it('is safe to call with empty queue', () => {
      expect(() => service.applyPendingChanges()).not.toThrow();
    });
  });

  describe('tick', () => {
    it('skips paused plugins', async () => {
      const scheduler = createMockSchedulerPrimitive('test-plugin', {
        dueSchedules: [
          { entry: { id: 'sched-1', data: { kind: 'test:event' } }, fireId: 'fire-1' },
        ],
      });
      service.registerScheduler('test-plugin', scheduler);
      service.setSignalCallback(vi.fn());

      // Pause the plugin
      service.pausePlugin('test-plugin');

      await service.tick();

      // Scheduler should not be checked
      expect(scheduler.checkDueSchedules).not.toHaveBeenCalled();
    });

    it('fires events for non-paused plugins', async () => {
      const signalCallback = vi.fn();
      const scheduler = createMockSchedulerPrimitive('test-plugin', {
        dueSchedules: [
          { entry: { id: 'sched-1', data: { kind: 'test:event' } }, fireId: 'fire-1' },
        ],
      });
      service.registerScheduler('test-plugin', scheduler);
      service.setSignalCallback(signalCallback);

      await service.tick();

      expect(scheduler.checkDueSchedules).toHaveBeenCalled();
      expect(signalCallback).toHaveBeenCalled();
    });

    it('resumes firing after plugin is resumed', async () => {
      const signalCallback = vi.fn();
      const scheduler = createMockSchedulerPrimitive('test-plugin', {
        dueSchedules: [
          { entry: { id: 'sched-1', data: { kind: 'test:event' } }, fireId: 'fire-1' },
        ],
      });
      service.registerScheduler('test-plugin', scheduler);
      service.setSignalCallback(signalCallback);

      // Pause, tick, resume, tick
      service.pausePlugin('test-plugin');
      await service.tick();
      expect(signalCallback).not.toHaveBeenCalled();

      service.resumePlugin('test-plugin');
      await service.tick();
      expect(signalCallback).toHaveBeenCalled();
    });
  });

  describe('getRegisteredPlugins', () => {
    it('returns all registered plugin IDs', () => {
      service.registerScheduler('plugin-a', createMockSchedulerPrimitive('plugin-a'));
      service.registerScheduler('plugin-b', createMockSchedulerPrimitive('plugin-b'));

      const plugins = service.getRegisteredPlugins();

      expect(plugins).toContain('plugin-a');
      expect(plugins).toContain('plugin-b');
      expect(plugins.length).toBe(2);
    });
  });
});
