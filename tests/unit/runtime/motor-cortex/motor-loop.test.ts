/**
 * Tests for motor-prompt.ts
 */

import { describe, it, expect } from 'vitest';
import { buildMotorSystemPrompt } from '../../../../src/runtime/motor-cortex/motor-prompt.js';

describe('buildMotorSystemPrompt', () => {
  it('includes skill creation instructions when callerInstructions include them', () => {
    const prompt = buildMotorSystemPrompt({
      task: 'Create a skill',
      tools: ['read', 'write', 'list'],
      syntheticTools: ['ask_user'],
      callerInstructions:
        'You create and maintain Agent Skills.\nname: skill-name\ndescription: What this skill does',
    });

    expect(prompt).toContain('You create and maintain Agent Skills');
    expect(prompt).toContain('name: skill-name');
    expect(prompt).toContain('description: What this skill does');
  });

  it('does not include skill creation instructions when callerInstructions are absent', () => {
    const prompt = buildMotorSystemPrompt({
      task: 'Run task',
      tools: ['bash', 'read'],
      syntheticTools: ['ask_user'],
    });

    expect(prompt).not.toContain('You create and maintain Agent Skills');
    expect(prompt).not.toContain('SKILL.md format');
  });

  it('includes tool descriptions', () => {
    const prompt = buildMotorSystemPrompt({
      task: 'Run task',
      tools: ['bash'],
      syntheticTools: [],
    });

    expect(prompt).toContain('- bash:');
  });

  it('includes guidelines section', () => {
    const prompt = buildMotorSystemPrompt({
      task: 'Run task',
      tools: ['read'],
      syntheticTools: [],
    });

    expect(prompt).toContain('Guidelines:');
    expect(prompt).toContain('Break down complex tasks into steps');
    expect(prompt).toContain('Credentials are environment variables');
  });

  it('includes maximum iterations', () => {
    const prompt = buildMotorSystemPrompt({
      task: 'Run task',
      tools: ['read'],
      syntheticTools: [],
      maxIterations: 42,
    });

    expect(prompt).toContain('Maximum iterations: 42');
  });

  it('does not include invalid tools', () => {
    const prompt = buildMotorSystemPrompt({
      task: 'Run task',
      tools: ['write', 'bash'],
      syntheticTools: [],
    });

    expect(prompt).not.toContain('- search:');
    expect(prompt).toContain('- bash:');
  });
});
