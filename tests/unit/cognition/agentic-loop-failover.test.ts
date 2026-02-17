/**
 * Agentic Loop — Hard Provider Error Failover Tests
 *
 * Verifies that when the fast model throws a retryable LLMError (HTTP 500, timeout),
 * the loop escalates to the smart model instead of propagating the error.
 */

import { describe, it, expect, vi } from 'vitest';
import { AgenticLoop } from '../../../src/layers/cognition/agentic-loop.js';
import type {
  LoopContext,
  CognitionLLM,
  ToolCompletionResponse,
} from '../../../src/layers/cognition/agentic-loop-types.js';
import { LLMError } from '../../../src/llm/provider.js';
import type { Signal } from '../../../src/types/signal.js';
import type { ToolRegistry } from '../../../src/layers/cognition/tools/registry.js';

function makeLogger() {
  const noop = vi.fn();
  const logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

function makeContext(overrides?: Partial<LoopContext>): LoopContext {
  return {
    tickId: 'test-tick',
    triggerSignal: {
      type: 'user_message',
      source: 'test',
      value: 1,
    } as Signal,
    agentState: {
      energy: 1,
      socialDebt: 0,
      taskPressure: 0,
      curiosity: 0,
      acquaintancePressure: 0,
    },
    conversationHistory: [],
    userModel: {},
    memoryFacts: [],
    activeInterests: [],
    userTimeContext: { localTime: new Date(), timezone: 'UTC', isWeekend: false },
    pressure: { urgency: 0, socialDebt: 0, lastContactHours: 0 },
    drainPendingUserMessages: undefined,
    ...overrides,
  } as LoopContext;
}

function makeToolRegistry(): ToolRegistry {
  return {
    getToolsAsOpenAIFormat: () => [],
    getMaxCallsPerTurn: () => undefined,
  } as unknown as ToolRegistry;
}

function makeSuccessResponse(text = 'OK'): ToolCompletionResponse {
  return {
    content: JSON.stringify({ response: text }),
    toolCalls: [],
    finishReason: 'stop',
  };
}

describe('AgenticLoop hard provider error failover', () => {
  it('escalates to smart model when fast model throws retryable LLMError', async () => {
    const llm: CognitionLLM = {
      complete: vi.fn(),
      completeWithTools: vi.fn()
        // First call: fast model throws retryable 500
        .mockRejectedValueOnce(
          new LLMError('Server error: Internal Server Error', 'openrouter', {
            statusCode: 500,
            retryable: true,
          })
        )
        // Second call: smart model succeeds
        .mockResolvedValueOnce(makeSuccessResponse('Reminder marked done')),
    };

    const loop = new AgenticLoop(makeLogger(), llm, makeToolRegistry());
    const result = await loop.run(makeContext());

    // Should have called LLM twice
    expect(llm.completeWithTools).toHaveBeenCalledTimes(2);

    // First call with useSmart: false
    const firstCall = vi.mocked(llm.completeWithTools).mock.calls[0];
    expect(firstCall[1]?.useSmart).toBe(false);

    // Second call with useSmart: true
    const secondCall = vi.mocked(llm.completeWithTools).mock.calls[1];
    expect(secondCall[1]?.useSmart).toBe(true);

    // Loop should succeed
    expect(result.success).toBe(true);
  });

  it('re-throws when already on smart model', async () => {
    const error = new LLMError('Server error', 'openrouter', {
      statusCode: 500,
      retryable: true,
    });

    const llm: CognitionLLM = {
      complete: vi.fn(),
      completeWithTools: vi.fn().mockRejectedValue(error),
    };

    // previousAttempt triggers useSmart = true from the start
    const context = makeContext({
      previousAttempt: {
        toolResults: [],
        executedTools: [],
        reason: 'test retry',
      },
    });

    const loop = new AgenticLoop(makeLogger(), llm, makeToolRegistry());
    await expect(loop.run(context)).rejects.toThrow('Server error');

    // Should only try once (no fallback available)
    expect(llm.completeWithTools).toHaveBeenCalledTimes(1);
  });

  it('re-throws non-retryable errors without escalation', async () => {
    const error = new LLMError('Invalid API key', 'openrouter', {
      statusCode: 401,
      retryable: false,
    });

    const llm: CognitionLLM = {
      complete: vi.fn(),
      completeWithTools: vi.fn().mockRejectedValue(error),
    };

    const loop = new AgenticLoop(makeLogger(), llm, makeToolRegistry());
    await expect(loop.run(makeContext())).rejects.toThrow('Invalid API key');

    // Should only try once (not retryable)
    expect(llm.completeWithTools).toHaveBeenCalledTimes(1);
  });

  it('re-throws non-LLMError exceptions without escalation', async () => {
    const llm: CognitionLLM = {
      complete: vi.fn(),
      completeWithTools: vi.fn().mockRejectedValue(new Error('Network socket hang up')),
    };

    const loop = new AgenticLoop(makeLogger(), llm, makeToolRegistry());
    await expect(loop.run(makeContext())).rejects.toThrow('Network socket hang up');

    expect(llm.completeWithTools).toHaveBeenCalledTimes(1);
  });
});
