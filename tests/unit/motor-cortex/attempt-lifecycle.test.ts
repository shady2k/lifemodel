/**
 * Unit tests for Motor Cortex attempt lifecycle:
 * - buildFailureSummary classification
 * - getFailureHint LLM call (best-effort)
 * - Recovery context in system prompt
 */

import { describe, it, expect, vi } from 'vitest';
import { buildFailureSummary, getFailureHint } from '../../../src/runtime/motor-cortex/motor-loop.js';
import { buildMotorSystemPrompt } from '../../../src/runtime/motor-cortex/motor-prompt.js';
import type { MotorRun, MotorAttempt, StepTrace, RunTrace } from '../../../src/runtime/motor-cortex/motor-protocol.js';
import type { LLMProvider } from '../../../src/llm/provider.js';
import type { Logger } from '../../../src/types/index.js';

function makeTrace(steps: StepTrace[] = [], errors = 0): RunTrace {
  return {
    runId: 'test-run',
    task: 'Test task',
    status: 'running',
    steps,
    totalIterations: steps.length,
    totalDurationMs: 0,
    totalEnergyCost: 0,
    llmCalls: 0,
    toolCalls: 0,
    errors,
  };
}

function makeStep(toolCalls: StepTrace['toolCalls'] = []): StepTrace {
  return {
    iteration: 0,
    timestamp: new Date().toISOString(),
    llmModel: 'test-model',
    toolCalls,
  };
}

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: () => mockLogger,
  fatal: vi.fn(),
} as unknown as Logger;

describe('buildFailureSummary', () => {
  it('classifies tool_failure with error code', () => {
    const trace = makeTrace([
      makeStep([
        {
          tool: 'shell',
          args: { command: 'curl ...' },
          result: { ok: false, output: 'Connection refused', errorCode: 'timeout', retryable: true, provenance: 'web', durationMs: 5000 },
          durationMs: 5000,
        },
      ]),
    ]);

    const summary = buildFailureSummary(trace, 3, { tool: 'shell', errorCode: 'timeout' });

    expect(summary.category).toBe('tool_failure');
    expect(summary.lastErrorCode).toBe('timeout');
    expect(summary.retryable).toBe(true);
    expect(summary.suggestedAction).toBe('retry_with_guidance');
    expect(summary.lastToolResults).toHaveLength(1);
    expect(summary.lastToolResults[0]?.tool).toBe('shell');
  });

  it('classifies budget_exhausted as non-retryable', () => {
    const summary = buildFailureSummary(makeTrace(), 0, undefined, 'budget_exhausted');

    expect(summary.category).toBe('budget_exhausted');
    expect(summary.retryable).toBe(false);
    expect(summary.suggestedAction).toBe('stop');
  });

  it('classifies auth_failed as ask_user', () => {
    const summary = buildFailureSummary(makeTrace(), 3, { tool: 'shell', errorCode: 'auth_failed' });

    expect(summary.category).toBe('tool_failure');
    expect(summary.retryable).toBe(true);
    expect(summary.suggestedAction).toBe('ask_user');
  });

  it('classifies unknown when no error info', () => {
    const summary = buildFailureSummary(makeTrace(), 0);

    expect(summary.category).toBe('unknown');
    expect(summary.retryable).toBe(true);
    expect(summary.suggestedAction).toBe('retry_with_guidance');
  });

  it('collects last tool results from recent steps', () => {
    const trace = makeTrace([
      makeStep([
        {
          tool: 'code',
          args: {},
          result: { ok: true, output: 'ok', retryable: false, provenance: 'internal', durationMs: 10 },
          durationMs: 10,
        },
      ]),
      makeStep([
        {
          tool: 'shell',
          args: {},
          result: { ok: false, output: 'Connection refused', errorCode: 'timeout', retryable: true, provenance: 'web', durationMs: 5000 },
          durationMs: 5000,
        },
      ]),
    ]);

    const summary = buildFailureSummary(trace, 1, { tool: 'shell', errorCode: 'timeout' });

    expect(summary.lastToolResults).toHaveLength(2);
  });

  it('truncates tool output to 200 chars', () => {
    const longOutput = 'x'.repeat(300);
    const trace = makeTrace([
      makeStep([
        {
          tool: 'shell',
          args: {},
          result: { ok: false, output: longOutput, errorCode: 'timeout', retryable: true, provenance: 'web', durationMs: 100 },
          durationMs: 100,
        },
      ]),
    ]);

    const summary = buildFailureSummary(trace, 1, { tool: 'shell', errorCode: 'timeout' });
    expect(summary.lastToolResults[0]?.output.length).toBe(200);
  });
});

