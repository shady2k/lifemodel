/**
 * Tests for core.act tool
 *
 * Validates: Policy-based defaults, explicit overrides, no-policy warning,
 * trust gating, content hash mismatch
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
  updateSkillIndex: vi.fn(),
}));

// Import the mocked functions
import { loadSkill, updateSkillIndex } from '../../../../../../src/runtime/skills/skill-loader.js';

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
    it('returns trust-specific error for needs_reapproval skill without explicit tools', async () => {
      (loadSkill as ReturnType<typeof vi.fn>).mockResolvedValue({
        frontmatter: { name: 'test', description: 'Test' },
        policy: { trust: 'needs_reapproval', schemaVersion: 1, allowedTools: ['code'] },
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
      expect(result['error']).toContain('core.skill');
      expect(result['error']).toContain('Do not retry');
    });

    it('returns trust-specific error for pending_review skill without explicit tools', async () => {
      (loadSkill as ReturnType<typeof vi.fn>).mockResolvedValue({
        frontmatter: { name: 'test', description: 'Test' },
        policy: { trust: 'pending_review', schemaVersion: 1, allowedTools: ['bash'] },
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
      expect(result['error']).toContain('core.skill');
      expect(result['error']).toContain('Do not retry');
    });

    it('succeeds for approved skill without explicit tools', async () => {
      (loadSkill as ReturnType<typeof vi.fn>).mockResolvedValue({
        frontmatter: { name: 'test', description: 'Test' },
        policy: {
          trust: 'approved',
          schemaVersion: 1,
          allowedTools: ['bash'],
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
    });

    it('uses policy defaults when trust is approved', async () => {
      (loadSkill as ReturnType<typeof vi.fn>).mockResolvedValue({
        frontmatter: { name: 'test', description: 'Test' },
        policy: {
          trust: 'approved',
          schemaVersion: 1,
          allowedTools: ['bash'],
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
        // No tools provided - should use policy defaults
      })) as Record<string, unknown>;

      expect(executeResult['success']).toBe(true);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- mock method in test
      expect(mockMotorCortex.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: ['bash', 'fetch'], // From policy + auto-included fetch (domains present)
          domains: ['api.example.com'], // From policy
        })
      );
    });

    it('merges explicit domains with policy domains', async () => {
      (loadSkill as ReturnType<typeof vi.fn>).mockResolvedValue({
        frontmatter: { name: 'test', description: 'Test' },
        policy: {
          trust: 'approved',
          schemaVersion: 1,
          allowedTools: ['bash'],
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

    it('allows explicit tools override', async () => {
      (loadSkill as ReturnType<typeof vi.fn>).mockResolvedValue({
        frontmatter: { name: 'test', description: 'Test' },
        policy: {
          trust: 'approved',
          schemaVersion: 1,
          allowedTools: ['bash'],
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
        tools: ['grep'], // Explicit override
      });

      // eslint-disable-next-line @typescript-eslint/unbound-method -- mock method in test
      expect(mockMotorCortex.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: ['grep'], // Override used
        })
      );
    });

    it('updates skill index with lastUsed timestamp', async () => {
      (loadSkill as ReturnType<typeof vi.fn>).mockResolvedValue({
        frontmatter: { name: 'test', description: 'Test skill' },
        policy: {
          trust: 'approved',
          schemaVersion: 1,
          allowedTools: ['bash'],
        },
        body: 'instructions',
        path: '/path',
        skillPath: '/path/SKILL.md',
      });

      (mockMotorCortex.startRun as ReturnType<typeof vi.fn>).mockResolvedValue({
        runId: 'run-123',
      });
      vi.mocked(updateSkillIndex).mockResolvedValue(undefined);

      await tool.execute({
        mode: 'agentic',
        task: 'test task',
        skill: 'test-skill',
      });

      expect(updateSkillIndex).toHaveBeenCalledWith(
        'data/skills',
        'test-skill',
        expect.objectContaining({
          description: 'Test skill',
          trust: 'approved',
          hasPolicy: true,
          lastUsed: expect.any(String) as string,
        })
      );
    });
  });

  describe('agentic mode - without skills', () => {
    it('uses default tools when no skill specified', async () => {
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
          tools: ['bash'], // Default
        })
      );
    });

    it('uses explicit tools when provided', async () => {
      (mockMotorCortex.startRun as ReturnType<typeof vi.fn>).mockResolvedValue({
        runId: 'run-123',
      });

      await tool.execute({
        mode: 'agentic',
        task: 'test task',
        tools: ['bash', 'grep'],
      });

      // eslint-disable-next-line @typescript-eslint/unbound-method -- mock method in test
      expect(mockMotorCortex.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: ['bash', 'grep'],
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
  });
});
