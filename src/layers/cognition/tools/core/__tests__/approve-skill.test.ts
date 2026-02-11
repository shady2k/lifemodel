/**
 * Tests for core.approveSkill tool
 *
 * Validates: approve/reject flows, error cases, tool metadata.
 * Uses temp directories with mock SKILL.md + policy.json.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApproveSkillTool } from '../approve-skill.js';
import type { ApproveSkillResult } from '../approve-skill.js';
import type { SkillPolicy } from '../../../../../runtime/skills/skill-types.js';

/** Minimal valid SKILL.md content */
const SKILL_MD = `---
name: test-skill
description: A test skill for approval testing
---
# Test Skill
Do something useful.
`;

/** Create a policy.json with given trust state */
function makePolicy(trust: 'unknown' | 'pending_review' | 'approved'): SkillPolicy {
  return {
    schemaVersion: 1,
    trust,
    allowedTools: ['shell', 'code'],
    allowedDomains: ['api.example.com'],
  };
}

describe('core.approveSkill tool', () => {
  let skillsDir: string;
  let tool: ReturnType<typeof createApproveSkillTool>;

  beforeEach(async () => {
    // Create temp skills directory
    skillsDir = await mkdtemp(join(tmpdir(), 'skills-test-'));
    tool = createApproveSkillTool({ skillsDir });
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

  describe('approve', () => {
    it('approves a pending_review skill', async () => {
      await setupSkill('test-skill', makePolicy('pending_review'));

      const result = (await tool.execute({
        skill: 'test-skill',
        approve: true,
      })) as ApproveSkillResult;

      expect(result.success).toBe(true);
      expect(result.skill).toBe('test-skill');
      expect(result.trust).toBe('approved');
      expect(result.allowedTools).toEqual(['shell', 'code']);
      expect(result.allowedDomains).toEqual(['api.example.com']);

      // Verify persisted
      const saved = await readPolicy('test-skill');
      expect(saved.trust).toBe('approved');
      expect(saved.approvedBy).toBe('user');
      expect(saved.approvedAt).toBeDefined();
    });

    it('approves an unknown skill', async () => {
      await setupSkill('test-skill', makePolicy('unknown'));

      const result = (await tool.execute({
        skill: 'test-skill',
        approve: true,
      })) as ApproveSkillResult;

      expect(result.success).toBe(true);
      expect(result.trust).toBe('approved');

      const saved = await readPolicy('test-skill');
      expect(saved.trust).toBe('approved');
      expect(saved.approvedBy).toBe('user');
    });
  });

  describe('reject', () => {
    it('rejects a pending_review skill back to unknown', async () => {
      await setupSkill('test-skill', makePolicy('pending_review'));

      const result = (await tool.execute({
        skill: 'test-skill',
        approve: false,
      })) as ApproveSkillResult;

      expect(result.success).toBe(true);
      expect(result.trust).toBe('unknown');

      const saved = await readPolicy('test-skill');
      expect(saved.trust).toBe('unknown');
      expect(saved.approvedBy).toBeUndefined();
      expect(saved.approvedAt).toBeUndefined();
    });
  });

  describe('error cases', () => {
    it('errors if skill is already approved', async () => {
      await setupSkill('test-skill', makePolicy('approved'));

      const result = (await tool.execute({
        skill: 'test-skill',
        approve: true,
      })) as ApproveSkillResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('already approved');
    });

    it('errors if skill does not exist', async () => {
      const result = (await tool.execute({
        skill: 'nonexistent-skill',
        approve: true,
      })) as ApproveSkillResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('nonexistent-skill');
    });

    it('errors if skill has no policy', async () => {
      await setupSkill('test-skill'); // No policy

      const result = (await tool.execute({
        skill: 'test-skill',
        approve: true,
      })) as ApproveSkillResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('no policy.json');
    });

    it('errors on missing skill parameter', async () => {
      const result = (await tool.execute({
        approve: true,
      })) as ApproveSkillResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('skill');
    });

    it('errors on missing approve parameter', async () => {
      const result = (await tool.execute({
        skill: 'test-skill',
      })) as ApproveSkillResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('approve');
    });
  });

  describe('tool metadata', () => {
    it('has correct name and tags', () => {
      expect(tool.name).toBe('core.approveSkill');
      expect(tool.tags).toContain('skills');
      expect(tool.tags).toContain('security');
      expect(tool.tags).toContain('approval');
    });

    it('has maxCallsPerTurn limit', () => {
      expect(tool.maxCallsPerTurn).toBe(3);
    });

    it('has hasSideEffects flag', () => {
      expect(tool.hasSideEffects).toBe(true);
    });
  });
});
