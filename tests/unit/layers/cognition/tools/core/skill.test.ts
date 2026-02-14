/**
 * Tests for core.skill tool
 *
 * Validates: read, approve, reject flows, error cases, tool metadata.
 * Uses temp directories with mock SKILL.md + policy.json.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillTool } from '../../../../../../src/layers/cognition/tools/core/skill.js';
import type { SkillResult } from '../../../../../../src/layers/cognition/tools/core/skill.js';
import type { SkillPolicy } from '../../../../../../src/runtime/skills/skill-types.js';
import { loadSkill } from '../../../../../../src/runtime/skills/skill-loader.js';

/** Minimal valid SKILL.md content */
const SKILL_MD = `---
name: test-skill
description: A test skill for testing
---
# Test Skill
Do something useful.
`;

/** Create a policy.json with given trust state */
function makePolicy(trust: 'needs_reapproval' | 'pending_review' | 'approved'): SkillPolicy {
  return {
    schemaVersion: 1,
    trust,
    allowedDomains: ['api.example.com'],
  };
}

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
    await writeFile(join(dir, 'SKILL.md'), SKILL_MD);
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
      await setupSkill('test-skill', makePolicy('pending_review'));

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
      expect(result.trust).toBe('pending_review');
      expect(result.policy).toBeDefined();
      expect(result.policy?.allowedDomains).toEqual(['api.example.com']);
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
      expect(result.trust).toBe('no_policy');
      expect(result.policy).toBeUndefined();
    });

    it('works with any trust state', async () => {
      await setupSkill('test-skill', makePolicy('approved'));

      const result = (await tool.execute({
        action: 'read',
        name: 'test-skill',
      })) as SkillResult;

      expect(result.success).toBe(true);
      expect(result.trust).toBe('approved');
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
    it('approves a pending_review skill', async () => {
      await setupSkill('test-skill', makePolicy('pending_review'));

      const result = (await tool.execute(
        {
          action: 'approve',
          name: 'test-skill',
        },
        { triggerType: 'user_message', recipientId: 'test', correlationId: 'test' }
      )) as SkillResult;

      expect(result.success).toBe(true);
      expect(result.skill).toBe('test-skill');
      expect(result.trust).toBe('approved');
      expect(result.allowedDomains).toEqual(['api.example.com']);

      // Verify persisted
      const saved = await readPolicy('test-skill');
      expect(saved.trust).toBe('approved');
      expect(saved.approvedBy).toBe('user');
      expect(saved.approvedAt).toBeDefined();
    });

    it('approves a needs_reapproval skill', async () => {
      await setupSkill('test-skill', makePolicy('needs_reapproval'));

      const result = (await tool.execute(
        {
          action: 'approve',
          name: 'test-skill',
        },
        { triggerType: 'user_message', recipientId: 'test', correlationId: 'test' }
      )) as SkillResult;

      expect(result.success).toBe(true);
      expect(result.trust).toBe('approved');

      const saved = await readPolicy('test-skill');
      expect(saved.trust).toBe('approved');
      expect(saved.approvedBy).toBe('user');
    });

    it('stamps contentHash so approval survives subsequent loads', async () => {
      // Simulate a skill with a stale contentHash (content changed after extraction)
      const policy = makePolicy('needs_reapproval');
      policy.provenance = {
        source: 'https://example.com',
        fetchedAt: '2026-01-01T00:00:00Z',
        contentHash: 'sha256:stale-hash-that-does-not-match',
      };
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
      expect(result.trust).toBe('approved');

      // Reload — loadSkill() checks contentHash; approval must survive
      const reloaded = await loadSkill('test-skill', skillsDir);
      expect('error' in reloaded).toBe(false);
      if (!('error' in reloaded)) {
        expect(reloaded.policy?.trust).toBe('approved');
      }
    });

    it('errors if skill is already approved', async () => {
      await setupSkill('test-skill', makePolicy('approved'));

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
      expect(result.error).toContain('no policy.json');
    });
  });

  describe('reject', () => {
    it('rejects a pending_review skill back to needs_reapproval', async () => {
      await setupSkill('test-skill', makePolicy('pending_review'));

      const result = (await tool.execute(
        {
          action: 'reject',
          name: 'test-skill',
        },
        { triggerType: 'user_message', recipientId: 'test', correlationId: 'test' }
      )) as SkillResult;

      expect(result.success).toBe(true);
      expect(result.trust).toBe('needs_reapproval');

      const saved = await readPolicy('test-skill');
      expect(saved.trust).toBe('needs_reapproval');
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
      expect(result.error).toContain('no policy.json');
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
      expect(actionParam?.enum).toEqual(['read', 'review', 'approve', 'reject', 'delete']);
    });
  });
});
