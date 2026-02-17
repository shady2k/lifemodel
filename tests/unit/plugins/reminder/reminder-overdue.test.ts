/**
 * Reminder Overdue Detection Tests
 *
 * Tests for overdue detection using FireContext in handleReminderDue.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleReminderDue } from '../../../../src/plugins/reminder/reminder-tool.js';
import type { FireContext } from '../../../../src/types/plugin.js';
import type { ReminderDueData } from '../../../../src/plugins/reminder/reminder-types.js';
import { REMINDER_STORAGE_KEYS } from '../../../../src/plugins/reminder/reminder-types.js';

describe('handleReminderDue - overdue detection', () => {
  // Mock storage
  let storageData: Record<string, unknown>;
  const mockStorage = {
    get: vi.fn(async (key: string) => storageData[key] ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      storageData[key] = value;
    }),
  };

  // Mock logger
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

  // Mock intent emitter
  const mockIntentEmitter = {
    emitPendingIntention: vi.fn(),
  };

  // Mock timezone resolver
  const getTimezone = vi.fn((recipientId: string) => 'America/New_York');

  beforeEach(() => {
    vi.clearAllMocks();
    storageData = {};
  });

  describe('recurring reminders with FireContext', () => {
    it('includes overdue note when scheduledFor is 10min ago', async () => {
      // Schedule was due 10 minutes ago
      const scheduledFor = new Date(Date.now() - 10 * 60 * 1000);
      const firedAt = new Date();

      const fireContext: FireContext = {
        scheduledFor,
        firedAt,
        fireId: 'fire-123',
        scheduleId: 'sched-456',
      };

      // Set up storage with existing recurring reminder
      storageData[REMINDER_STORAGE_KEYS.REMINDERS] = [
        {
          id: 'rem-1',
          content: 'Take medication',
          recipientId: 'user-1',
          isRecurring: true,
          fireCount: 2, // Already fired twice
          status: 'active',
        },
      ];

      const data: ReminderDueData = {

        reminderId: 'rem-1',
        recipientId: 'user-1',
        content: 'Take medication',
        isRecurring: true,
        fireCount: 2,
      };

      await handleReminderDue(
        data,
        mockStorage as unknown as import('../../../../src/types/plugin.js').StoragePrimitive,
        mockLogger,
        mockIntentEmitter as unknown as import('../../../../src/types/plugin.js').IntentEmitterPrimitive,
        fireContext,
        getTimezone
      );

      expect(mockIntentEmitter.emitPendingIntention).toHaveBeenCalled();
      const intention = mockIntentEmitter.emitPendingIntention.mock.calls[0][0];
      // Should include overdue note with timezone
      expect(intention).toContain('Recurring reminder (fired 3 times)');
      expect(intention).toContain('Take medication');
      expect(intention).toMatch(/due at \d{2}:\d{2}, delayed ~10 minutes/);
    });

    it('does NOT include overdue note when scheduledFor is 2min ago', async () => {
      // Schedule was due 2 minutes ago (under threshold)
      const scheduledFor = new Date(Date.now() - 2 * 60 * 1000);
      const firedAt = new Date();

      const fireContext: FireContext = {
        scheduledFor,
        firedAt,
        fireId: 'fire-123',
        scheduleId: 'sched-456',
      };

      storageData[REMINDER_STORAGE_KEYS.REMINDERS] = [
        {
          id: 'rem-1',
          content: 'Take medication',
          recipientId: 'user-1',
          isRecurring: true,
          fireCount: 2,
          status: 'active',
        },
      ];

      const data: ReminderDueData = {

        reminderId: 'rem-1',
        recipientId: 'user-1',
        content: 'Take medication',
        isRecurring: true,
        fireCount: 2,
      };

      await handleReminderDue(
        data,
        mockStorage as unknown as import('../../../../src/types/plugin.js').StoragePrimitive,
        mockLogger,
        mockIntentEmitter as unknown as import('../../../../src/types/plugin.js').IntentEmitterPrimitive,
        fireContext,
        getTimezone
      );

      expect(mockIntentEmitter.emitPendingIntention).toHaveBeenCalled();
      const intention = mockIntentEmitter.emitPendingIntention.mock.calls[0][0];
      // Should NOT include overdue note
      expect(intention).not.toContain('delayed');
      expect(intention).toBe('Recurring reminder (fired 3 times): "Take medication".');
    });
  });

  describe('one-time reminders with FireContext', () => {
    it('includes overdue note with timezone when scheduledFor is 17min ago', async () => {
      const scheduledFor = new Date('2024-01-15T09:00:00Z');
      const firedAt = new Date('2024-01-15T09:17:00Z');

      const fireContext: FireContext = {
        scheduledFor,
        firedAt,
        fireId: 'fire-123',
        scheduleId: 'sched-456',
      };

      const data: ReminderDueData = {

        reminderId: 'rem-1',
        recipientId: 'user-1',
        content: 'Call mom',
        isRecurring: false,
      };

      await handleReminderDue(
        data,
        mockStorage as unknown as import('../../../../src/types/plugin.js').StoragePrimitive,
        mockLogger,
        mockIntentEmitter as unknown as import('../../../../src/types/plugin.js').IntentEmitterPrimitive,
        fireContext,
        getTimezone
      );

      expect(mockIntentEmitter.emitPendingIntention).toHaveBeenCalled();
      const intention = mockIntentEmitter.emitPendingIntention.mock.calls[0][0];
      // Should include overdue note with timezone (9:00 AM in America/New_York = 4:00 AM UTC, but scheduledFor is 9:00 UTC)
      // Note: The exact time depends on the timezone, but the format should be correct
      expect(intention).toMatch(/due at \d{2}:\d{2}, delayed ~17 minutes/);
    });
  });

  describe('backward compatibility without FireContext', () => {
    it('falls back to data.scheduledAt when fireContext is undefined', async () => {
      // Old-style data with scheduledAt
      const scheduledAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      storageData[REMINDER_STORAGE_KEYS.REMINDERS] = [
        {
          id: 'rem-1',
          content: 'Call mom',
          recipientId: 'user-1',
          isRecurring: false,
          fireCount: 0,
          status: 'active',
        },
      ];

      const data: ReminderDueData = {

        reminderId: 'rem-1',
        recipientId: 'user-1',
        content: 'Call mom',
        isRecurring: false,
        scheduledAt,
      };

      await handleReminderDue(
        data,
        mockStorage as unknown as import('../../../../src/types/plugin.js').StoragePrimitive,
        mockLogger,
        mockIntentEmitter as unknown as import('../../../../src/types/plugin.js').IntentEmitterPrimitive,
        undefined, // No fireContext
        getTimezone
      );

      expect(mockIntentEmitter.emitPendingIntention).toHaveBeenCalled();
      const intention = mockIntentEmitter.emitPendingIntention.mock.calls[0][0];
      expect(intention).toMatch(/delayed ~10 minutes/);
    });

    it('falls back to UTC when getTimezone is undefined', async () => {
      const scheduledFor = new Date(Date.now() - 10 * 60 * 1000);
      const firedAt = new Date();

      const fireContext: FireContext = {
        scheduledFor,
        firedAt,
        fireId: 'fire-123',
        scheduleId: 'sched-456',
      };

      storageData[REMINDER_STORAGE_KEYS.REMINDERS] = [
        {
          id: 'rem-1',
          content: 'Take medication',
          recipientId: 'user-1',
          isRecurring: true,
          fireCount: 2,
          status: 'active',
        },
      ];

      const data: ReminderDueData = {

        reminderId: 'rem-1',
        recipientId: 'user-1',
        content: 'Take medication',
        isRecurring: true,
        fireCount: 2,
      };

      await handleReminderDue(
        data,
        mockStorage as unknown as import('../../../../src/types/plugin.js').StoragePrimitive,
        mockLogger,
        mockIntentEmitter as unknown as import('../../../../src/types/plugin.js').IntentEmitterPrimitive,
        fireContext,
        undefined // No getTimezone - should use UTC
      );

      expect(mockIntentEmitter.emitPendingIntention).toHaveBeenCalled();
      const intention = mockIntentEmitter.emitPendingIntention.mock.calls[0][0];
      // Should still include overdue note (using UTC)
      expect(intention).toMatch(/delayed ~10 minutes/);
    });

    it('does not include overdue note when neither fireContext nor scheduledAt provided', async () => {
      const data: ReminderDueData = {
        reminderId: 'rem-1',
        recipientId: 'user-1',
        content: 'Call mom',
        isRecurring: false,
      };

      await handleReminderDue(
        data,
        mockStorage as unknown as import('../../../../src/types/plugin.js').StoragePrimitive,
        mockLogger,
        mockIntentEmitter as unknown as import('../../../../src/types/plugin.js').IntentEmitterPrimitive,
        undefined, // No fireContext
        undefined  // No getTimezone
      );

      // No overdue detection possible → no intention emitted for on-time one-time reminders
      expect(mockIntentEmitter.emitPendingIntention).not.toHaveBeenCalled();
    });
  });

  describe('occurrence creation', () => {
    it('passes accurate scheduledFor to createOccurrenceOnFire', async () => {
      const scheduledFor = new Date('2024-01-15T09:00:00Z');
      const firedAt = new Date('2024-01-15T09:10:00Z');

      const fireContext: FireContext = {
        scheduledFor,
        firedAt,
        fireId: 'fire-123',
        scheduleId: 'sched-456',
      };

      storageData[REMINDER_STORAGE_KEYS.REMINDERS] = [
        {
          id: 'rem-1',
          content: 'Take medication',
          recipientId: 'user-1',
          isRecurring: true,
          fireCount: 0,
          status: 'active',
        },
      ];

      const data: ReminderDueData = {

        reminderId: 'rem-1',
        recipientId: 'user-1',
        content: 'Take medication',
        isRecurring: true,
        fireCount: 0,
      };

      await handleReminderDue(
        data,
        mockStorage as unknown as import('../../../../src/types/plugin.js').StoragePrimitive,
        mockLogger,
        mockIntentEmitter as unknown as import('../../../../src/types/plugin.js').IntentEmitterPrimitive,
        fireContext,
        getTimezone
      );

      // Check that occurrence was created with the correct scheduledAt
      const occurrences = storageData[REMINDER_STORAGE_KEYS.REMINDER_OCCURRENCES] as
        | Array<{ reminderId: string; scheduledAt: Date; firedAt: Date }>
        | undefined;
      expect(occurrences).toBeDefined();
      expect(occurrences).toHaveLength(1);
      expect(occurrences![0]!.reminderId).toBe('rem-1');
      expect(occurrences![0]!.scheduledAt).toEqual(scheduledFor);
    });
  });
});
