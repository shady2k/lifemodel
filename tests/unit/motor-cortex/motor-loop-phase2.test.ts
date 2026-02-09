/**
 * Unit tests for Motor Loop Phase 2: skill injection, approval flow, credential resolution.
 */

import { describe, it, expect } from 'vitest';
import { buildMotorSystemPrompt, buildInitialMessages } from '../../../src/runtime/motor-cortex/motor-loop.js';
import type { MotorRun } from '../../../src/runtime/motor-cortex/motor-protocol.js';
import type { LoadedSkill } from '../../../src/runtime/skills/skill-types.js';

function makeRun(overrides?: Partial<MotorRun>): MotorRun {
  return {
    id: 'test-run',
    status: 'running',
    task: 'Test task',
    tools: ['code', 'shell', 'filesystem'],
    stepCursor: 0,
    maxIterations: 20,
    messages: [],
    startedAt: new Date().toISOString(),
    energyConsumed: 0,
    trace: {
      runId: 'test-run',
      task: 'Test task',
      status: 'running',
      steps: [],
      totalIterations: 0,
      totalDurationMs: 0,
      totalEnergyCost: 0,
      llmCalls: 0,
      toolCalls: 0,
      errors: 0,
    },
    ...overrides,
  };
}

describe('buildMotorSystemPrompt', () => {
  it('includes all tool descriptions', () => {
    const run = makeRun();
    const prompt = buildMotorSystemPrompt(run);

    expect(prompt).toContain('code:');
    expect(prompt).toContain('shell:');
    expect(prompt).toContain('filesystem:');
  });

  it('includes new Phase 2 tools in descriptions', () => {
    const run = makeRun({ tools: ['grep', 'patch'] });
    const prompt = buildMotorSystemPrompt(run);

    expect(prompt).toContain('grep:');
    expect(prompt).toContain('patch:');
  });

  it('includes credential placeholder guidance', () => {
    const run = makeRun();
    const prompt = buildMotorSystemPrompt(run);
    expect(prompt).toContain('<credential:name>');
  });
});

describe('skill injection into system prompt', () => {
  const skill: LoadedSkill = {
    definition: {
      name: 'agentmail',
      version: 1,
      description: 'Send emails via AgentMail',
      tools: ['shell', 'code'],
      credentials: ['agentmail_api_key'],
    },
    body: '# AgentMail\n\nUse curl -H "Authorization: Bearer <credential:agentmail_api_key>" to call the API.',
    path: '/data/skills/agentmail/SKILL.md',
  };

  it('injects skill body in <skill> XML tags', () => {
    const run = makeRun();
    const prompt = buildMotorSystemPrompt(run, skill);

    expect(prompt).toContain('<skill name="agentmail" version="1">');
    expect(prompt).toContain('# AgentMail');
    expect(prompt).toContain('</skill>');
  });

  it('includes skill prompt injection warning', () => {
    const run = makeRun();
    const prompt = buildMotorSystemPrompt(run, skill);

    expect(prompt).toContain('user-provided instructions');
    expect(prompt).toContain('never override your safety rules');
  });

  it('does not inject skill tags when no skill provided', () => {
    const run = makeRun();
    const prompt = buildMotorSystemPrompt(run);

    expect(prompt).not.toContain('<skill');
    expect(prompt).not.toContain('</skill>');
  });
});

describe('buildInitialMessages', () => {
  it('creates system message with skill when provided', () => {
    const run = makeRun();
    const skill: LoadedSkill = {
      definition: {
        name: 'test',
        version: 1,
        description: 'Test',
        tools: ['code'],
      },
      body: 'Skill body',
      path: '/test',
    };

    const messages = buildInitialMessages(run, skill);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain('<skill name="test"');
    expect(messages[0]?.content).toContain('Skill body');
  });

  it('creates system message without skill', () => {
    const run = makeRun();
    const messages = buildInitialMessages(run);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).not.toContain('<skill');
  });
});

describe('approval flow types', () => {
  it('MotorRun supports awaiting_approval status', () => {
    const run = makeRun({
      status: 'awaiting_approval',
      pendingApproval: {
        action: 'Send POST request to external API',
        stepCursor: 3,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    });

    expect(run.status).toBe('awaiting_approval');
    expect(run.pendingApproval?.action).toBe('Send POST request to external API');
  });

  it('MotorRun supports artifacts in TaskResult', () => {
    const run = makeRun({
      status: 'completed',
      result: {
        ok: true,
        summary: 'Done',
        runId: 'test-run',
        artifacts: ['output.json', 'report.md'],
        stats: { iterations: 5, durationMs: 10000, energyCost: 0.1, errors: 0 },
      },
    });

    expect(run.result?.artifacts).toEqual(['output.json', 'report.md']);
  });
});