describe('getFailureHint', () => {
  it('returns hint from LLM on success', async () => {
    const mockLLM: LLMProvider = {
      complete: vi.fn().mockResolvedValue({
        content: 'The server is unreachable. Try a different port.',
        model: 'test-model',
      }),
    } as unknown as LLMProvider;

    const hint = await getFailureHint(mockLLM, [], 'curl failed 3 times', mockLogger);
    expect(hint).toBe('The server is unreachable. Try a different port.');
    expect(mockLLM.complete).toHaveBeenCalledTimes(1);
  });

  it('returns undefined on LLM error', async () => {
    const mockLLM: LLMProvider = {
      complete: vi.fn().mockRejectedValue(new Error('rate limited')),
    } as unknown as LLMProvider;

    const hint = await getFailureHint(mockLLM, [], 'curl failed', mockLogger);
    expect(hint).toBeUndefined();
  });

  it('returns undefined on empty/short response', async () => {
    const mockLLM: LLMProvider = {
      complete: vi.fn().mockResolvedValue({ content: 'ok', model: 'test' }),
    } as unknown as LLMProvider;

    const hint = await getFailureHint(mockLLM, [], 'curl failed', mockLogger);
    expect(hint).toBeUndefined();
  });
});

describe('recovery context in system prompt', () => {
  function makeRunForPrompt(): MotorRun {
    const attempt: MotorAttempt = {
      id: 'att_1',
      index: 1,
      status: 'running',
      messages: [],
      stepCursor: 0,
      maxIterations: 15,
      trace: makeTrace(),
      recoveryContext: {
        source: 'cognition',
        previousAttemptId: 'att_0',
        guidance: 'Use https://backup-api.example.com instead',
        constraints: ['only retry curl once'],
      },
      startedAt: new Date().toISOString(),
    };

    return {
      id: 'test-run',
      status: 'running',
      task: 'Fetch data from API',
      tools: ['bash'],
      attempts: [
        {
          id: 'att_0',
          index: 0,
          status: 'failed',
          messages: [],
          stepCursor: 5,
          maxIterations: 20,
          trace: makeTrace(),
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
        attempt,
      ],
      currentAttemptIndex: 1,
      maxAttempts: 3,
      startedAt: new Date().toISOString(),
      energyConsumed: 0.1,
      config: {
        syntheticTools: ['ask_user', 'save_credential', 'request_approval'],
        installDependencies: true,
        mergePolicyDomains: true,
      },
    };
  }

  it('includes recovery context in prompt for attempt 1+', () => {
    const run = makeRunForPrompt();
    const attempt = run.attempts[1]!;
    const prompt = buildMotorSystemPrompt({
      task: run.task,
      tools: run.tools,
      syntheticTools: run.config.syntheticTools,
      recoveryContext: attempt.recoveryContext,
    });

    expect(prompt).toContain('<recovery_context source="cognition">');
    expect(prompt).toContain('Use https://backup-api.example.com instead');
    expect(prompt).toContain('only retry curl once');
    expect(prompt).toContain('</recovery_context>');
  });

  it('uses attempt maxIterations (15 for retry)', () => {
    const run = makeRunForPrompt();
    const attempt = run.attempts[1]!;
    const prompt = buildMotorSystemPrompt({
      task: run.task,
      tools: run.tools,
      syntheticTools: run.config.syntheticTools,
      maxIterations: attempt.maxIterations,
    });

    expect(prompt).toContain('Maximum iterations: 15');
  });
});
