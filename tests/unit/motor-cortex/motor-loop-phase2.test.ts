/**
 * Unit tests for Motor Loop Phase 2: skill injection, approval flow, credential resolution.
 * Updated for attempt-based structure.
 */

import { describe, it, expect } from 'vitest';
import { buildMotorSystemPrompt, buildInitialMessages } from '../../../src/runtime/motor-cortex/motor-loop.js';
import type { MotorRun, MotorAttempt } from '../../../src/runtime/motor-cortex/motor-protocol.js';
import type { LoadedSkill } from '../../../src/runtime/skills/skill-types.js';

function makeAttempt(overrides?: Partial<MotorAttempt>): MotorAttempt {
  return {
    id: 'att_0',
    index: 0,
    status: 'running',
    messages: [],
    stepCursor: 0,
    maxIterations: 20,
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
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRun(overrides?: Partial<MotorRun>): MotorRun {
  const attempt = makeAttempt();
  return {
    id: 'test-run',
    status: 'running',
    task: 'Test task',
    tools: ['code', 'shell', 'read', 'write', 'list'],
    attempts: [attempt],
    currentAttemptIndex: 0,
    maxAttempts: 3,
    startedAt: new Date().toISOString(),
    energyConsumed: 0,
    ...overrides,
  };
}

describe('buildMotorSystemPrompt', () => {
  it('includes all tool descriptions', () => {
    const run = makeRun();
    const prompt = buildMotorSystemPrompt(run);

    expect(prompt).toContain('code:');
    expect(prompt).toContain('shell:');
    expect(prompt).toContain('read:');
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

  it('includes recovery context when provided', () => {
    const run = makeRun();
    const recoveryContext = {
      source: 'cognition' as const,
      previousAttemptId: 'att_0',
      guidance: 'Try using a different URL: https://api.example.com/v2',
      constraints: ['do not retry login more than once'],
    };
    const prompt = buildMotorSystemPrompt(run, undefined, recoveryContext);

    expect(prompt).toContain('<recovery_context source="cognition">');
    expect(prompt).toContain('Try using a different URL');
    expect(prompt).toContain('do not retry login more than once');
    expect(prompt).toContain('</recovery_context>');
  });

  it('does not include recovery context when not provided', () => {
    const run = makeRun();
    const prompt = buildMotorSystemPrompt(run);
    expect(prompt).not.toContain('<recovery_context');
  });
});

describe('skill injection into system prompt', () => {
  const skill: LoadedSkill = {
    frontmatter: {
      name: 'weather-report',
      description: 'Fetch weather data from a public API',
    },
    policy: {
      schemaVersion: 1,
      trust: 'approved',
      allowedTools: ['shell', 'code'],
      requiredCredentials: ['weather_api_key'],
    },
    body: '# Weather Report\n\nUse curl -H "Authorization: Bearer <credential:weather_api_key>" to call the API.',
    path: '/data/skills/weather-report',
    skillPath: '/data/skills/weather-report/SKILL.md',
  };

  it('injects skill body in <skill> XML tags', () => {
    const run = makeRun();
    const prompt = buildMotorSystemPrompt(run, skill);

    expect(prompt).toContain('<skill name="weather-report">');
    expect(prompt).toContain('# Weather Report');
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
      frontmatter: {
        name: 'test',
        description: 'Test',
      },
      body: 'Skill body',
      path: '/test',
      skillPath: '/test/SKILL.md',
    };

    const messages = buildInitialMessages(run, skill);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain('<skill name="test">');
    expect(messages[0]?.content).toContain('Skill body');
  });

  it('creates system message without skill', () => {
    const run = makeRun();
    const messages = buildInitialMessages(run);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).not.toContain('<skill');
  });

  it('creates system message with recovery context', () => {
    const run = makeRun();
    const recoveryContext = {
      source: 'cognition' as const,
      previousAttemptId: 'att_0',
      guidance: 'Use port 8080 instead of 443',
    };

    const messages = buildInitialMessages(run, undefined, recoveryContext);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain('<recovery_context');
    expect(messages[0]?.content).toContain('Use port 8080 instead of 443');
  });
});

describe('approval flow types', () => {
  it('MotorAttempt supports awaiting_approval status', () => {
    const attempt = makeAttempt({
      status: 'awaiting_approval',
      pendingApproval: {
        action: 'Send POST request to external API',
        stepCursor: 3,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    });

    expect(attempt.status).toBe('awaiting_approval');
    expect(attempt.pendingApproval?.action).toBe('Send POST request to external API');
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

describe('attempt-based MotorRun structure', () => {
  it('MotorRun has attempts array and currentAttemptIndex', () => {
    const run = makeRun();
    expect(run.attempts).toHaveLength(1);
    expect(run.currentAttemptIndex).toBe(0);
    expect(run.maxAttempts).toBe(3);
  });

  it('MotorAttempt has failure and recoveryContext fields', () => {
    const attempt = makeAttempt({
      status: 'failed',
      failure: {
        category: 'tool_failure',
        lastErrorCode: 'timeout',
        retryable: true,
        suggestedAction: 'retry_with_guidance',
        lastToolResults: [{ tool: 'shell', ok: false, errorCode: 'timeout', output: 'Connection timed out' }],
        hint: 'The endpoint appears to be down',
      },
      recoveryContext: {
        source: 'cognition',
        previousAttemptId: 'att_0',
        guidance: 'Try a different endpoint',
      },
    });

    expect(attempt.failure?.category).toBe('tool_failure');
    expect(attempt.failure?.retryable).toBe(true);
    expect(attempt.recoveryContext?.guidance).toBe('Try a different endpoint');
  });
});
