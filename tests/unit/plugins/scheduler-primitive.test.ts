/**
 * Scheduler Primitive Tests
 *
 * Tests for the plugin scheduler with recurrence and idempotency.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createSchedulerPrimitive,
  type SchedulerPrimitiveImpl,
} from '../../../src/core/scheduler-primitive.js';
import { createStoragePrimitive } from '../../../src/core/storage-primitive.js';
import type { Storage } from '../../../src/storage/storage.js';

describe('SchedulerPrimitive', () => {
  let mockStorage: Storage;
  let scheduler: SchedulerPrimitiveImpl;
  const pluginId = 'test.plugin';
  const mockLogger = {
    child: vi.fn(() => mockLogger),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    level: 'debug',
  } as unknown as import('../../../src/types/logger.js').Logger;

  beforeEach(async () => {
    const data: Record<string, unknown> = {};

    mockStorage = {
      load: vi.fn(async (key: string) => data[key] ?? null),
      save: vi.fn(async (key: string, value: unknown) => {
        data[key] = value;
      }),
      delete: vi.fn(async (key: string) => {
        const existed = key in data;
        delete data[key];
        return existed;
      }),
      exists: vi.fn(async (key: string) => key in data),
      keys: vi.fn(async (pattern?: string) => {
        const allKeys = Object.keys(data);
        if (!pattern) return allKeys;
        const prefix = pattern.replace('*', '');
        return allKeys.filter((k) => k.startsWith(prefix));
      }),
    };

    const storagePrimitive = createStoragePrimitive(mockStorage, pluginId, mockLogger);
    scheduler = createSchedulerPrimitive(pluginId, storagePrimitive, mockLogger);
    await scheduler.initialize();
  });

  describe('schedule', () => {
    it('should create a one-time schedule', async () => {
      const fireAt = new Date(Date.now() + 60000); // 1 minute from now

      const scheduleId = await scheduler.schedule({
        fireAt,
        data: { action: 'test' },
      });

      expect(scheduleId).toBeTruthy();
      expect(scheduleId).toMatch(/^sched_/);

      const schedules = await scheduler.getSchedules();
      expect(schedules).toHaveLength(1);
      expect(schedules[0]?.recurrence).toBeNull();
    });

    it('should create a recurring schedule', async () => {
      const fireAt = new Date(Date.now() + 60000);

      const scheduleId = await scheduler.schedule({
        fireAt,
        recurrence: {
          frequency: 'daily',
          interval: 1,
          endDate: null,
          maxOccurrences: null,
        },
        timezone: 'America/New_York',
        data: { action: 'daily-task' },
      });

      const schedules = await scheduler.getSchedules();
      expect(schedules).toHaveLength(1);
      expect(schedules[0]?.recurrence?.frequency).toBe('daily');
      expect(schedules[0]?.timezone).toBe('America/New_York');
    });

    it('should use provided schedule ID', async () => {
      const fireAt = new Date(Date.now() + 60000);

      const scheduleId = await scheduler.schedule({
        id: 'custom-id-123',
        fireAt,
        data: { action: 'test' },
      });

      expect(scheduleId).toBe('custom-id-123');
    });
  });

  describe('cancel', () => {
    it('should cancel an existing schedule', async () => {
      const fireAt = new Date(Date.now() + 60000);
      const scheduleId = await scheduler.schedule({
        fireAt,
        data: { action: 'test' },
      });

      const cancelled = await scheduler.cancel(scheduleId);

      expect(cancelled).toBe(true);
      const schedules = await scheduler.getSchedules();
      expect(schedules).toHaveLength(0);
    });

    it('should return false for non-existent schedule', async () => {
      const cancelled = await scheduler.cancel('nonexistent');

      expect(cancelled).toBe(false);
    });
  });

  describe('checkDueSchedules', () => {
    it('should return due schedules', async () => {
      const now = new Date();
      const pastTime = new Date(now.getTime() - 1000); // 1 second ago

      await scheduler.schedule({
        fireAt: pastTime,
        data: { action: 'past-task' },
      });

      const dueSchedules = await scheduler.checkDueSchedules(now);

      expect(dueSchedules).toHaveLength(1);
      expect(dueSchedules[0]?.entry.data.action).toBe('past-task');
      expect(dueSchedules[0]?.fireId).toBeTruthy();
    });

    it('should not return future schedules', async () => {
      const now = new Date();
      const futureTime = new Date(now.getTime() + 60000); // 1 minute from now

      await scheduler.schedule({
        fireAt: futureTime,
        data: { action: 'future-task' },
      });

      const dueSchedules = await scheduler.checkDueSchedules(now);

      expect(dueSchedules).toHaveLength(0);
    });
  });

  describe('idempotency', () => {
    it('should not return same schedule twice with same fireId', async () => {
      const now = new Date();
      const pastTime = new Date(now.getTime() - 1000);

      await scheduler.schedule({
        id: 'idem-test',
        fireAt: pastTime,
        data: { action: 'test' },
      });

      // First check
      const firstCheck = await scheduler.checkDueSchedules(now);
      expect(firstCheck).toHaveLength(1);

      // Mark as fired
      await scheduler.markFired('idem-test', firstCheck[0]!.fireId, now);

      // Second check - should not return same schedule
      const secondCheck = await scheduler.checkDueSchedules(now);
      expect(secondCheck).toHaveLength(0);
    });
  });

  describe('markFired', () => {
    it('should remove one-time schedule after firing', async () => {
      const now = new Date();
      const pastTime = new Date(now.getTime() - 1000);

      await scheduler.schedule({
        id: 'one-time',
        fireAt: pastTime,
        data: { action: 'once' },
      });

      const dueSchedules = await scheduler.checkDueSchedules(now);
      await scheduler.markFired('one-time', dueSchedules[0]!.fireId, now);

      const schedules = await scheduler.getSchedules();
      expect(schedules).toHaveLength(0);
    });

    it('should advance recurring schedule after firing', async () => {
      const now = new Date();
      const pastTime = new Date(now.getTime() - 1000);

      await scheduler.schedule({
        id: 'recurring',
        fireAt: pastTime,
        recurrence: {
          frequency: 'daily',
          interval: 1,
          endDate: null,
          maxOccurrences: null,
        },
        data: { action: 'repeat' },
      });

      const dueSchedules = await scheduler.checkDueSchedules(now);
      await scheduler.markFired('recurring', dueSchedules[0]!.fireId, now);

      const schedules = await scheduler.getSchedules();
      expect(schedules).toHaveLength(1);
      // Next fire should be in the future
      expect(schedules[0]?.nextFireAt.getTime()).toBeGreaterThan(now.getTime());
    });
  });
});
