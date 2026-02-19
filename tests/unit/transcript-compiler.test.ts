import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/llm/provider.js';
import {
  compileTranscript,
  resolveTranscriptPolicy,
  STRICT_POLICY,
  OPENROUTER_POLICY,
  GEMINI_POLICY,
} from '../../src/plugins/providers/transcript-compiler.js';
import type { VercelAIProviderConfig } from '../../src/plugins/providers/vercel-ai-provider.js';

// Helper to create messages
const sys = (content: string): Message => ({ role: 'system', content });
const user = (content: string): Message => ({ role: 'user', content });
const assistant = (content: string | null): Message => ({ role: 'assistant', content });
const assistantWithTools = (content: string | null, toolCalls: Message['tool_calls']): Message => ({
  role: 'assistant',
  content,
  tool_calls: toolCalls,
});
const toolResult = (toolCallId: string, content: string): Message => ({
  role: 'tool',
  content,
  tool_call_id: toolCallId,
});

describe('transcript-compiler', () => {
  describe('STRICT_POLICY', () => {
    it('merges consecutive system messages into one', () => {
      const messages: Message[] = [
        sys('System message 1'),
        sys('System message 2'),
        sys('System message 3'),
        user('Hello'),
      ];

      const result = compileTranscript(messages, STRICT_POLICY);

      // First 3 system messages should become 1
      expect(result).toHaveLength(2);
      expect(result[0]?.role).toBe('system');
      expect(result[0]?.content).toBe('System message 1\n\nSystem message 2\n\nSystem message 3');
      expect(result[1]).toEqual(user('Hello'));
    });

    it('merges consecutive assistant text messages with \\n\\n', () => {
      const messages: Message[] = [
        user('Hello'),
        assistant('First response'),
        assistant('Second response'),
        assistant('Third response'),
      ];

      const result = compileTranscript(messages, STRICT_POLICY);

      expect(result).toHaveLength(2);
      expect(result[1]?.role).toBe('assistant');
      expect(result[1]?.content).toBe('First response\n\nSecond response\n\nThird response');
    });

    it('merges consecutive user messages', () => {
      const messages: Message[] = [
        user('Message 1'),
        user('Message 2'),
        user('Message 3'),
      ];

      const result = compileTranscript(messages, STRICT_POLICY);

      expect(result).toHaveLength(1);
      expect(result[0]?.role).toBe('user');
      expect(result[0]?.content).toBe('Message 1\n\nMessage 2\n\nMessage 3');
    });

    it('does NOT merge assistant with tool_calls adjacent to assistant text', () => {
      const messages: Message[] = [
        user('Hello'),
        assistant('Text before'),
        assistantWithTools(null, [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }]),
      ];

      const result = compileTranscript(messages, STRICT_POLICY);

      // Should have 3 messages: user, assistant text, assistant with tools
      expect(result).toHaveLength(3);
      expect(result[1]?.content).toBe('Text before');
      expect(result[2]?.tool_calls).toBeDefined();
    });

    it('does NOT merge tool result messages', () => {
      const messages: Message[] = [
        assistantWithTools(null, [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }]),
        toolResult('call_1', 'Result 1'),
        toolResult('call_1', 'Result 2'), // Note: duplicate tool_call_id for testing merge behavior
      ];

      // Fix: use unique IDs to avoid assertion failure
      const fixedMessages: Message[] = [
        assistantWithTools(null, [
          { id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } },
          { id: 'call_2', type: 'function', function: { name: 'test', arguments: '{}' } },
        ]),
        toolResult('call_1', 'Result 1'),
        toolResult('call_2', 'Result 2'),
      ];

      const result = compileTranscript(fixedMessages, STRICT_POLICY);

      // Tool results should NOT be merged (have tool_call_id)
      expect(result).toHaveLength(3);
    });

    it('merges assistant with empty tool_calls array', () => {
      const messages: Message[] = [
        user('Hello'),
        { role: 'assistant', content: 'First', tool_calls: [] },
        assistant('Second'),
      ];

      const result = compileTranscript(messages, STRICT_POLICY);

      // Empty tool_calls array should NOT block merge
      expect(result).toHaveLength(2);
      expect(result[1]?.content).toBe('First\n\nSecond');
    });

    it('does NOT merge null-content assistant (tool_calls only)', () => {
      const messages: Message[] = [
        user('Hello'),
        assistantWithTools(null, [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }]),
        assistant('Text after'),
      ];

      const result = compileTranscript(messages, STRICT_POLICY);

      // All 3 should remain separate
      expect(result).toHaveLength(3);
      expect(result[1]?.content).toBeNull();
      expect(result[2]?.content).toBe('Text after');
    });
  });

  describe('GEMINI_POLICY', () => {
    it('inserts synthetic user turn when first content is assistant', () => {
      const messages: Message[] = [
        sys('System instruction'),
        assistant('I will process this'),
      ];

      const result = compileTranscript(messages, GEMINI_POLICY);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual(sys('System instruction'));
      expect(result[1]).toEqual({ role: 'user', content: '[autonomous processing]' });
      expect(result[2]).toEqual(assistant('I will process this'));
    });

    it('does NOT insert user turn when first content is already user', () => {
      const messages: Message[] = [
        sys('System instruction'),
        user('Hello'),
        assistant('Hi there'),
      ];

      const result = compileTranscript(messages, GEMINI_POLICY);

      expect(result).toHaveLength(3);
      expect(result[1]).toEqual(user('Hello'));
    });

    it('converts mid-conversation system to [System]-prefixed user', () => {
      const messages: Message[] = [
        sys('Initial system'),
        user('Hello'),
        sys('Mid-conversation system message'),
        assistant('Response'),
      ];

      const result = compileTranscript(messages, GEMINI_POLICY);

      expect(result).toHaveLength(4);
      expect(result[0]).toEqual(sys('Initial system'));
      expect(result[2]?.role).toBe('user');
      expect(result[2]?.content).toBe('[System] Mid-conversation system message');
    });

    it('does NOT merge converted system messages (no mergeConsecutiveRoles)', () => {
      const messages: Message[] = [
        sys('System 1'),
        user('Hello'),
        sys('System 2'),
        sys('System 3'), // Both will be converted to user
      ];

      const result = compileTranscript(messages, GEMINI_POLICY);

      // Should have 4 messages (no merging)
      expect(result).toHaveLength(4);
      expect(result[2]?.content).toBe('[System] System 2');
      expect(result[3]?.content).toBe('[System] System 3');
    });
  });

  describe('OPENROUTER_POLICY', () => {
    it('merges consecutive same-role messages', () => {
      const messages: Message[] = [
        sys('System 1'),
        sys('System 2'),
        user('Hello'),
        assistant('Response 1'),
        assistant('Response 2'),
      ];

      const result = compileTranscript(messages, OPENROUTER_POLICY);

      // Consecutive assistant messages merged (AI SDK Anthropic adapter validates locally)
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual(sys('System 1\n\nSystem 2'));
      expect(result[1]).toEqual(user('Hello'));
      expect(result[2]).toEqual(assistant('Response 1\n\nResponse 2'));
    });

    it('preserves multiple leading system messages', () => {
      const messages: Message[] = [
        sys('Identity'),
        sys('Context'),
        user('Hello'),
      ];

      const result = compileTranscript(messages, OPENROUTER_POLICY);

      // maxLeadingSystemMessages is Infinity, but mergeConsecutiveRoles merges them
      expect(result).toHaveLength(2);
      expect(result[0]?.role).toBe('system');
      expect(result[1]?.role).toBe('user');
    });
  });

  describe('atomicity assertions', () => {
    it('warns but does not throw on orphan tool result (trimmed history)', () => {
      const messages: Message[] = [
        user('Hello'),
        toolResult('nonexistent_call', 'Result'),
      ];

      // Should not throw — orphan tool results are expected in trimmed histories
      const result = compileTranscript(messages, STRICT_POLICY);
      expect(result).toHaveLength(2);
    });

    it('throws on duplicate tool_call.id', () => {
      const messages: Message[] = [
        user('Hello'),
        assistantWithTools(null, [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }]),
        toolResult('call_1', 'Result'),
        assistantWithTools(null, [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }]), // Duplicate!
      ];

      expect(() => compileTranscript(messages, STRICT_POLICY)).toThrow(
        'Duplicate tool_call.id found: call_1'
      );
    });
  });

  describe('resolveTranscriptPolicy', () => {
    const openRouterConfig: VercelAIProviderConfig = {
      apiKey: 'test-key',
    };

    const localConfig: VercelAIProviderConfig = {
      baseUrl: 'http://localhost:1234',
      model: 'local-model',
    };

    it('returns STRICT_POLICY for local providers', () => {
      const policy = resolveTranscriptPolicy(localConfig, 'local-model');
      expect(policy.name).toBe('strict');
      expect(policy.mergeConsecutiveRoles).toBe(true);
    });

    it('returns GEMINI_POLICY for OpenRouter with Gemini model', () => {
      const policy = resolveTranscriptPolicy(openRouterConfig, 'google/gemini-2.0-flash');
      expect(policy.name).toBe('gemini');
      expect(policy.requireLeadingUserTurn).toBe(true);
    });

    it('returns OPENROUTER_POLICY for OpenRouter with non-Gemini model', () => {
      const policy = resolveTranscriptPolicy(openRouterConfig, 'anthropic/claude-3.5-sonnet');
      expect(policy.name).toBe('openrouter');
      expect(policy.mergeConsecutiveRoles).toBe(true);
    });
  });

  describe('real-world scenarios', () => {
    it('handles complex conversation with mixed message types (STRICT)', () => {
      // Simulating a real conversation that caused 400 errors with LM Studio
      const messages: Message[] = [
        sys('You are a helpful assistant.'),
        sys('Additional context here.'), // Will be merged
        user('First message'),
        assistant('First response'),
        assistant('Correction to first response'), // Will be merged
        assistantWithTools(null, [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"test"}' } }]),
        toolResult('call_1', '{"result": "data"}'),
        assistant('Final response'),
      ];

      const result = compileTranscript(messages, STRICT_POLICY);

      // Should have: 1 system (merged), 1 user, 1 assistant (merged text), 1 assistant (tools), 1 tool, 1 assistant
      expect(result).toHaveLength(6);

      // Verify system was merged
      expect(result[0]?.role).toBe('system');
      expect(result[0]?.content).toContain('Additional context');

      // Verify consecutive assistant text was merged
      expect(result[2]?.role).toBe('assistant');
      expect(result[2]?.content).toContain('First response');
      expect(result[2]?.content).toContain('Correction');
    });

    it('handles Gemini-specific requirements', () => {
      const messages: Message[] = [
        sys('You are a helpful AI.'),
        sys('More instructions.'), // Should NOT merge (Gemini policy)
        assistant('I need to do something'), // Should get synthetic user before
        assistantWithTools(null, [{ id: 'call_1', type: 'function', function: { name: 'act', arguments: '{}' } }]),
        toolResult('call_1', 'Done'),
        sys('New instruction mid-conversation'), // Should become [System] user
        assistant('Acknowledged'),
      ];

      const result = compileTranscript(messages, GEMINI_POLICY);

      // Should have: 2 system, 1 synthetic user, 2 assistant, 1 tool, 1 converted system, 1 assistant
      expect(result.length).toBe(8);

      // Synthetic user should be before first assistant
      const syntheticIdx = result.findIndex((m) => m.content === '[autonomous processing]');
      const firstAssistantIdx = result.findIndex((m) => m.role === 'assistant');
      expect(syntheticIdx).toBeLessThan(firstAssistantIdx);
      expect(syntheticIdx).toBe(2); // After 2 system messages

      // Mid-conversation system should be converted to user
      const convertedSystem = result.find((m) => m.content === '[System] New instruction mid-conversation');
      expect(convertedSystem).toBeDefined();
      expect(convertedSystem?.role).toBe('user');
    });
  });
});
