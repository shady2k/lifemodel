/**
 * Scheduler Primitive Tests
 *
 * Tests for the plugin scheduler with recurrence and idempotency.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createSchedulerPrimitive,
  SchedulerPrimitiveImpl,
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

  describe('cron recurrence', () => {
    it('calculates next occurrence from cron expression', async () => {
      const now = new Date('2024-01-15T10:30:00Z');
      await scheduler.schedule({
        id: 'cron-test',
        fireAt: now,
        recurrence: { frequency: 'custom', interval: 1, cron: '0 */2 * * *' },
        data: {},
      });

      // Fire and advance
      const due = await scheduler.checkDueSchedules(now);
      await scheduler.markFired('cron-test', due[0]!.fireId, now);

      const schedules = scheduler.getSchedules();
      expect(schedules[0]?.nextFireAt.getUTCHours()).toBe(12); // 10:30 → 12:00
      expect(schedules[0]?.nextFireAt.getUTCMinutes()).toBe(0);
    });

    it('throws on invalid cron at creation time', async () => {
      await expect(scheduler.schedule({
        id: 'bad-cron',
        fireAt: new Date(),
        recurrence: { frequency: 'custom', interval: 1, cron: 'invalid' },
        data: {},
      })).rejects.toThrow();
    });

    it('validates cron field count', () => {
      expect(() => SchedulerPrimitiveImpl.validateCron('* * *')).toThrow('expected 5-6 fields');
    });
  });

  describe('skipCurrentOccurrence', () => {
    it('should return null for non-existent schedule', async () => {
      const result = await scheduler.skipCurrentOccurrence('nonexistent');
      expect(result).toBeNull();
    });

    it('should return null for one-time schedule', async () => {
      const now = new Date();
      const futureTime = new Date(now.getTime() + 60000);

      await scheduler.schedule({
        id: 'one-time',
        fireAt: futureTime,
        data: { action: 'once' },
      });

      const result = await scheduler.skipCurrentOccurrence('one-time');
      expect(result).toBeNull();
    });

    it('should return null if nextFireAt is already past (no-op)', async () => {
      const now = new Date();
      const pastTime = new Date(now.getTime() - 1000);

      await scheduler.schedule({
        id: 'recurring-past',
        fireAt: pastTime,
        recurrence: {
          frequency: 'daily',
          interval: 1,
          endDate: null,
          maxOccurrences: null,
        },
        data: { action: 'repeat' },
      });

      const result = await scheduler.skipCurrentOccurrence('recurring-past');
      expect(result).toBeNull();
    });

    it('should advance recurring schedule if nextFireAt is in future', async () => {
      const now = new Date();
      const futureTime = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 1 day from now

      await scheduler.schedule({
        id: 'recurring-future',
        fireAt: futureTime,
        recurrence: {
          frequency: 'daily',
          interval: 1,
          endDate: null,
          maxOccurrences: null,
        },
        data: { action: 'repeat' },
      });

      const result = await scheduler.skipCurrentOccurrence('recurring-future');
      expect(result).toBeTruthy();
      expect(result!.getTime()).toBeGreaterThan(now.getTime());
      // Should be more than 1 day in the future (original was 1 day, advanced by 1 more)
      expect(result!.getTime()).toBeGreaterThan(futureTime.getTime());
    });
  });

  describe('calculateNextOccurrence - monthly range (dayOfMonthEnd)', () => {
    it('should advance 1 day within window', async () => {
      // Schedule on March 20 at 10:00 EST, window 20-25
      const fireAt = new Date('2024-03-20T15:00:00Z'); // 10:00 EST

      await scheduler.schedule({
        id: 'range-within',
        fireAt,
        recurrence: {
          frequency: 'monthly',
          interval: 1,
          dayOfMonth: 20,
          dayOfMonthEnd: 25,
          endDate: null,
          maxOccurrences: null,
        },
        timezone: 'America/New_York',
        localTime: '10:00',
        data: { action: 'range-test' },
      });

      // Fire and advance
      const due = await scheduler.checkDueSchedules(fireAt);
      expect(due).toHaveLength(1);
      await scheduler.markFired('range-within', due[0]!.fireId, fireAt);

      const schedules = scheduler.getSchedules();
      expect(schedules).toHaveLength(1);
      // Should advance to March 21 (within window, +1 day)
      const nextFire = schedules[0]!.nextFireAt;
      const nextDt = new Date(nextFire);
      expect(nextDt.getDate()).toBe(21);
      expect(nextDt.getMonth()).toBe(2); // March
    });

    it('should jump to next month when on last day of window', async () => {
      // Schedule on March 25 at 10:00 EST, window 20-25 (last day)
      const fireAt = new Date('2024-03-25T15:00:00Z'); // 10:00 EST

      await scheduler.schedule({
        id: 'range-end',
        fireAt,
        recurrence: {
          frequency: 'monthly',
          interval: 1,
          dayOfMonth: 20,
          dayOfMonthEnd: 25,
          endDate: null,
          maxOccurrences: null,
        },
        timezone: 'America/New_York',
        localTime: '10:00',
        data: { action: 'range-test' },
      });

      const due = await scheduler.checkDueSchedules(fireAt);
      await scheduler.markFired('range-end', due[0]!.fireId, fireAt);

      const schedules = scheduler.getSchedules();
      const nextFire = schedules[0]!.nextFireAt;
      const nextDt = new Date(nextFire);
      // On day 25 (== endDay), should jump to next month's day 20
      expect(nextDt.getMonth()).toBe(3); // April
      expect(nextDt.getDate()).toBe(20);
    });

    it('should handle short month clamping', async () => {
      // Schedule on Feb 28 (2024 leap year), window 28-31
      // endDay clamped to 29 in Feb, currentDay=28, 28 < 29 → advance 1 day
      const fireAt = new Date('2024-02-28T15:00:00Z');

      await scheduler.schedule({
        id: 'range-feb',
        fireAt,
        recurrence: {
          frequency: 'monthly',
          interval: 1,
          dayOfMonth: 28,
          dayOfMonthEnd: 31,
          endDate: null,
          maxOccurrences: null,
        },
        timezone: 'America/New_York',
        localTime: '10:00',
        data: { action: 'range-test' },
      });

      const due = await scheduler.checkDueSchedules(fireAt);
      await scheduler.markFired('range-feb', due[0]!.fireId, fireAt);

      const schedules = scheduler.getSchedules();
      const nextFire = schedules[0]!.nextFireAt;
      const nextDt = new Date(nextFire);
      // Feb 29 (leap year) — within clamped window (28..29), advance 1 day
      expect(nextDt.getDate()).toBe(29);
      expect(nextDt.getMonth()).toBe(1); // February
    });
  });

  describe('skipToNextWindow', () => {
    it('should return null for non-range schedule', async () => {
      const fireAt = new Date(Date.now() + 60000);
      await scheduler.schedule({
        id: 'non-range',
        fireAt,
        recurrence: {
          frequency: 'monthly',
          interval: 1,
          dayOfMonth: 15,
          endDate: null,
          maxOccurrences: null,
        },
        timezone: 'America/New_York',
        localTime: '10:00',
        data: {},
      });

      const result = await scheduler.skipToNextWindow('non-range');
      expect(result).toBeNull();
    });

    it('should jump to next month start day when within window', async () => {
      // Now is March 22, window 20-25, should jump to April 20
      const now = new Date('2024-03-22T15:00:00Z');
      vi.setSystemTime(now);

      const fireAt = new Date('2024-03-22T15:00:00Z'); // same day
      await scheduler.schedule({
        id: 'range-skip',
        fireAt,
        recurrence: {
          frequency: 'monthly',
          interval: 1,
          dayOfMonth: 20,
          dayOfMonthEnd: 25,
          endDate: null,
          maxOccurrences: null,
        },
        timezone: 'America/New_York',
        localTime: '10:00',
        data: {},
      });

      const result = await scheduler.skipToNextWindow('range-skip');
      expect(result).not.toBeNull();
      const nextDt = new Date(result!);
      expect(nextDt.getMonth()).toBe(3); // April
      expect(nextDt.getDate()).toBe(20);

      vi.useRealTimers();
    });

    it('should return null when already in future month', async () => {
      // Now is March 22, but nextFireAt is April 20 (already advanced)
      const now = new Date('2024-03-22T15:00:00Z');
      vi.setSystemTime(now);

      const fireAt = new Date('2024-04-20T14:00:00Z');
      await scheduler.schedule({
        id: 'range-future',
        fireAt,
        recurrence: {
          frequency: 'monthly',
          interval: 1,
          dayOfMonth: 20,
          dayOfMonthEnd: 25,
          endDate: null,
          maxOccurrences: null,
        },
        timezone: 'America/New_York',
        localTime: '10:00',
        data: {},
      });

      const result = await scheduler.skipToNextWindow('range-future');
      expect(result).toBeNull(); // Already in future month

      vi.useRealTimers();
    });
  });
});
