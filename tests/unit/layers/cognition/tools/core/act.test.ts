/**
 * Tests for core.act tool
 *
 * Validates: All tools always granted, trust gating, domain resolution,
 * skill loading errors
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createActTool } from '../../../../../../src/layers/cognition/tools/core/act.js';
import type { MotorCortex } from '../../../../../../src/runtime/motor-cortex/motor-cortex.js';

// Mock skill-loader module with path that matches production code's import resolution
// The production code at src/layers/cognition/tools/core/act.ts imports
// from '../../../../runtime/skills/skill-loader.js' which resolves to src/runtime/skills/skill-loader.js
vi.mock('../../../../../../src/runtime/skills/skill-loader.js', () => ({
  loadSkill: vi.fn(),
  validateSkillInputs: vi.fn(() => []),
}));

// Import the mocked functions
import { loadSkill } from '../../../../../../src/runtime/skills/skill-loader.js';

const ALL_MOTOR_TOOLS = ['read', 'write', 'list', 'glob', 'bash', 'grep', 'patch', 'fetch'];

describe('core.act tool', () => {
  const mockMotorCortex = {
    executeOneshot: vi.fn(),
    startRun: vi.fn(),
  } as unknown as MotorCortex;

  const tool = createActTool(mockMotorCortex);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('oneshot mode', () => {
    it('executes JS code synchronously', async () => {
      (mockMotorCortex.executeOneshot as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        result: '42',
        durationMs: 10,
      });

      const result = (await tool.execute({
        mode: 'oneshot',
        task: '2 + 2',
      })) as Record<string, unknown>;

      expect(result['success']).toBe(true);
      const data = result['data'] as Record<string, unknown>;
      expect(data['mode']).toBe('oneshot');
      expect(data['result']).toBe('42');
    });

    it('handles execution errors', async () => {
      (mockMotorCortex.executeOneshot as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Syntax error')
      );

      const result = (await tool.execute({
        mode: 'oneshot',
        task: 'invalid syntax',
      })) as Record<string, unknown>;

      expect(result['success']).toBe(false);
      expect(result['error']).toContain('Syntax error');
    });
  });

  describe('agentic mode - skill loading', () => {
    it('blocks needs_reapproval skill', async () => {
      (loadSkill as ReturnType<typeof vi.fn>).mockResolvedValue({
        frontmatter: { name: 'test', description: 'Test' },
        policy: { trust: 'needs_reapproval', schemaVersion: 1, allowedDomains: ['api.example.com'] },
        body: 'instructions',
        path: '/path',
        skillPath: '/path/SKILL.md',
      });

      const result = (await tool.execute({
        mode: 'agentic',
        task: 'test task',
        skill: 'test-skill',
      })) as Record<string, unknown>;

      expect(result['success']).toBe(false);
      expect(result['error']).toContain('needs re-approval (content changed)');
      expect(result['error']).toContain('core.skill(action:"approve"');
      expect(result['error']).toContain('Do not retry core.act');
    });

    it('blocks pending_review skill', async () => {
      (loadSkill as ReturnType<typeof vi.fn>).mockResolvedValue({
        frontmatter: { name: 'test', description: 'Test' },
        policy: { trust: 'pending_review', schemaVersion: 1, allowedDomains: ['api.example.com'] },
        body: 'instructions',
        path: '/path',
        skillPath: '/path/SKILL.md',
      });

      const result = (await tool.execute({
        mode: 'agentic',
        task: 'test task',
        skill: 'pending-skill',
      })) as Record<string, unknown>;

      expect(result['success']).toBe(false);
      expect(result['error']).toContain('pending approval (new skill)');
      expect(result['error']).toContain('core.skill(action:"approve"');
      expect(result['error']).toContain('Do not retry core.act');
    });

    it('succeeds for approved skill with all tools granted', async () => {
      (loadSkill as ReturnType<typeof vi.fn>).mockResolvedValue({
        frontmatter: { name: 'test', description: 'Test' },
        policy: {
          trust: 'approved',
          schemaVersion: 1,
          allowedDomains: ['api.example.com'],
        },
        body: 'instructions',
        path: '/path',
        skillPath: '/path/SKILL.md',
      });

      (mockMotorCortex.startRun as ReturnType<typeof vi.fn>).mockResolvedValue({
        runId: 'run-ok',
      });

      const result = (await tool.execute({
        mode: 'agentic',
        task: 'test task',
        skill: 'approved-skill',
      })) as Record<string, unknown>;

      expect(result['success']).toBe(true);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- mock method in test
      expect(mockMotorCortex.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: ALL_MOTOR_TOOLS, // All tools always granted
        })
      );
    });

    it('grants all tools to approved skill runs', async () => {
      (loadSkill as ReturnType<typeof vi.fn>).mockResolvedValue({
        frontmatter: { name: 'test', description: 'Test' },
        policy: {
          trust: 'approved',
          schemaVersion: 1,
          allowedDomains: ['api.example.com'],
        },
        body: 'instructions',
        path: '/path',
        skillPath: '/path/SKILL.md',
      });

      (mockMotorCortex.startRun as ReturnType<typeof vi.fn>).mockResolvedValue({
        runId: 'run-123',
      });

      const executeResult = (await tool.execute({
        mode: 'agentic',
        task: 'test task',
        skill: 'test-skill',
      })) as Record<string, unknown>;

      expect(executeResult['success']).toBe(true);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- mock method in test
      expect(mockMotorCortex.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: ALL_MOTOR_TOOLS, // All tools always granted
          domains: ['api.example.com'],
        })
      );
    });

    it('merges explicit domains with policy domains', async () => {
      (loadSkill as ReturnType<typeof vi.fn>).mockResolvedValue({
        frontmatter: { name: 'test', description: 'Test' },
        policy: {
          trust: 'approved',
          schemaVersion: 1,
          allowedDomains: ['api.example.com'],
        },
        body: 'instructions',
        path: '/path',
        skillPath: '/path/SKILL.md',
      });

      (mockMotorCortex.startRun as ReturnType<typeof vi.fn>).mockResolvedValue({
        runId: 'run-123',
      });

      await tool.execute({
        mode: 'agentic',
        task: 'test task',
        skill: 'test-skill',
        domains: ['another.com'],
      });

      // eslint-disable-next-line @typescript-eslint/unbound-method -- mock method in test
      expect(mockMotorCortex.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          domains: expect.arrayContaining(['api.example.com', 'another.com']) as string[],
        })
      );
    });

    it('blocks skill with no policy', async () => {
      (loadSkill as ReturnType<typeof vi.fn>).mockResolvedValue({
        frontmatter: { name: 'test', description: 'Test' },
        policy: undefined,
        body: 'instructions',
        path: '/path',
        skillPath: '/path/SKILL.md',
      });

      const result = (await tool.execute({
        mode: 'agentic',
        task: 'test task',
        skill: 'no-policy-skill',
      })) as Record<string, unknown>;

      expect(result['success']).toBe(false);
      expect(result['error']).toContain('has no policy');
    });
  });

  describe('agentic mode - without skills', () => {
    it('grants all tools when no skill specified', async () => {
      (mockMotorCortex.startRun as ReturnType<typeof vi.fn>).mockResolvedValue({
        runId: 'run-123',
      });

      const result = (await tool.execute({
        mode: 'agentic',
        task: 'test task',
      })) as Record<string, unknown>;

      expect(result['success']).toBe(true);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- mock method in test
      expect(mockMotorCortex.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: ALL_MOTOR_TOOLS,
        })
      );
    });
  });

  describe('error handling', () => {
    it('returns error for missing required parameters', async () => {
      const result = (await tool.execute({
        mode: 'agentic',
        // Missing task
      })) as Record<string, unknown>;

      expect(result['success']).toBe(false);
      expect(result['error']).toContain('Missing required parameters');
    });

    it('returns error for unknown mode', async () => {
      const result = (await tool.execute({
        mode: 'unknown',
        task: 'test',
      })) as Record<string, unknown>;

      expect(result['success']).toBe(false);
      expect(result['error']).toContain('Unknown mode');
    });

    it('returns error when skill fails to load', async () => {
      // Use the mock directly instead of vi.mocked
      (loadSkill as ReturnType<typeof vi.fn>).mockResolvedValue({
        error: 'Skill not found',
      });

      const result = (await tool.execute({
        mode: 'agentic',
        task: 'test task',
        skill: 'nonexistent',
      })) as Record<string, unknown>;

      expect(result['success']).toBe(false);
      expect(result['error']).toContain('Skill not found');
    });
  });

  describe('tool metadata', () => {
    it('has correct name and tags', () => {
      expect(tool.name).toBe('core.act');
      expect(tool.tags).toContain('motor');
      expect(tool.tags).toContain('execution');
      expect(tool.tags).toContain('async');
    });

    it('hasSideEffects flag', () => {
      expect(tool.hasSideEffects).toBe(true);
    });

    it('does not have tools parameter', () => {
      const paramNames = tool.parameters?.map((p) => p.name) ?? [];
      expect(paramNames).not.toContain('tools');
    });
  });
});
