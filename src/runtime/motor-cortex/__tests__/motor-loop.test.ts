/**
 * Tests for motor-loop.ts
 *
 * Validates: Skill creation format in system prompt when filesystem granted
 */

import { describe, it, expect } from 'vitest';
import { buildMotorSystemPrompt } from '../motor-loop.js';
import type { MotorRun } from '../motor-protocol.js';
import type { LoadedSkill } from '../../skills/skill-types.js';

describe('buildMotorSystemPrompt', () => {
  function createMockRun(tools: string[] = ['code']): MotorRun {
    return {
      id: 'test-run',
      task: 'Test task',
      tools: tools as MotorRun['tools'],
      status: 'running',
      attempts: [],
      currentAttemptIndex: 0,
      maxAttempts: 3,
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

    expect(prompt).toContain('When creating skills, use the Agent Skills standard');
    expect(prompt).toContain('name: skill-name');
    expect(prompt).toContain('description: What this skill does');
    expect(prompt).toContain('policy.json');
    expect(prompt).toContain('skills/<name>/SKILL.md');
    expect(prompt).toContain(
      'Valid tools: code, read, write, list, glob, shell, grep, patch, ask_user'
    );
  });

  it('does NOT include skill creation instructions when write is not granted', () => {
    const run = createMockRun(['code', 'shell']);
    const prompt = buildMotorSystemPrompt(run);

    expect(prompt).not.toContain('When creating skills, use the Agent Skills standard');
    expect(prompt).not.toContain('policy.json');
  });

  it('includes skill reference with path when skill is provided', () => {
    const run = createMockRun();
    const skill = createMockSkill();
    const prompt = buildMotorSystemPrompt(run, skill);

    expect(prompt).toContain('Skill: test-skill');
    expect(prompt).toContain('Skill directory:');
    expect(prompt).toContain('Read its files before starting work');
    expect(prompt).toContain('reading SKILL.md');
  });

  it('does NOT include skill section when no skill provided', () => {
    const run = createMockRun();
    const prompt = buildMotorSystemPrompt(run);

    expect(prompt).not.toContain('<skill');
  });

  it('includes tool descriptions', () => {
    const run = createMockRun(['code', 'shell']);
    const prompt = buildMotorSystemPrompt(run);

    expect(prompt).toContain('- code:');
    expect(prompt).toContain('- shell:');
  });

  it('includes guidelines section', () => {
    const run = createMockRun();
    const prompt = buildMotorSystemPrompt(run);

    expect(prompt).toContain('Guidelines:');
    expect(prompt).toContain('Break down complex tasks into steps');
    expect(prompt).toContain('<credential:NAME>');
  });

  it('includes maximum iterations', () => {
    const run = createMockRun();
    const prompt = buildMotorSystemPrompt(run);

    expect(prompt).toContain('Maximum iterations:');
  });
});
