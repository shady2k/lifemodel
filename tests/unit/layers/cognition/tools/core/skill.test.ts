/**
 * Tests for core.skill tool
 *
 * Validates: read, approve, reject, review, update flows, consent gate, error cases, tool metadata.
 * Uses temp directories with mock SKILL.md + policy.json.
 *
 * All policies use v2 schema (schemaVersion: 2, status, domains).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillTool } from '../../../../../../src/layers/cognition/tools/core/skill.js';
import type { SkillResult } from '../../../../../../src/layers/cognition/tools/core/skill.js';
import type { SkillPolicy } from '../../../../../../src/runtime/skills/skill-types.js';
import { loadSkill } from '../../../../../../src/runtime/skills/skill-loader.js';
import { createTestPolicy, TEST_SKILL_MD } from '../../../../../helpers/factories.js';

// Mock network-policy for update action validation
vi.mock('../../../../../../src/runtime/container/network-policy.js', () => ({
  isValidDomain: vi.fn().mockReturnValue(true),
}));

describe('core.skill tool', () => {
  let skillsDir: string;
  let tool: ReturnType<typeof createSkillTool>;

  beforeEach(async () => {
    skillsDir = await mkdtemp(join(tmpdir(), 'skills-test-'));
    tool = createSkillTool({ skillsDir });
  });

  afterEach(async () => {
    await rm(skillsDir, { recursive: true, force: true });
  });

  /** Helper: set up a skill directory with SKILL.md and optional policy */
  async function setupSkill(name: string, policy?: SkillPolicy): Promise<string> {
    const dir = join(skillsDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), TEST_SKILL_MD);
    if (policy) {
      await writeFile(join(dir, 'policy.json'), JSON.stringify(policy));
    }
    return dir;
  }

  /** Helper: read policy.json from a skill directory */
  async function readPolicy(name: string): Promise<SkillPolicy> {
    const raw = await readFile(join(skillsDir, name, 'policy.json'), 'utf-8');
    return JSON.parse(raw) as SkillPolicy;
  }

  describe('read', () => {
    it('returns full skill content with policy', async () => {
      await setupSkill('test-skill', createTestPolicy({ status: 'pending_review' }));

      const result = (await tool.execute({
        action: 'read',
        name: 'test-skill',
      })) as SkillResult;

      expect(result.success).toBe(true);
      expect(result.skill).toBe('test-skill');
      expect(result.frontmatter).toBeDefined();
      expect(result.frontmatter?.['name']).toBe('test-skill');
      expect(result.frontmatter?.['description']).toBe('A test skill for testing');
      expect(result.body).toContain('# Test Skill');
      expect(result.body).toContain('Do something useful.');
      expect(result.status).toBe('pending_review');
      expect(result.policy).toBeDefined();
      expect(result.policy?.domains).toEqual(['api.example.com']);
    });

    it('works without policy.json', async () => {
      await setupSkill('test-skill'); // No policy

      const result = (await tool.execute({
        action: 'read',
        name: 'test-skill',
      })) as SkillResult;

      expect(result.success).toBe(true);
      expect(result.skill).toBe('test-skill');
      expect(result.frontmatter?.['name']).toBe('test-skill');
      expect(result.body).toContain('# Test Skill');
      expect(result.status).toBe('no_policy');
      expect(result.policy).toBeUndefined();
    });

    it('works with any status', async () => {
      await setupSkill('test-skill', createTestPolicy());

      const result = (await tool.execute({
        action: 'read',
        name: 'test-skill',
      })) as SkillResult;

      expect(result.success).toBe(true);
      expect(result.status).toBe('approved');
    });

    it('errors on nonexistent skill', async () => {
      const result = (await tool.execute({
        action: 'read',
        name: 'nonexistent-skill',
      })) as SkillResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('nonexistent-skill');
    });
  });

  describe('approve', () => {
    it('approves a pending_review skill (user can skip review)', async () => {
      await setupSkill('test-skill', createTestPolicy({ status: 'pending_review' }));

      const result = (await tool.execute(
        {
          action: 'approve',
          name: 'test-skill',
        },
        { triggerType: 'user_message', recipientId: 'test', correlationId: 'test' }
      )) as SkillResult;

      expect(result.success).toBe(true);
      expect(result.status).toBe('approved');
    });

    it('approves a reviewing skill (user can skip deep review)', async () => {
      await setupSkill('test-skill', createTestPolicy({ status: 'reviewing' }));

      const result = (await tool.execute(
        {
          action: 'approve',
          name: 'test-skill',
        },
        { triggerType: 'user_message', recipientId: 'test', correlationId: 'test' }
      )) as SkillResult;

      expect(result.success).toBe(true);
      expect(result.status).toBe('approved');
    });

    it('approves a needs_reapproval skill', async () => {
      await setupSkill('test-skill', createTestPolicy({ status: 'needs_reapproval' }));

      const result = (await tool.execute(
        {
          action: 'approve',
          name: 'test-skill',
        },
        { triggerType: 'user_message', recipientId: 'test', correlationId: 'test' }
      )) as SkillResult;

      expect(result.success).toBe(true);
      expect(result.status).toBe('approved');

      const saved = await readPolicy('test-skill');
      expect(saved.status).toBe('approved');
      expect(saved.approvedBy).toBe('user');
    });

    it('approves a reviewed skill', async () => {
      await setupSkill('test-skill', createTestPolicy({ status: 'reviewed' }));

      const result = (await tool.execute(
        {
          action: 'approve',
          name: 'test-skill',
        },
        { triggerType: 'user_message', recipientId: 'test', correlationId: 'test' }
      )) as SkillResult;

      expect(result.success).toBe(true);
      expect(result.status).toBe('approved');
    });

    it('stamps contentHash so approval survives subsequent loads', async () => {
      // Simulate a skill with a stale contentHash (content changed after extraction)
      const policy = createTestPolicy({
        status: 'needs_reapproval',
        provenance: {
          source: 'https://example.com',
          fetchedAt: '2026-01-01T00:00:00Z',
          contentHash: 'sha256:stale-hash-that-does-not-match',
        },
      });
      await setupSkill('test-skill', policy);

      // Approve
      const result = (await tool.execute(
        {
          action: 'approve',
          name: 'test-skill',
        },
        { triggerType: 'user_message', recipientId: 'test', correlationId: 'test' }
      )) as SkillResult;
      expect(result.success).toBe(true);
      expect(result.status).toBe('approved');

      // Reload — loadSkill() checks contentHash; approval must survive
      const reloaded = await loadSkill('test-skill', skillsDir);
      expect('error' in reloaded).toBe(false);
      if (!('error' in reloaded)) {
        expect(reloaded.policy?.status).toBe('approved');
      }
    });

    it('errors if skill is already approved', async () => {
      await setupSkill('test-skill', createTestPolicy());

      const result = (await tool.execute(
        {
          action: 'approve',
          name: 'test-skill',
        },
        { triggerType: 'user_message', recipientId: 'test', correlationId: 'test' }
      )) as SkillResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('already approved');
    });

    it('errors if skill has no policy', async () => {
      await setupSkill('test-skill'); // No policy

      const result = (await tool.execute(
        {
          action: 'approve',
          name: 'test-skill',
        },
        { triggerType: 'user_message', recipientId: 'test', correlationId: 'test' }
      )) as SkillResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('has no policy');
    });
  });

  describe('review', () => {
    it('transitions pending_review to reviewing (Phase 1)', async () => {
      await setupSkill('test-skill', createTestPolicy({ status: 'pending_review' }));

      const result = (await tool.execute({
        action: 'review',
        name: 'test-skill',
      })) as SkillResult;

      expect(result.success).toBe(true);

      const saved = await readPolicy('test-skill');
      expect(saved.status).toBe('reviewing');
    });

    it('transitions reviewing to reviewed (Phase 2)', async () => {
      await setupSkill('test-skill', createTestPolicy({ status: 'reviewing' }));

      const result = (await tool.execute({
        action: 'review',
        name: 'test-skill',
      })) as SkillResult;

      expect(result.success).toBe(true);

      const saved = await readPolicy('test-skill');
      expect(saved.status).toBe('reviewed');
    });

    it('no-op for reviewed skill without user_message trigger', async () => {
      await setupSkill('test-skill', createTestPolicy({ status: 'reviewed' }));

      const result = (await tool.execute({
        action: 'review',
        name: 'test-skill',
      })) as SkillResult;

      expect(result.success).toBe(true);

      const saved = await readPolicy('test-skill');
      expect(saved.status).toBe('reviewed');
    });

    it('re-dispatches review for reviewed skill on user_message trigger (no Motor → reviewing)', async () => {
      await setupSkill('test-skill', createTestPolicy({ status: 'reviewed' }));

      const result = (await tool.execute(
        { action: 'review', name: 'test-skill' },
        { triggerType: 'user_message' }
      )) as SkillResult;

      expect(result.success).toBe(true);
      expect(result.motorReviewDispatched).toBe(false); // No Motor available in test

      const saved = await readPolicy('test-skill');
      expect(saved.status).toBe('reviewing');
    });

    it('no-op for approved skill', async () => {
      await setupSkill('test-skill', createTestPolicy({ status: 'approved' }));

      const result = (await tool.execute({
        action: 'review',
        name: 'test-skill',
      })) as SkillResult;

      expect(result.success).toBe(true);

      const saved = await readPolicy('test-skill');
      expect(saved.status).toBe('approved');
    });
  });

  describe('consent gate', () => {
    it('blocks approve on non-user_message trigger', async () => {
      await setupSkill('test-skill', createTestPolicy({ status: 'pending_review' }));

      const result = (await tool.execute(
        {
          action: 'approve',
          name: 'test-skill',
        },
        { triggerType: 'motor_result', recipientId: 'test', correlationId: 'test' }
      )) as SkillResult;

      expect(result.success).toBe(false);
    });

    it('allows update on non-user_message for reviewing skill', async () => {
      await setupSkill('test-skill', createTestPolicy({ status: 'reviewing' }));

      const result = (await tool.execute(
        {
          action: 'update',
          name: 'test-skill',
          addDomains: ['test.com'],
        },
        { triggerType: 'motor_result', recipientId: 'test', correlationId: 'test' }
      )) as SkillResult;

      expect(result.success).toBe(true);
    });

    it('blocks update on non-user_message for approved skill', async () => {
      await setupSkill('test-skill', createTestPolicy({ status: 'approved' }));

      const result = (await tool.execute(
        {
          action: 'update',
          name: 'test-skill',
          addDomains: ['test.com'],
        },
        { triggerType: 'motor_result', recipientId: 'test', correlationId: 'test' }
      )) as SkillResult;

      expect(result.success).toBe(false);
    });
  });

  describe('reject', () => {
    it('rejects a pending_review skill back to needs_reapproval', async () => {
      await setupSkill('test-skill', createTestPolicy({ status: 'pending_review' }));

      const result = (await tool.execute(
        {
          action: 'reject',
          name: 'test-skill',
        },
        { triggerType: 'user_message', recipientId: 'test', correlationId: 'test' }
      )) as SkillResult;

      expect(result.success).toBe(true);
      expect(result.status).toBe('needs_reapproval');

      const saved = await readPolicy('test-skill');
      expect(saved.status).toBe('needs_reapproval');
      expect(saved.approvedBy).toBeUndefined();
      expect(saved.approvedAt).toBeUndefined();
    });

    it('errors if skill has no policy', async () => {
      await setupSkill('test-skill'); // No policy

      const result = (await tool.execute(
        {
          action: 'reject',
          name: 'test-skill',
        },
        { triggerType: 'user_message', recipientId: 'test', correlationId: 'test' }
      )) as SkillResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('has no policy');
    });
  });

  describe('error cases', () => {
    it('errors on missing name parameter', async () => {
      const result = (await tool.execute({
        action: 'read',
      })) as SkillResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('name');
    });

    it('errors on missing action parameter', async () => {
      const result = (await tool.execute({
        name: 'test-skill',
      })) as SkillResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('action');
    });

    it('errors on invalid action', async () => {
      const result = (await tool.execute({
        action: 'invalid_action',
        name: 'test-skill',
      })) as SkillResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('action');
    });
  });

  describe('tool metadata', () => {
    it('has correct name and tags', () => {
      expect(tool.name).toBe('core.skill');
      expect(tool.tags).toContain('skills');
    });

    it('has maxCallsPerTurn limit', () => {
      expect(tool.maxCallsPerTurn).toBe(3);
    });

    it('has hasSideEffects flag', () => {
      expect(tool.hasSideEffects).toBe(true);
    });

    it('has action parameter with enum', () => {
      const actionParam = tool.parameters.find((p) => p.name === 'action');
      expect(actionParam).toBeDefined();
      expect(actionParam?.enum).toEqual(['read', 'review', 'approve', 'reject', 'delete', 'update']);
    });
  });
});
