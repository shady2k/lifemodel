/**
 * Tests for provider error handling in AgenticLoop.
 *
 * Covers:
 * 1. Provider error → retry → persists → escalates to smart model → succeeds
 * 2. Provider error → retry → persists → smart also fails → forceRespond exhausted → error message sent
 * 3. Provider error on proactive trigger → noAction (unchanged behavior)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAgenticLoop } from '../../../../src/layers/cognition/agentic-loop.js';
import type {
  LoopContext,
  CognitionLLM,
  ToolCompletionResponse,
} from '../../../../src/layers/cognition/agentic-loop.js';
import type { ToolRegistry } from '../../../../src/layers/cognition/tools/registry.js';
import type { Signal } from '../../../../src/types/signal.js';

// Mock logger
const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => mockLogger,
};

function createTestSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'test-signal-1',
    type: 'user_message',
    source: 'test',
    timestamp: new Date(),
    priority: 50,
    data: { text: 'Hello' },
    ...overrides,
  };
}

function createTestContext(overrides: Partial<LoopContext> = {}): LoopContext {
  return {
    triggerSignal: createTestSignal(),
    agentState: {
      energy: 0.8,
      socialDebt: 0.3,
      taskPressure: 0.2,
      curiosity: 0.5,
      acquaintancePressure: 0.1,
    },
    conversationHistory: [],
    userModel: {},
    tickId: 'tick-123',
    recipientId: 'recipient-123',
    userId: 'user-123',
    ...overrides,
  };
}

function createEmptyToolRegistry(): ToolRegistry {
  return {
    getTools: () => [],
    getToolsAsOpenAIFormat: () => [],
    hasToolSideEffects: () => false,
    getMaxCallsPerTurn: () => undefined,
    execute: vi.fn(),
  } as unknown as ToolRegistry;
}

/** Create an LLM mock that returns provider errors N times, then succeeds */
function createMockLlm(
  errorCount: number,
  successResponse: ToolCompletionResponse = {
    content: '{"response":"Hello!","status":"active","confidence":0.9}',
    toolCalls: [],
    finishReason: 'stop',
  }
): CognitionLLM & { callCount: number } {
  let callCount = 0;
  const llm = {
    get callCount() {
      return callCount;
    },
    complete: vi.fn().mockResolvedValue('summary'),
    completeWithTools: vi.fn().mockImplementation(async (): Promise<ToolCompletionResponse> => {
      callCount++;
      if (callCount <= errorCount) {
        return {
          content: null,
          toolCalls: [],
          finishReason: 'error',
        };
      }
      return successResponse;
    }),
  };
  return llm as CognitionLLM & { callCount: number };
}

describe('Provider Error Escalation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retries once on fast model, then escalates to smart model on persistent error', async () => {
    // 2 errors on fast model, then success on smart model (3rd call)
    const mockLlm = createMockLlm(2);
    const loop = createAgenticLoop(mockLogger as any, mockLlm, createEmptyToolRegistry());

    const result = await loop.run(createTestContext());

    expect(result.success).toBe(true);
    expect(result.terminal.type).toBe('respond');
    if (result.terminal.type === 'respond') {
      expect(result.terminal.text).toBe('Hello!');
    }
    // Should have been called 3 times: error, error, then success on smart
    expect(mockLlm.callCount).toBe(3);

    // Verify escalation was logged
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ iteration: expect.any(Number) }),
      'Provider error persists — escalating to smart model'
    );
  });

  it('allows one retry on smart model after escalation', async () => {
    // 3 errors (2 fast + 1 smart retry), then success on smart (4th call)
    const mockLlm = createMockLlm(3);
    const loop = createAgenticLoop(mockLogger as any, mockLlm, createEmptyToolRegistry());

    const result = await loop.run(createTestContext());

    expect(result.success).toBe(true);
    expect(result.terminal.type).toBe('respond');
    // 4 calls: fast error, fast error (escalate), smart error, smart success
    expect(mockLlm.callCount).toBe(4);
  });

  it('sends error message to user when all retries exhausted on user_message', async () => {
    // Enough errors to exhaust all retries + forceRespond attempts
    // Flow: fast error x2 → escalate → smart error x2 → fall through to handleNaturalCompletion
    // handleNaturalCompletion with null content → forceRespond → 3 more errors → error message
    const mockLlm = createMockLlm(100); // Always error
    const loop = createAgenticLoop(
      mockLogger as any,
      mockLlm,
      createEmptyToolRegistry(),
      { maxIterations: 20, timeoutMs: 30000, maxToolCalls: 20, abortOnNewMessage: false, maxInputTokens: 10000, maxOutputTokens: 5000 }
    );

    const result = await loop.run(createTestContext());

    expect(result.success).toBe(true);
    expect(result.terminal.type).toBe('respond');
    if (result.terminal.type === 'respond') {
      expect(result.terminal.text).toContain('техническая ошибка');
      expect(result.terminal.confidence).toBe(0.3);
    }
  });

  it('returns noAction for proactive trigger when all retries exhausted', async () => {
    const mockLlm = createMockLlm(100); // Always error
    const loop = createAgenticLoop(
      mockLogger as any,
      mockLlm,
      createEmptyToolRegistry(),
      { maxIterations: 20, timeoutMs: 30000, maxToolCalls: 20, abortOnNewMessage: false, maxInputTokens: 10000, maxOutputTokens: 5000 }
    );

    const context = createTestContext({
      triggerSignal: createTestSignal({ type: 'contact_urge' }),
      recipientId: undefined,
    });

    const result = await loop.run(context);

    expect(result.success).toBe(true);
    expect(result.terminal.type).toBe('noAction');
  });

  it('does not escalate if already using smart model', async () => {
    // If previousAttempt is set, useSmart starts as true
    // 2 errors on smart → fall through (no second escalation since already smart)
    const mockLlm = createMockLlm(100); // Always error
    const loop = createAgenticLoop(
      mockLogger as any,
      mockLlm,
      createEmptyToolRegistry(),
      { maxIterations: 20, timeoutMs: 30000, maxToolCalls: 20, abortOnNewMessage: false, maxInputTokens: 10000, maxOutputTokens: 5000 }
    );

    const context = createTestContext({
      previousAttempt: {
        toolResults: [],
        executedTools: [],
        reason: 'test retry',
      },
    });

    const result = await loop.run(context);

    expect(result.success).toBe(true);
    // Should NOT log the escalation message (was already smart)
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'Provider error persists — escalating to smart model'
    );
    // Should log the post-smart-escalation error
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ iteration: expect.any(Number) }),
      'Provider error persists after smart escalation'
    );
  });
});
