/**
 * Reminder Complete Action Tests
 *
 * Tests for the 'complete' action on one-time and recurring reminders.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createReminderTools } from '../../../../src/plugins/reminder/reminder-tool.js';
import type { PluginPrimitives, PluginTool } from '../../../../src/types/plugin.js';
import type { Reminder, ReminderOccurrence } from '../../../../src/plugins/reminder/reminder-types.js';
import { REMINDER_STORAGE_KEYS } from '../../../../src/plugins/reminder/reminder-types.js';

describe('reminder tool - complete action', () => {
  let tools: PluginTool[];
  let reminderTool: PluginTool;
  const recipientId = 'test-recipient';
  const ctx = { recipientId, correlationId: 'test-correlation' };
  const ctxA = { recipientId: 'recipient-a', correlationId: 'test-correlation' };
  const ctxB = { recipientId: 'recipient-b', correlationId: 'test-correlation' };
  const mockLogger = {
    child: vi.fn(function () {
      return mockLogger;
    }),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    level: 'debug',
  } as unknown as import('../../../../src/types/logger.js').Logger;

  // In-memory storage
  let storageData: Record<string, unknown>;
  let schedules: Map<string, { id: string; nextFireAt: Date; recurrence: unknown | null }>;

  const getTimezone = vi.fn(() => 'America/New_York');
  const isTimezoneConfigured = vi.fn(() => true);
  const getUserPatterns = vi.fn(() => ({ wakeHour: 8 }));

  beforeEach(async () => {
    vi.clearAllMocks();
    storageData = {};
    schedules = new Map();

    const mockScheduler = {
      schedule: vi.fn(async (options) => {
        const id = `sched_${Date.now().toString(36)}`;
        schedules.set(id, {
          id,
          nextFireAt: options.fireAt,
          recurrence: options.recurrence ?? null,
        });
        return id;
      }),
      cancel: vi.fn(async (id: string) => {
        return schedules.delete(id);
      }),
      getSchedules: vi.fn(() =>
        Array.from(schedules.values()).map((s) => ({
          ...s,
          pluginId: 'reminder',
          timezone: null,
          localTime: null,
          data: {},
          createdAt: new Date(),
          fireCount: 0,
        }))
      ),
      updateScheduleData: vi.fn(async () => true),
      skipCurrentOccurrence: vi.fn(async (scheduleId: string) => {
        const schedule = schedules.get(scheduleId);
        if (!schedule || !schedule.recurrence) return null;
        // If already past, return null (no-op)
        if (schedule.nextFireAt <= new Date()) return null;
        // Otherwise advance by 1 day
        schedule.nextFireAt = new Date(schedule.nextFireAt.getTime() + 24 * 60 * 60 * 1000);
        return schedule.nextFireAt;
      }),
    };

    const mockIntentEmitter = {
      emitPendingIntention: vi.fn(),
    };

    const mockMemorySearch = {
      search: vi.fn(async () => ({ results: [] })),
    };

    const primitives = {
      storage: {
        get: vi.fn(async (key: string) => storageData[key] ?? null),
        set: vi.fn(async (key: string, value: unknown) => {
          storageData[key] = value;
        }),
        delete: vi.fn(async (key: string) => {
          const existed = key in storageData;
          delete storageData[key];
          return existed;
        }),
        keys: vi.fn(async () => Object.keys(storageData)),
        query: vi.fn(async () => []),
        clear: vi.fn(async () => { storageData = {}; }),
      },
      scheduler: mockScheduler,
      intentEmitter: mockIntentEmitter,
      memorySearch: mockMemorySearch,
      services: {
        getTimezone: () => 'America/New_York',
        isTimezoneConfigured: () => true,
        getUserPatterns: () => ({ wakeHour: 8, sleepHour: 23 }),
        getUserProperty: () => null,
        setUserProperty: vi.fn(async () => {}),
        registerEventSchema: vi.fn(),
      },
      logger: mockLogger,
    } as unknown as PluginPrimitives;

    tools = createReminderTools(
      primitives,
      getTimezone,
      isTimezoneConfigured,
      getUserPatterns
    );
    reminderTool = tools[0]!;
  });

  describe('one-time reminder', () => {
    it('should complete a one-time reminder and set status to completed', async () => {
      // Create a one-time reminder
      const createResult = await reminderTool.execute(
        {
          action: 'create',
          content: 'Pay rent',
          anchor: {
            type: 'absolute',
            absolute: { special: 'tomorrow', hour: 10 },
            confidence: 0.9,
            originalPhrase: 'tomorrow at 10am',
          },
        },
        ctx
      );

      expect(createResult.success).toBe(true);
      const reminderId = createResult.reminderId!;

      // Complete the reminder
      const completeResult = await reminderTool.execute(
        { action: 'complete', reminderId },
        ctx
      );

      expect(completeResult.success).toBe(true);
      expect(completeResult.action).toBe('complete');
      expect(completeResult.reminderId).toBe(reminderId);
      expect(completeResult.completedCount).toBe(1);

      // Verify reminder status is completed
      const reminders = storageData[REMINDER_STORAGE_KEYS.REMINDERS] as Reminder[];
      const reminder = reminders.find((r) => r.id === reminderId);
      expect(reminder?.status).toBe('completed');
      expect(reminder?.lastCompletedAt).toBeTruthy();
    });

    it('should create an occurrence when completing one-time reminder', async () => {
      // Create a one-time reminder
      const createResult = await reminderTool.execute(
        {
          action: 'create',
          content: 'Buy groceries',
          anchor: {
            type: 'relative',
            relative: { unit: 'hour', amount: 2 },
            confidence: 0.9,
            originalPhrase: 'in 2 hours',
          },
        },
        ctx
      );

      const reminderId = createResult.reminderId!;

      // Complete the reminder
      await reminderTool.execute({ action: 'complete', reminderId }, ctx);

      // Verify occurrence was created
      const occurrences = storageData[REMINDER_STORAGE_KEYS.REMINDER_OCCURRENCES] as
        | ReminderOccurrence[]
        | undefined;
      expect(occurrences).toBeDefined();
      expect(occurrences).toHaveLength(1);
      expect(occurrences![0]!.reminderId).toBe(reminderId);
      expect(occurrences![0]!.status).toBe('completed');
    });

    it('should fail to complete an already completed one-time reminder', async () => {
      // Create and complete a reminder
      const createResult = await reminderTool.execute(
        {
          action: 'create',
          content: 'Task',
          anchor: {
            type: 'relative',
            relative: { unit: 'day', amount: 1 },
            confidence: 0.9,
            originalPhrase: 'tomorrow',
          },
        },
        ctx
      );

      const reminderId = createResult.reminderId!;

      await reminderTool.execute({ action: 'complete', reminderId }, ctx);

      // Try to complete again
      const secondComplete = await reminderTool.execute(
        { action: 'complete', reminderId },
        ctx
      );

      expect(secondComplete.success).toBe(false);
      expect(secondComplete.error).toBe('Reminder already completed');
    });

    it('should fail to complete a cancelled reminder', async () => {
      // Create a reminder
      const createResult = await reminderTool.execute(
        {
          action: 'create',
          content: 'Cancelled task',
          anchor: {
            type: 'relative',
            relative: { unit: 'day', amount: 1 },
            confidence: 0.9,
            originalPhrase: 'tomorrow',
          },
        },
        ctx
      );

      const reminderId = createResult.reminderId!;

      // Cancel the reminder
      await reminderTool.execute({ action: 'cancel', reminderId }, ctx);

      // Try to complete
      const completeResult = await reminderTool.execute(
        { action: 'complete', reminderId },
        ctx
      );

      expect(completeResult.success).toBe(false);
      expect(completeResult.error).toBe('Reminder is cancelled');
    });
  });

  describe('recurring reminder', () => {
    it('should complete a recurring reminder and update parent cache', async () => {
      // Create a recurring reminder
      const createResult = await reminderTool.execute(
        {
          action: 'create',
          content: 'Daily standup',
          anchor: {
            type: 'recurring',
            recurring: { frequency: 'daily', interval: 1, hour: 9, minute: 0 },
            confidence: 0.9,
            originalPhrase: 'every day at 9am',
          },
        },
        ctx
      );

      expect(createResult.success).toBe(true);
      const reminderId = createResult.reminderId!;

      // Complete the reminder
      const completeResult = await reminderTool.execute(
        { action: 'complete', reminderId },
        ctx
      );

      expect(completeResult.success).toBe(true);
      expect(completeResult.completedCount).toBe(1);

      // Verify reminder status is still active (recurring)
      const reminders = storageData[REMINDER_STORAGE_KEYS.REMINDERS] as Reminder[];
      const reminder = reminders.find((r) => r.id === reminderId);
      expect(reminder?.status).toBe('active');
      expect(reminder?.lastCompletedAt).toBeTruthy();
      expect(reminder?.completedCount).toBe(1);
    });

    it('should complete recurring reminder before fire and advance schedule', async () => {
      // Create a recurring reminder for tomorrow (future)
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const createResult = await reminderTool.execute(
        {
          action: 'create',
          content: 'Weekly review',
          anchor: {
            type: 'recurring',
            recurring: { frequency: 'weekly', interval: 1, hour: 10, minute: 0 },
            confidence: 0.9,
            originalPhrase: 'every week',
          },
        },
        ctx
      );

      const reminderId = createResult.reminderId!;

      // Complete before it fires
      const completeResult = await reminderTool.execute(
        { action: 'complete', reminderId },
        ctx
      );

      expect(completeResult.success).toBe(true);
      // Should return nextFireAt since we completed before fire
      expect(completeResult.nextFireAt).toBeDefined();
    });

    it('should preserve occurrence history after multiple complete cycles', async () => {
      // Create a recurring reminder
      const createResult = await reminderTool.execute(
        {
          action: 'create',
          content: 'Pay utilities',
          anchor: {
            type: 'recurring',
            recurring: { frequency: 'monthly', interval: 1, dayOfMonth: 15 },
            confidence: 0.9,
            originalPhrase: 'every month on the 15th',
          },
        },
        ctx
      );

      const reminderId = createResult.reminderId!;

      // Complete multiple times
      await reminderTool.execute({ action: 'complete', reminderId }, ctx);

      // Manually increment to simulate multiple cycles
      const reminders = storageData[REMINDER_STORAGE_KEYS.REMINDERS] as Reminder[];
      const reminder = reminders.find((r) => r.id === reminderId)!;
      reminder.completedCount = 2;
      reminder.lastCompletedAt = new Date();

      await reminderTool.execute({ action: 'complete', reminderId }, ctx);

      // Verify occurrences exist
      const occurrences = storageData[REMINDER_STORAGE_KEYS.REMINDER_OCCURRENCES] as
        | ReminderOccurrence[]
        | undefined;
      expect(occurrences).toBeDefined();
      expect(occurrences!.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('error cases', () => {
    it('should return error for non-existent reminder', async () => {
      const result = await reminderTool.execute(
        { action: 'complete', reminderId: 'nonexistent' },
        ctx
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Reminder not found');
    });

    it('should return error for wrong recipient', async () => {
      // Create a reminder for recipient A
      const createResult = await reminderTool.execute(
        {
          action: 'create',
          content: 'Private task',
          anchor: {
            type: 'relative',
            relative: { unit: 'day', amount: 1 },
            confidence: 0.9,
            originalPhrase: 'tomorrow',
          },
        },
        ctxA
      );

      const reminderId = createResult.reminderId!;

      // Try to complete as recipient B
      const result = await reminderTool.execute(
        { action: 'complete', reminderId },
        ctxB
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Reminder not found');
    });

    it('should return error when reminderId is missing', async () => {
      const result = await reminderTool.execute(
        { action: 'complete' },
        ctx
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing required parameter: reminderId');
    });
  });

  describe('validation', () => {
    it('should accept complete action in validate', () => {
      const result = reminderTool.validate!({ action: 'complete', reminderId: 'rem_123' });
      expect(result.success).toBe(true);
    });

    it('should reject invalid action in validate', () => {
      const result = reminderTool.validate!({ action: 'invalid' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('create, list, cancel, complete');
    });
  });
});
