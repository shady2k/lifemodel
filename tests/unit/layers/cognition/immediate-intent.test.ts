/**
 * Tests for immediate REMEMBER intent processing in AgenticLoop.
 *
 * Feature: When core.remember or core.setInterest tool succeeds during agentic loop execution,
 * the intent should be applied immediately via onImmediateIntent callback, and the result
 * should be marked immediatelyApplied = true to skip duplicate processing in final compilation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgenticLoop, createAgenticLoop } from '../../../../src/layers/cognition/agentic-loop.js';
import type {
  LoopContext,
  CognitionLLM,
  ToolCompletionResponse,
  LoopCallbacks,
} from '../../../../src/layers/cognition/agentic-loop.js';
import type { ToolRegistry } from '../../../../src/layers/cognition/tools/registry.js';
import type { ToolResult } from '../../../../src/types/cognition.js';
import type { Intent } from '../../../../src/types/intent.js';
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

function createTestLogger() {
  return mockLogger as any;
}

// Helper to create a minimal Signal
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

// Helper to create a minimal LoopContext
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

// Mock tool that always succeeds
function createMockTool(name: string, hasSideEffects: boolean, resultData: Record<string, unknown>) {
  return {
    name,
    description: `Mock ${name} tool`,
    parameters: {},
    hasSideEffects,
    validate: () => ({ success: true }),
    execute: vi.fn().mockResolvedValue({
      success: true,
      data: resultData,
    }),
  };
}

describe('Immediate Intent Processing', () => {
  let mockLlm: CognitionLLM;
  let mockToolRegistry: ToolRegistry;
  let immediateIntentCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    immediateIntentCallback = vi.fn();
  });

  /**
   * Creates a mock LLM that responds with specific tool calls, then naturally terminates.
   * This uses the new Codex-style termination (no core.final).
   */
  function createMockLlm(toolSequence: { name: string; args: Record<string, unknown> }[], finalResponse = 'Done') {
    let callIndex = 0;

    return {
      complete: vi.fn().mockResolvedValue('summary'),
      completeWithTools: vi.fn().mockImplementation(async (): Promise<ToolCompletionResponse> => {
        if (callIndex < toolSequence.length) {
          const tool = toolSequence[callIndex];
          callIndex++;
          return {
            content: null,
            toolCalls: [
              {
                id: `call-${callIndex}`,
                type: 'function',
                function: {
                  name: tool.name.replace(/\./g, '_'),
                  arguments: JSON.stringify(tool.args),
                },
              },
            ],
            finishReason: 'tool_calls',
          };
        }

        // Natural completion - no tool calls, just text
        return {
          content: finalResponse,
          toolCalls: [],
          finishReason: 'stop',
        };
      }),
    } as CognitionLLM;
  }

  function createMockToolRegistry(tools: ReturnType<typeof createMockTool>[]) {
    const toolMap = new Map(tools.map((t) => [t.name, t]));

    return {
      getTools: () => tools,
      getToolsAsOpenAIFormat: () =>
        tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name.replace(/\./g, '_'),
            description: t.description,
            parameters: { type: 'object', properties: {}, required: [] },
          },
        })),
      hasToolSideEffects: (name: string) => toolMap.get(name)?.hasSideEffects ?? false,
      execute: vi.fn().mockImplementation(async (request: { name: string; toolCallId: string }) => {
        const tool = toolMap.get(request.name);
        if (!tool) {
          return {
            toolCallId: request.toolCallId,
            toolName: request.name,
            resultId: `${request.toolCallId}-result`,
            success: false,
            error: 'Tool not found',
          };
        }
        const result = await tool.execute(request);
        return {
          toolCallId: request.toolCallId,
          toolName: request.name,
          resultId: `${request.toolCallId}-result`,
          ...result,
        } as ToolResult;
      }),
    } as unknown as ToolRegistry;
  }

  describe('core.remember triggers immediate callback', () => {
    it('calls onImmediateIntent when core.remember succeeds', async () => {
      const rememberTool = createMockTool('core.remember', true, {
        action: 'remember',
        subject: 'user',
        attribute: 'birthday',
        value: 'January 15',
        confidence: 0.95,
        source: 'user_explicit',
        isUserFact: true,
      });

      mockLlm = createMockLlm([{ name: 'core.remember', args: { subject: 'user' } }]);
      mockToolRegistry = createMockToolRegistry([rememberTool]);

      const callbacks: LoopCallbacks = {
        onImmediateIntent: immediateIntentCallback,
      };

      const loop = createAgenticLoop(createTestLogger(), mockLlm, mockToolRegistry, {}, callbacks);

      await loop.run(createTestContext());

      expect(immediateIntentCallback).toHaveBeenCalledTimes(1);
      expect(immediateIntentCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'REMEMBER',
          payload: expect.objectContaining({
            subject: 'user',
            attribute: 'birthday',
            value: 'January 15',
          }),
        })
      );
    });
  });

  describe('core.setInterest triggers immediate callback', () => {
    it('calls onImmediateIntent when core.setInterest succeeds', async () => {
      const setInterestTool = createMockTool('core.setInterest', true, {
        action: 'setInterest',
        topic: 'crypto',
        intensity: 'strong_positive',
        urgent: true,
        source: 'user_explicit',
      });

      mockLlm = createMockLlm([{ name: 'core.setInterest', args: { topic: 'crypto' } }]);
      mockToolRegistry = createMockToolRegistry([setInterestTool]);

      const callbacks: LoopCallbacks = {
        onImmediateIntent: immediateIntentCallback,
      };

      const loop = createAgenticLoop(createTestLogger(), mockLlm, mockToolRegistry, {}, callbacks);

      await loop.run(createTestContext());

      expect(immediateIntentCallback).toHaveBeenCalledTimes(1);
      expect(immediateIntentCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'SET_INTEREST',
          payload: expect.objectContaining({
            topic: 'crypto',
            intensity: 'strong_positive',
            urgent: true,
          }),
        })
      );
    });
  });

  describe('other tools do NOT trigger immediate callback', () => {
    it('does NOT call onImmediateIntent for core.memory tool', async () => {
      const memoryTool = createMockTool('core.memory', false, {
        action: 'search',
        results: [],
      });

      mockLlm = createMockLlm([{ name: 'core.memory', args: { action: 'search', query: 'test' } }]);
      mockToolRegistry = createMockToolRegistry([memoryTool]);

      const callbacks: LoopCallbacks = {
        onImmediateIntent: immediateIntentCallback,
      };

      const loop = createAgenticLoop(createTestLogger(), mockLlm, mockToolRegistry, {}, callbacks);

      await loop.run(createTestContext());

      expect(immediateIntentCallback).not.toHaveBeenCalled();
    });

    it('does NOT call onImmediateIntent for core.state tool', async () => {
      const stateTool = createMockTool('core.state', false, {
        action: 'get',
        state: { energy: 0.8 },
      });

      mockLlm = createMockLlm([{ name: 'core.state', args: { action: 'get' } }]);
      mockToolRegistry = createMockToolRegistry([stateTool]);

      const callbacks: LoopCallbacks = {
        onImmediateIntent: immediateIntentCallback,
      };

      const loop = createAgenticLoop(createTestLogger(), mockLlm, mockToolRegistry, {}, callbacks);

      await loop.run(createTestContext());

      expect(immediateIntentCallback).not.toHaveBeenCalled();
    });
  });

  describe('failed tools do NOT trigger callback', () => {
    it('does NOT call onImmediateIntent when core.remember fails', async () => {
      // Create a failing tool
      const failingRememberTool = {
        name: 'core.remember',
        description: 'Mock failing tool',
        parameters: {},
        hasSideEffects: true,
        validate: () => ({ success: true }),
        execute: vi.fn().mockResolvedValue({
          success: false,
          error: 'Database error',
        }),
      };

      mockLlm = createMockLlm([{ name: 'core.remember', args: { subject: 'user' } }]);
      mockToolRegistry = createMockToolRegistry([failingRememberTool]);

      const callbacks: LoopCallbacks = {
        onImmediateIntent: immediateIntentCallback,
      };

      const loop = createAgenticLoop(createTestLogger(), mockLlm, mockToolRegistry, {}, callbacks);

      await loop.run(createTestContext());

      expect(immediateIntentCallback).not.toHaveBeenCalled();
    });
  });

  describe('immediatelyApplied results are skipped in compileIntentsFromToolResults', () => {
    it('does NOT include REMEMBER intent in final intents when immediatelyApplied', async () => {
      const rememberTool = createMockTool('core.remember', true, {
        action: 'remember',
        subject: 'user',
        attribute: 'name',
        value: 'Alice',
        confidence: 0.95,
        source: 'user_explicit',
        isUserFact: true,
      });

      mockLlm = createMockLlm([{ name: 'core.remember', args: {} }]);
      mockToolRegistry = createMockToolRegistry([rememberTool]);

      const callbacks: LoopCallbacks = {
        onImmediateIntent: immediateIntentCallback,
      };

      const loop = createAgenticLoop(createTestLogger(), mockLlm, mockToolRegistry, {}, callbacks);

      const result = await loop.run(createTestContext());

      // The callback was called (immediate processing)
      expect(immediateIntentCallback).toHaveBeenCalledTimes(1);

      // But the final intents should NOT contain REMEMBER (it was already applied)
      const rememberIntents = result.intents.filter((i: Intent) => i.type === 'REMEMBER');
      expect(rememberIntents).toHaveLength(0);

      // Should still have SEND_MESSAGE intent from core.final
      const sendIntents = result.intents.filter((i: Intent) => i.type === 'SEND_MESSAGE');
      expect(sendIntents).toHaveLength(1);
    });

    it('does NOT include SET_INTEREST intent in final intents when immediatelyApplied', async () => {
      const setInterestTool = createMockTool('core.setInterest', true, {
        action: 'setInterest',
        topic: 'weather',
        intensity: 'weak_positive',
        urgent: false,
        source: 'user_implicit',
      });

      mockLlm = createMockLlm([{ name: 'core.setInterest', args: {} }]);
      mockToolRegistry = createMockToolRegistry([setInterestTool]);

      const callbacks: LoopCallbacks = {
        onImmediateIntent: immediateIntentCallback,
      };

      const loop = createAgenticLoop(createTestLogger(), mockLlm, mockToolRegistry, {}, callbacks);

      const result = await loop.run(createTestContext());

      // The callback was called (immediate processing)
      expect(immediateIntentCallback).toHaveBeenCalledTimes(1);

      // But the final intents should NOT contain SET_INTEREST (it was already applied)
      const setInterestIntents = result.intents.filter((i: Intent) => i.type === 'SET_INTEREST');
      expect(setInterestIntents).toHaveLength(0);
    });
  });

  describe('multiple immediate tools in same loop', () => {
    it('calls onImmediateIntent for each core.remember and core.setInterest', async () => {
      const rememberTool = createMockTool('core.remember', true, {
        action: 'remember',
        subject: 'user',
        attribute: 'favorite_color',
        value: 'blue',
        confidence: 0.9,
        source: 'user_explicit',
        isUserFact: true,
      });

      const setInterestTool = createMockTool('core.setInterest', true, {
        action: 'setInterest',
        topic: 'sports',
        intensity: 'strong_positive',
        urgent: false,
        source: 'user_explicit',
      });

      mockLlm = createMockLlm([
        { name: 'core.remember', args: {} },
        { name: 'core.setInterest', args: {} },
      ]);
      mockToolRegistry = createMockToolRegistry([rememberTool, setInterestTool]);

      const callbacks: LoopCallbacks = {
        onImmediateIntent: immediateIntentCallback,
      };

      const loop = createAgenticLoop(createTestLogger(), mockLlm, mockToolRegistry, {}, callbacks);

      const result = await loop.run(createTestContext());

      // Both should trigger immediate callback
      expect(immediateIntentCallback).toHaveBeenCalledTimes(2);

      // First call should be REMEMBER
      expect(immediateIntentCallback).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          type: 'REMEMBER',
        })
      );

      // Second call should be SET_INTEREST
      expect(immediateIntentCallback).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          type: 'SET_INTEREST',
        })
      );

      // Neither should be in final intents (both were immediatelyApplied)
      const rememberIntents = result.intents.filter((i: Intent) => i.type === 'REMEMBER');
      const setInterestIntents = result.intents.filter((i: Intent) => i.type === 'SET_INTEREST');
      expect(rememberIntents).toHaveLength(0);
      expect(setInterestIntents).toHaveLength(0);
    });
  });

  describe('no callback provided', () => {
    it('works normally without onImmediateIntent callback', async () => {
      const rememberTool = createMockTool('core.remember', true, {
        action: 'remember',
        subject: 'user',
        attribute: 'city',
        value: 'Moscow',
        confidence: 0.85,
        source: 'user_explicit',
        isUserFact: true,
      });

      mockLlm = createMockLlm([{ name: 'core.remember', args: {} }]);
      mockToolRegistry = createMockToolRegistry([rememberTool]);

      // No callbacks provided
      const loop = createAgenticLoop(createTestLogger(), mockLlm, mockToolRegistry);

      const result = await loop.run(createTestContext());

      // Loop should complete successfully
      expect(result.success).toBe(true);

      // REMEMBER intent should be in final intents (not marked as immediatelyApplied)
      const rememberIntents = result.intents.filter((i: Intent) => i.type === 'REMEMBER');
      expect(rememberIntents).toHaveLength(1);
    });
  });

  describe('intent trace metadata', () => {
    it('includes trace metadata on immediate intents', async () => {
      const rememberTool = createMockTool('core.remember', true, {
        action: 'remember',
        subject: 'user',
        attribute: 'pet',
        value: 'cat',
        confidence: 0.9,
        source: 'user_explicit',
        isUserFact: true,
      });

      mockLlm = createMockLlm([{ name: 'core.remember', args: {} }]);
      mockToolRegistry = createMockToolRegistry([rememberTool]);

      const callbacks: LoopCallbacks = {
        onImmediateIntent: immediateIntentCallback,
      };

      const context = createTestContext({
        tickId: 'tick-abc-123',
        triggerSignal: createTestSignal({ id: 'signal-xyz-789' }),
      });

      const loop = createAgenticLoop(createTestLogger(), mockLlm, mockToolRegistry, {}, callbacks);

      await loop.run(context);

      expect(immediateIntentCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          trace: expect.objectContaining({
            tickId: 'tick-abc-123',
            parentSignalId: 'signal-xyz-789',
            toolCallId: expect.any(String),
          }),
        })
      );
    });
  });
});
