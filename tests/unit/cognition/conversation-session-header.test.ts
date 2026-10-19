/**
 * The session the core names to the model gateway (ADR-013, the custom-headers
 * amendment): every request of a turn carries the conversation id in
 * `x-lifemodel-session`, and the gateway fills a slot's `{session}` from it.
 */
import { describe, expect, it, vi } from 'vitest';
import { AgenticLoop } from '../../../src/layers/cognition/agentic-loop.js';
import { buildRequest } from '../../../src/layers/cognition/loop-orchestrator.js';
import { createLLMAdapter } from '../../../src/layers/cognition/llm-adapter.js';
import type {
  CognitionLLM,
  LoopContext,
  ToolCompletionResponse,
} from '../../../src/layers/cognition/agentic-loop-types.js';
import type {
  CompletionRequest,
  CompletionResponse,
  LLMProvider,
} from '../../../src/llm/provider.js';
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
    triggerSignal: { type: 'user_message', source: 'test', value: 1 } as Signal,
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

function success(text = 'OK'): ToolCompletionResponse {
  return { content: JSON.stringify({ response: text }), toolCalls: [], finishReason: 'stop' };
}

describe('the conversation a model request names', () => {
  it('carries the turn conversation id as the request session', () => {
    const request = buildRequest([], [], false, 'rcpt_ab12cd34');
    expect(request.sessionId).toBe('rcpt_ab12cd34');
    expect(buildRequest([], [], false, undefined).sessionId).toBeUndefined();
  });

  it('names the turn conversation on every request the loop makes', async () => {
    const llm: CognitionLLM = {
      complete: vi.fn(),
      completeWithTools: vi.fn().mockResolvedValue(success()),
    };
    const loop = new AgenticLoop(makeLogger(), llm, makeToolRegistry());
    await loop.run(makeContext({ recipientId: 'rcpt_ab12cd34' }));
    expect(llm.completeWithTools).toHaveBeenCalledTimes(1);
    expect(vi.mocked(llm.completeWithTools).mock.calls[0]?.[0].sessionId).toBe('rcpt_ab12cd34');
  });

  it('hands the request session to the provider and leaves a request without one alone', async () => {
    const seen: CompletionRequest[] = [];
    const provider: LLMProvider = {
      name: 'capture',
      isAvailable: () => true,
      complete: (request: CompletionRequest): Promise<CompletionResponse> => {
        seen.push(request);
        return Promise.resolve({ content: 'OK', model: 'm' });
      },
    };
    const adapter = createLLMAdapter(provider, makeLogger(), { role: 'fast' });
    await adapter.completeWithTools(
      { messages: [], tools: [], sessionId: 'rcpt_ab12cd34' },
      { maxTokens: 16 }
    );
    await adapter.completeWithTools({ messages: [], tools: [] }, { maxTokens: 16 });
    expect(seen[0]?.sessionId).toBe('rcpt_ab12cd34');
    expect(seen[1]?.sessionId).toBeUndefined();
  });
});
