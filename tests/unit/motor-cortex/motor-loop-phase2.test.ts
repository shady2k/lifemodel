/**
 * Unit tests for Motor Cortex Phase 2: prompt builder, approval flow, credential resolution.
 * Updated for the new architecture where Motor Cortex is a pure runtime.
 *
 * Key changes from original:
 * - buildMotorSystemPrompt moved from motor-loop.ts to motor-prompt.ts
 * - buildInitialMessages removed (messages created by motor-cortex.ts createAttempt)
 * - Skill injection is now via callerInstructions (built by act.ts), not the prompt builder
 */

import { describe, it, expect } from 'vitest';
import { buildMotorSystemPrompt } from '../../../src/runtime/motor-cortex/motor-prompt.js';
import type { MotorRun, MotorAttempt } from '../../../src/runtime/motor-cortex/motor-protocol.js';

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
    tools: ['bash', 'read', 'write', 'list'],
    attempts: [attempt],
    currentAttemptIndex: 0,
    maxAttempts: 3,
    startedAt: new Date().toISOString(),
    energyConsumed: 0,
    config: {
      syntheticTools: ['ask_user', 'save_credential', 'request_approval'],
    },
    ...overrides,
  };
}

describe('buildMotorSystemPrompt', () => {
  it('includes all tool descriptions', () => {
    const prompt = buildMotorSystemPrompt({
      task: 'Test task',
      tools: ['bash', 'read', 'write', 'list'],
      syntheticTools: ['ask_user', 'save_credential', 'request_approval'],
    });

    expect(prompt).toContain('bash:');
    expect(prompt).toContain('read:');
  });

  it('includes Phase 2 tools in descriptions', () => {
    const prompt = buildMotorSystemPrompt({
      task: 'Test task',
      tools: ['grep', 'patch'],
      syntheticTools: [],
    });

    expect(prompt).toContain('grep:');
    expect(prompt).toContain('patch:');
  });

  it('includes credential guidance', () => {
    const prompt = buildMotorSystemPrompt({
      task: 'Test task',
      tools: ['bash'],
      syntheticTools: [],
    });
    expect(prompt).toContain('Credentials are environment variables');
  });

  it('includes recovery context when provided', () => {
    const prompt = buildMotorSystemPrompt({
      task: 'Test task',
      tools: ['bash'],
      syntheticTools: [],
      recoveryContext: {
        source: 'cognition' as const,
        previousAttemptId: 'att_0',
        guidance: 'Try using a different URL: https://api.example.com/v2',
        constraints: ['do not retry login more than once'],
      },
    });

    expect(prompt).toContain('<recovery_context source="cognition">');
    expect(prompt).toContain('Try using a different URL');
    expect(prompt).toContain('do not retry login more than once');
    expect(prompt).toContain('</recovery_context>');
  });

  it('does not include recovery context when not provided', () => {
    const prompt = buildMotorSystemPrompt({
      task: 'Test task',
      tools: ['bash'],
      syntheticTools: [],
    });
    expect(prompt).not.toContain('<recovery_context');
  });
});

describe('callerInstructions injection', () => {
  it('includes caller instructions when provided', () => {
    const prompt = buildMotorSystemPrompt({
      task: 'Test task',
      tools: ['bash', 'read'],
      syntheticTools: [],
      callerInstructions: 'Skill: weather-report\nread({path: "SKILL.md"})\nlist({path: "."})',
    });

    expect(prompt).toContain('Skill: weather-report');
    expect(prompt).toContain('read({path: "SKILL.md"})');
    expect(prompt).toContain('list({path: "."})');
  });

  it('includes credential guidance in caller instructions', () => {
    const prompt = buildMotorSystemPrompt({
      task: 'Test task',
      tools: ['bash', 'read'],
      syntheticTools: [],
      callerInstructions: 'Available credentials (as env vars):\n- weather_api_key\nUsage:\n  Node script: const apiKey = process.env.weather_api_key;',
    });

    expect(prompt).toContain('process.env.weather_api_key');
  });

  it('does not include skill content when no caller instructions', () => {
    const prompt = buildMotorSystemPrompt({
      task: 'Test task',
      tools: ['bash'],
      syntheticTools: [],
    });

    expect(prompt).not.toContain('Skill:');
  });
});

describe('domain handling', () => {
  it('includes allowed domains', () => {
    const prompt = buildMotorSystemPrompt({
      task: 'Test task',
      tools: ['bash'],
      syntheticTools: [],
      domains: ['api.example.com', 'github.com'],
    });

    expect(prompt).toContain('api.example.com');
    expect(prompt).toContain('github.com');
    expect(prompt).toContain('Allowed network domains');
  });

  it('shows no network when no domains', () => {
    const prompt = buildMotorSystemPrompt({
      task: 'Test task',
      tools: ['bash'],
      syntheticTools: [],
    });

    expect(prompt).toContain('Network access is disabled');
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
