/**
 * Core Task Tool Tests
 *
 * Tests for consent gating: respond and approve actions require user_message trigger.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTaskTool } from '../../../../src/layers/cognition/tools/core/task.js';
import type { Tool } from '../../../../src/layers/cognition/tools/types.js';
import type { MotorCortex } from '../../../../src/runtime/motor-cortex/motor-cortex.js';

describe('core.task tool', () => {
  let tool: Tool;
  let mockMotorCortex: {
    listRuns: ReturnType<typeof vi.fn>;
    getRunStatus: ReturnType<typeof vi.fn>;
    cancelRun: ReturnType<typeof vi.fn>;
    respondToRun: ReturnType<typeof vi.fn>;
    respondToApproval: ReturnType<typeof vi.fn>;
    retryRun: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockMotorCortex = {
      listRuns: vi.fn().mockResolvedValue({ runs: [], total: 0 }),
      getRunStatus: vi.fn().mockResolvedValue({
        id: 'run-123',
        status: 'awaiting_input',
        task: 'Test task',
        tools: ['fetch', 'write'],
        attempts: [],
        currentAttemptIndex: 0,
        maxAttempts: 3,
        startedAt: new Date().toISOString(),
        energyConsumed: 0,
      }),
      cancelRun: vi.fn().mockResolvedValue({ ok: true }),
      respondToRun: vi.fn().mockResolvedValue({ ok: true }),
      respondToApproval: vi.fn().mockResolvedValue({ ok: true }),
      retryRun: vi.fn().mockResolvedValue({ ok: true }),
    };

    tool = createTaskTool(mockMotorCortex as unknown as MotorCortex);
  });

  describe('action=list - always allowed', () => {
    it('succeeds with motor_result trigger', async () => {
      const result = await tool.execute(
        { action: 'list' },
        { triggerType: 'motor_result', recipientId: 'test', correlationId: 'test' }
      );

      expect(result).toMatchObject({ success: true });
    });
  });

  describe('action=status - always allowed', () => {
    it('succeeds with motor_result trigger', async () => {
      const result = await tool.execute(
        { action: 'status', runId: 'run-123' },
        { triggerType: 'motor_result', recipientId: 'test', correlationId: 'test' }
      );

      expect(result).toMatchObject({ success: true });
    });
  });

  describe('action=respond - consent gate', () => {
    it('rejects when triggerType is motor_result', async () => {
      const result = await tool.execute(
        { action: 'respond', runId: 'run-123', answer: 'yes' },
        { triggerType: 'motor_result', recipientId: 'test', correlationId: 'test' }
      );

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('user input'),
      });
      expect(mockMotorCortex.respondToRun).not.toHaveBeenCalled();
    });

    it('rejects when triggerType is thought', async () => {
      const result = await tool.execute(
        { action: 'respond', runId: 'run-123', answer: 'yes' },
        { triggerType: 'thought', recipientId: 'test', correlationId: 'test' }
      );

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('user input'),
      });
    });

    it('succeeds when triggerType is user_message', async () => {
      const result = await tool.execute(
        { action: 'respond', runId: 'run-123', answer: 'yes' },
        { triggerType: 'user_message', recipientId: 'test', correlationId: 'test' }
      );

      expect(result).toMatchObject({ success: true });
      expect(mockMotorCortex.respondToRun).toHaveBeenCalledWith('run-123', 'yes', undefined);
    });

    it('passes domains when provided', async () => {
      await tool.execute(
        { action: 'respond', runId: 'run-123', answer: 'yes', domains: ['api.new.com'] },
        { triggerType: 'user_message', recipientId: 'test', correlationId: 'test' }
      );

      expect(mockMotorCortex.respondToRun).toHaveBeenCalledWith('run-123', 'yes', [
        'api.new.com',
      ]);
    });
  });

  describe('action=approve - consent gate', () => {
    it('rejects when triggerType is motor_result', async () => {
      const result = await tool.execute(
        { action: 'approve', runId: 'run-123', approved: true },
        { triggerType: 'motor_result', recipientId: 'test', correlationId: 'test' }
      );

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('user input'),
      });
      expect(mockMotorCortex.respondToApproval).not.toHaveBeenCalled();
    });

    it('succeeds when triggerType is user_message', async () => {
      const result = await tool.execute(
        { action: 'approve', runId: 'run-123', approved: true },
        { triggerType: 'user_message', recipientId: 'test', correlationId: 'test' }
      );

      expect(result).toMatchObject({ success: true });
      expect(mockMotorCortex.respondToApproval).toHaveBeenCalledWith('run-123', true);
    });
  });

  describe('action=cancel - always allowed', () => {
    it('succeeds with motor_result trigger', async () => {
      const result = await tool.execute(
        { action: 'cancel', runId: 'run-123' },
        { triggerType: 'motor_result', recipientId: 'test', correlationId: 'test' }
      );

      expect(result).toMatchObject({ success: true });
    });
  });

  describe('action=retry - always allowed', () => {
    it('succeeds with motor_result trigger', async () => {
      const result = await tool.execute(
        { action: 'retry', runId: 'run-123', guidance: 'Try again' },
        { triggerType: 'motor_result', recipientId: 'test', correlationId: 'test' }
      );

      expect(result).toMatchObject({ success: true });
    });
  });
});
