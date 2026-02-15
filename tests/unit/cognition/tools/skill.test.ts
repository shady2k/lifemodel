/**
 * Core Skill Tool Tests
 *
 * Tests for consent gating: approve, reject, delete require user_message trigger.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSkillTool } from '../../../../src/layers/cognition/tools/core/skill.js';
import type { Tool } from '../../../../src/layers/cognition/tools/types.js';
import { createTestPolicy } from '../../../helpers/factories.js';

describe('core.skill tool', () => {
  let skillsDir: string;
  let tool: Tool;

  beforeEach(async () => {
    const base = tmpdir();
    skillsDir = join(base, `.test-skill-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(skillsDir, { recursive: true });

    tool = createSkillTool({ skillsDir });
  });

  afterEach(async () => {
    await rm(skillsDir, { recursive: true, force: true });
  });

  async function createSkill(name: string, status: 'pending_review' | 'needs_reapproval' | 'reviewed' | 'approved' = 'pending_review'): Promise<void> {
    const skillDir = join(skillsDir, name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Test skill\n---\n# ${name}`,
      'utf-8'
    );
    await writeFile(
      join(skillDir, 'policy.json'),
      JSON.stringify(createTestPolicy({ status })),
      'utf-8'
    );
  }

  describe('action=read', () => {
    it('succeeds without user_message trigger', async () => {
      await createSkill('test-read');

      const result = await tool.execute(
        { action: 'read', name: 'test-read' },
        { triggerType: 'motor_result', recipientId: 'test', correlationId: 'test' }
      );

      expect(result).toMatchObject({ success: true, skill: 'test-read' });
    });
  });

  describe('action=review', () => {
    it('succeeds without user_message trigger', async () => {
      await createSkill('test-review');

      const result = await tool.execute(
        { action: 'review', name: 'test-review' },
        { triggerType: 'motor_result', recipientId: 'test', correlationId: 'test' }
      );

      expect(result).toMatchObject({ success: true, skill: 'test-review' });
      expect((result as { review?: { name: string } }).review?.name).toBe('test-review');
    });
  });

  describe('action=approve - consent gate', () => {
    it('rejects when triggerType is motor_result', async () => {
      await createSkill('test-approve');

      const result = await tool.execute(
        { action: 'approve', name: 'test-approve' },
        { triggerType: 'motor_result', recipientId: 'test', correlationId: 'test' }
      );

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('user interaction'),
      });
    });

    it('rejects when triggerType is thought', async () => {
      await createSkill('test-approve-thought');

      const result = await tool.execute(
        { action: 'approve', name: 'test-approve-thought' },
        { triggerType: 'thought', recipientId: 'test', correlationId: 'test' }
      );

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('user interaction'),
      });
    });

    it('succeeds when triggerType is user_message and trust is needs_reapproval', async () => {
      await createSkill('test-approve-user', 'needs_reapproval');

      const result = await tool.execute(
        { action: 'approve', name: 'test-approve-user' },
        { triggerType: 'user_message', recipientId: 'test', correlationId: 'test' }
      );

      expect(result).toMatchObject({ success: true, status: 'approved' });
    });

    it('allows approve for pending_review skill (user can skip review)', async () => {
      await createSkill('test-approve-pending', 'pending_review');

      const result = await tool.execute(
        { action: 'approve', name: 'test-approve-pending' },
        { triggerType: 'user_message', recipientId: 'test', correlationId: 'test' }
      );

      expect(result).toMatchObject({ success: true, status: 'approved' });
    });
  });

  describe('action=reject - consent gate', () => {
    it('rejects when triggerType is motor_result', async () => {
      await createSkill('test-reject', 'approved');

      const result = await tool.execute(
        { action: 'reject', name: 'test-reject' },
        { triggerType: 'motor_result', recipientId: 'test', correlationId: 'test' }
      );

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('user interaction'),
      });
    });

    it('succeeds when triggerType is user_message', async () => {
      await createSkill('test-reject-user', 'approved');

      const result = await tool.execute(
        { action: 'reject', name: 'test-reject-user' },
        { triggerType: 'user_message', recipientId: 'test', correlationId: 'test' }
      );

      expect(result).toMatchObject({ success: true, status: 'needs_reapproval' });
    });
  });

  describe('action=delete - consent gate', () => {
    it('rejects when triggerType is motor_result', async () => {
      await createSkill('test-delete');

      const result = await tool.execute(
        { action: 'delete', name: 'test-delete' },
        { triggerType: 'motor_result', recipientId: 'test', correlationId: 'test' }
      );

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('user interaction'),
      });
    });

    it('succeeds when triggerType is user_message', async () => {
      await createSkill('test-delete-user');

      const result = await tool.execute(
        { action: 'delete', name: 'test-delete-user' },
        { triggerType: 'user_message', recipientId: 'test', correlationId: 'test' }
      );

      expect(result).toMatchObject({ success: true, skill: 'test-delete-user' });
    });
  });
});
