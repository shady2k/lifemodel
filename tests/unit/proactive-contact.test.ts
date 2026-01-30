/**
 * Tests for proactive contact behavior.
 *
 * Verifies that when the agent initiates contact (not responding to user),
 * the LLM receives proper context about:
 * - This being a proactive outreach, not a reply
 * - Time since last conversation
 * - Instructions to start fresh, not continue old conversation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAgenticLoop, type CognitionLLM, type LoopContext, type StructuredRequest } from '../../src/layers/cognition/agentic-loop.js';
import { createToolRegistry } from '../../src/layers/cognition/tools/registry.js';
import { createSignal } from '../../src/types/signal.js';
import { Priority } from '../../src/types/priority.js';
import { createMockLogger, createAgentState } from '../helpers/factories.js';

describe('Proactive Contact', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let capturedRequests: StructuredRequest[];
  let mockLLM: CognitionLLM;

  beforeEach(() => {
    logger = createMockLogger();
    capturedRequests = [];

    // Mock LLM that captures requests and returns valid response
    mockLLM = {
      complete: vi.fn().mockImplementation(async (request: StructuredRequest) => {
        capturedRequests.push(request);
        // Return a valid "noAction" response to end the loop
        return JSON.stringify({
          steps: [
            { type: 'think', id: 't1', parentId: null, content: 'Deciding what to do' },
          ],
          terminal: { type: 'noAction', reason: 'Testing', parentId: 't1' },
        });
      }),
    };
  });

  /**
   * Create a proactive contact trigger signal (threshold_crossed).
   */
  function createProactiveContactSignal(chatId: string): ReturnType<typeof createSignal> {
    return createSignal(
      'threshold_crossed',
      'meta.threshold_monitor',
      { value: 0.45, confidence: 1.0 },
      {
        priority: Priority.NORMAL,
        data: {
          kind: 'threshold',
          thresholdName: 'proactive_initiate',
          value: 0.45,
          threshold: 0.35,
          direction: 'above',
          chatId,
          channel: 'telegram',
        },
      }
    );
  }

  describe('Prompt context for proactive contact', () => {
    it('includes "Proactive Contact Trigger" section instead of raw JSON', async () => {
      const toolRegistry = createToolRegistry(logger);
      const loop = createAgenticLoop(logger, mockLLM, toolRegistry);

      const context: LoopContext = {
        triggerSignal: createProactiveContactSignal('123'),
        agentState: createAgentState(),
        conversationHistory: [
          { role: 'user', content: 'Previous message from hours ago' },
          { role: 'assistant', content: 'Previous response' },
        ],
        userModel: { name: 'Sasha', energy: 0.7, availability: 0.7 },
        correlationId: 'test-1',
        chatId: '123',
        timeSinceLastMessageMs: 2 * 60 * 60 * 1000, // 2 hours
      };

      await loop.run(context);

      expect(capturedRequests.length).toBeGreaterThan(0);
      const request = capturedRequests[0];
      const fullPrompt = request.systemPrompt + '\n\n' + request.userPrompt;

      // Should have proactive contact section
      expect(fullPrompt).toContain('## Proactive Contact Trigger');
      expect(fullPrompt).toContain('This is NOT a response to a user message');
      expect(fullPrompt).toContain('You are INITIATING contact');
    });

    it('includes time since last message in prompt', async () => {
      const toolRegistry = createToolRegistry(logger);
      const loop = createAgenticLoop(logger, mockLLM, toolRegistry);

      const context: LoopContext = {
        triggerSignal: createProactiveContactSignal('123'),
        agentState: createAgentState(),
        conversationHistory: [],
        userModel: { name: 'Sasha' },
        correlationId: 'test-2',
        chatId: '123',
        timeSinceLastMessageMs: 3 * 60 * 60 * 1000, // 3 hours
      };

      await loop.run(context);

      const request = capturedRequests[0];
      const fullPrompt = request.systemPrompt + '\n\n' + request.userPrompt;
      expect(fullPrompt).toContain('Time since last conversation: 3 hour');
    });

    it('includes instructions to start fresh conversation', async () => {
      const toolRegistry = createToolRegistry(logger);
      const loop = createAgenticLoop(logger, mockLLM, toolRegistry);

      const context: LoopContext = {
        triggerSignal: createProactiveContactSignal('123'),
        agentState: createAgentState(),
        conversationHistory: [
          { role: 'user', content: 'Old topic discussion' },
        ],
        userModel: {},
        correlationId: 'test-3',
        chatId: '123',
        timeSinceLastMessageMs: 60 * 60 * 1000, // 1 hour
      };

      await loop.run(context);

      const request = capturedRequests[0];
      const fullPrompt = request.systemPrompt + '\n\n' + request.userPrompt;
      expect(fullPrompt).toContain('Do NOT continue or reference the previous conversation');
      expect(fullPrompt).toContain('Start FRESH');
    });

    it('shows minutes when time is less than 1 hour', async () => {
      const toolRegistry = createToolRegistry(logger);
      const loop = createAgenticLoop(logger, mockLLM, toolRegistry);

      const context: LoopContext = {
        triggerSignal: createProactiveContactSignal('123'),
        agentState: createAgentState(),
        conversationHistory: [],
        userModel: {},
        correlationId: 'test-4',
        chatId: '123',
        timeSinceLastMessageMs: 45 * 60 * 1000, // 45 minutes
      };

      await loop.run(context);

      const request = capturedRequests[0];
      const fullPrompt = request.systemPrompt + '\n\n' + request.userPrompt;
      expect(fullPrompt).toContain('45 minute');
    });

    it('identifies follow-up trigger type', async () => {
      const toolRegistry = createToolRegistry(logger);
      const loop = createAgenticLoop(logger, mockLLM, toolRegistry);

      // Create follow-up signal (user didn't respond)
      const followUpSignal = createSignal(
        'threshold_crossed',
        'meta.threshold_monitor',
        { value: 1.0, confidence: 1.0 },
        {
          priority: Priority.NORMAL,
          data: {
            kind: 'threshold',
            thresholdName: 'proactive_follow_up',
            value: 1.0,
            threshold: 0,
            direction: 'above',
            chatId: '123',
            channel: 'telegram',
          },
        }
      );

      const context: LoopContext = {
        triggerSignal: followUpSignal,
        agentState: createAgentState(),
        conversationHistory: [],
        userModel: {},
        correlationId: 'test-5',
        chatId: '123',
        timeSinceLastMessageMs: 10 * 60 * 1000,
      };

      await loop.run(context);

      const request = capturedRequests[0];
      const fullPrompt = request.systemPrompt + '\n\n' + request.userPrompt;
      expect(fullPrompt).toContain('Follow-up');
      expect(fullPrompt).toContain('user did not respond');
    });
  });

  describe('User message triggers (not proactive)', () => {
    it('does NOT show proactive contact section for user messages', async () => {
      const toolRegistry = createToolRegistry(logger);
      const loop = createAgenticLoop(logger, mockLLM, toolRegistry);

      // Create a user message signal (NOT proactive)
      const userMessageSignal = createSignal(
        'user_message',
        'sense.telegram',
        { value: 1, confidence: 1 },
        {
          priority: Priority.HIGH,
          data: {
            kind: 'user_message',
            text: 'Hello!',
            chatId: '123',
            userId: '456',
          },
        }
      );

      const context: LoopContext = {
        triggerSignal: userMessageSignal,
        agentState: createAgentState(),
        conversationHistory: [],
        userModel: { name: 'Sasha' },
        correlationId: 'test-6',
        chatId: '123',
      };

      await loop.run(context);

      const request = capturedRequests[0];
      const fullPrompt = request.systemPrompt + '\n\n' + request.userPrompt;
      // Should have user input section, NOT proactive contact
      expect(fullPrompt).toContain('## Current Input');
      expect(fullPrompt).toContain('User message: "Hello!"');
      expect(fullPrompt).not.toContain('## Proactive Contact Trigger');
    });
  });
});
