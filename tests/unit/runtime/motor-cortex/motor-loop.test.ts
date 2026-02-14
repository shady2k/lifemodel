/**
 * Tests for motor-loop.ts
 *
 * Validates: System prompt content with new workspace-root skill model
 */

import { describe, it, expect } from 'vitest';
import { buildMotorSystemPrompt } from '../../../../src/runtime/motor-cortex/motor-loop.js';
import type { MotorRun } from '../../../../src/runtime/motor-cortex/motor-protocol.js';
import type { LoadedSkill } from '../../../../src/runtime/skills/skill-types.js';

describe('buildMotorSystemPrompt', () => {
  function createMockRun(tools: string[] = ['bash']): MotorRun {
    return {
      id: 'test-run',
      task: 'Test task',
      tools: tools as MotorRun['tools'],
      status: 'running',
      attempts: [],
      currentAttemptIndex: 0,
      maxAttempts: 3,
      config: {
        syntheticTools: ['ask_user', 'save_credential', 'request_approval'],
        installDependencies: true,
        mergePolicyDomains: true,
      },
      startedAt: new Date().toISOString(),
      energyConsumed: 0,
    } satisfies MotorRun;
  }

  function createMockSkill(): LoadedSkill {
    return {
      frontmatter: { name: 'test-skill', description: 'Test skill' },
      body: 'Skill instructions here.',
      path: '/path',
      skillPath: '/path/SKILL.md',
    } as LoadedSkill;
  }

  it('includes skill creation instructions when write tool is granted', () => {
    const run = createMockRun(['code', 'read', 'write', 'list']);
    const prompt = buildMotorSystemPrompt(run);

    expect(prompt).toContain('You create and maintain Agent Skills');
    expect(prompt).toContain('name: skill-name');
    expect(prompt).toContain('description: What this skill does');
    // policy.json is no longer in the prompt (excluded from container)
    expect(prompt).toContain('Save files at the workspace root');
    expect(prompt).toContain('Trust is always "needs_review"');
  });

  it('does NOT include skill creation instructions when write is not granted', () => {
    const run = createMockRun(['bash', 'read']);
    const prompt = buildMotorSystemPrompt(run);

    expect(prompt).not.toContain('You create and maintain Agent Skills');
    expect(prompt).not.toContain('SKILL.md format');
  });

  it('includes skill reference with workspace root paths when skill is provided', () => {
    const run = createMockRun();
    const skill = createMockSkill();
    const prompt = buildMotorSystemPrompt(run, skill);

    expect(prompt).toContain('Skill: test-skill');
    expect(prompt).toContain('Start by reading SKILL.md');
    expect(prompt).toContain('read({path: "SKILL.md"})');
    expect(prompt).toContain('modify skill files directly in the workspace');
  });

  it('does NOT include skill section when no skill provided', () => {
    const run = createMockRun();
    const prompt = buildMotorSystemPrompt(run);

    expect(prompt).not.toContain('<skill');
  });

  it('includes tool descriptions', () => {
    const run = createMockRun(['bash']);
    const prompt = buildMotorSystemPrompt(run);

    expect(prompt).toContain('- bash:');
  });

  it('includes guidelines section', () => {
    const run = createMockRun();
    const prompt = buildMotorSystemPrompt(run);

    expect(prompt).toContain('Guidelines:');
    expect(prompt).toContain('Break down complex tasks into steps');
    expect(prompt).toContain('Credentials are environment variables');
  });

  it('includes maximum iterations', () => {
    const run = createMockRun();
    const prompt = buildMotorSystemPrompt(run);

    expect(prompt).toContain('Maximum iterations:');
  });

  it('does NOT include search tool in tool descriptions', () => {
    const run = createMockRun(['write', 'bash']);
    const prompt = buildMotorSystemPrompt(run);

    // search tool is not a valid motor tool
    expect(prompt).not.toContain('- search:');
    // bash should be available
    expect(prompt).toContain('- bash:');
  });
});
