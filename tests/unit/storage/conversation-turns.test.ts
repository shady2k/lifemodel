/**
 * Tests for turn-based conversation history counting in ConversationManager.
 *
 * Features tested:
 * - countTurns(): counts user messages only (not tool messages)
 * - findTurnStartIndex(): finds correct boundary preserving tool call groups
 * - needsCompaction(): uses turn count, not message count
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ConversationManager,
  createConversationManager,
} from '../../../src/storage/conversation-manager.js';
import type { Storage } from '../../../src/storage/storage.js';

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

// In-memory storage for tests
function createMockStorage(): Storage {
  const store = new Map<string, unknown>();
  return {
    load: vi.fn(async (key: string) => store.get(key)),
    save: vi.fn(async (key: string, data: unknown) => {
      store.set(key, data);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    exists: vi.fn(async (key: string) => store.has(key)),
  } as unknown as Storage;
}

/**
 * StoredMessage interface matching internal format
 */
interface StoredMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  timestamp: string;
  tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

/**
 * Helper to directly set conversation data in storage for testing private methods
 */
async function setConversationData(
  storage: Storage,
  userId: string,
  messages: StoredMessage[]
): Promise<void> {
  await storage.save(`conversation:${userId}`, { messages });
}

describe('ConversationManager Turn Counting', () => {
  let storage: Storage;
  let manager: ConversationManager;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = createMockStorage();
    manager = createConversationManager(storage, createTestLogger());
  });

  describe('countTurns behavior via needsCompaction', () => {
    it('returns false for empty conversation (0 turns)', async () => {
      // Empty conversation - no messages
      await setConversationData(storage, 'user-1', []);

      const needsCompaction = await manager.needsCompaction('user-1');
      expect(needsCompaction).toBe(false);
    });

    it('counts only user messages as turns (ignores assistant/tool)', async () => {
      // 3 user messages = 3 turns (below threshold of 10)
      const messages: StoredMessage[] = [
        { role: 'user', content: 'Hello', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'Hi there!', timestamp: new Date().toISOString() },
        { role: 'user', content: 'How are you?', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'I am good', timestamp: new Date().toISOString() },
        { role: 'user', content: 'Great!', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'Thanks!', timestamp: new Date().toISOString() },
      ];

      await setConversationData(storage, 'user-1', messages);

      // 3 turns should not trigger compaction (threshold is 10)
      const needsCompaction = await manager.needsCompaction('user-1');
      expect(needsCompaction).toBe(false);
    });

    it('triggers compaction when user messages exceed threshold', async () => {
      // Create 12 user messages (turns) - exceeds threshold of 10
      const messages: StoredMessage[] = [];
      for (let i = 0; i < 12; i++) {
        messages.push({
          role: 'user',
          content: `Message ${i}`,
          timestamp: new Date().toISOString(),
        });
        messages.push({
          role: 'assistant',
          content: `Response ${i}`,
          timestamp: new Date().toISOString(),
        });
      }

      await setConversationData(storage, 'user-1', messages);

      // 12 turns should trigger compaction
      const needsCompaction = await manager.needsCompaction('user-1');
      expect(needsCompaction).toBe(true);
    });

    it('tool-heavy conversation with 5 tool calls per turn does NOT inflate turn count', async () => {
      // 3 turns, but each assistant response has 5 tool calls = 18 tool messages
      // Total: 3 user + 3 assistant + 15 tool = 21 messages, but only 3 TURNS
      const messages: StoredMessage[] = [];

      for (let turnIdx = 0; turnIdx < 3; turnIdx++) {
        // User message (turn start)
        messages.push({
          role: 'user',
          content: `Question ${turnIdx}`,
          timestamp: new Date().toISOString(),
        });

        // Assistant with 5 tool calls
        messages.push({
          role: 'assistant',
          content: null,
          timestamp: new Date().toISOString(),
          tool_calls: Array.from({ length: 5 }, (_, i) => ({
            id: `call-${turnIdx}-${i}`,
            type: 'function' as const,
            function: { name: 'core_memory', arguments: '{}' },
          })),
        });

        // 5 tool result messages
        for (let toolIdx = 0; toolIdx < 5; toolIdx++) {
          messages.push({
            role: 'tool',
            content: JSON.stringify({ result: 'ok' }),
            tool_call_id: `call-${turnIdx}-${toolIdx}`,
            timestamp: new Date().toISOString(),
          });
        }

        // Final assistant response
        messages.push({
          role: 'assistant',
          content: `Answer ${turnIdx}`,
          timestamp: new Date().toISOString(),
        });
      }

      await setConversationData(storage, 'user-1', messages);

      // 21 total messages, but only 3 turns - should NOT need compaction
      const needsCompaction = await manager.needsCompaction('user-1');
      expect(needsCompaction).toBe(false);
    });

    it('correctly counts turns even with many tool messages', async () => {
      // Create exactly 11 turns (threshold+1) with heavy tool usage each
      const messages: StoredMessage[] = [];

      for (let turnIdx = 0; turnIdx < 11; turnIdx++) {
        messages.push({
          role: 'user',
          content: `Turn ${turnIdx}`,
          timestamp: new Date().toISOString(),
        });

        // Assistant with tool calls
        messages.push({
          role: 'assistant',
          content: null,
          timestamp: new Date().toISOString(),
          tool_calls: [
            {
              id: `call-${turnIdx}`,
              type: 'function' as const,
              function: { name: 'core_state', arguments: '{}' },
            },
          ],
        });

        messages.push({
          role: 'tool',
          content: '{"state": "ok"}',
          tool_call_id: `call-${turnIdx}`,
          timestamp: new Date().toISOString(),
        });

        messages.push({
          role: 'assistant',
          content: `Response ${turnIdx}`,
          timestamp: new Date().toISOString(),
        });
      }

      await setConversationData(storage, 'user-1', messages);

      // 11 turns > threshold of 10 - should need compaction
      const needsCompaction = await manager.needsCompaction('user-1');
      expect(needsCompaction).toBe(true);
    });
  });

  describe('findTurnStartIndex behavior via getHistory', () => {
    it('returns correct subset of messages for N recent turns', async () => {
      // 5 simple turns (no tool calls)
      const messages: StoredMessage[] = [];
      for (let i = 0; i < 5; i++) {
        messages.push({
          role: 'user',
          content: `User message ${i}`,
          timestamp: new Date().toISOString(),
        });
        messages.push({
          role: 'assistant',
          content: `Assistant response ${i}`,
          timestamp: new Date().toISOString(),
        });
      }

      await setConversationData(storage, 'user-1', messages);

      // Request last 2 turns
      const history = await manager.getHistory('user-1', { maxRecentTurns: 2 });

      // Should include messages for 2 turns (4 messages: 2 user + 2 assistant)
      expect(history).toHaveLength(4);

      // First message should be user message 3 (0-indexed)
      expect(history[0].role).toBe('user');
      expect(history[0].content).toBe('User message 3');

      // Last message should be assistant response 4
      expect(history[3].role).toBe('assistant');
      expect(history[3].content).toBe('Assistant response 4');
    });

    it('walks back to include orphaned tool results (preserves tool call groups)', async () => {
      // Conversation with tool calls at turn boundary
      const messages: StoredMessage[] = [
        // Turn 1
        { role: 'user', content: 'First', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'First response', timestamp: new Date().toISOString() },
        // Turn 2 (has tool calls)
        { role: 'user', content: 'Second', timestamp: new Date().toISOString() },
        {
          role: 'assistant',
          content: null,
          timestamp: new Date().toISOString(),
          tool_calls: [
            {
              id: 'tool-1',
              type: 'function' as const,
              function: { name: 'core_memory', arguments: '{}' },
            },
          ],
        },
        {
          role: 'tool',
          content: '{"results": []}',
          tool_call_id: 'tool-1',
          timestamp: new Date().toISOString(),
        },
        { role: 'assistant', content: 'Second response', timestamp: new Date().toISOString() },
        // Turn 3
        { role: 'user', content: 'Third', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'Third response', timestamp: new Date().toISOString() },
      ];

      await setConversationData(storage, 'user-1', messages);

      // Request last 2 turns - should include turn 2 and turn 3
      const history = await manager.getHistory('user-1', { maxRecentTurns: 2 });

      // Turn 2: user + assistant(tool_calls) + tool + assistant = 4 messages
      // Turn 3: user + assistant = 2 messages
      // Total: 6 messages
      expect(history.length).toBeGreaterThanOrEqual(6);

      // Should start with user message from turn 2
      expect(history[0].role).toBe('user');
      expect(history[0].content).toBe('Second');

      // Should include tool message
      const toolMessages = history.filter((m) => m.role === 'tool');
      expect(toolMessages.length).toBeGreaterThanOrEqual(1);
      expect(toolMessages[0].tool_call_id).toBe('tool-1');

      // Should include assistant message with tool_calls
      const assistantWithToolCalls = history.find((m) => m.tool_calls && m.tool_calls.length > 0);
      expect(assistantWithToolCalls).toBeDefined();
    });

    it('preserves all tool results when slicing at turn boundary', async () => {
      // This test ensures we never separate tool calls from their results
      const messages: StoredMessage[] = [
        // Turn 1 (will be excluded in 1-turn request)
        { role: 'user', content: 'Old', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'Old response', timestamp: new Date().toISOString() },
        // Turn 2 (the one turn we'll request) - has multiple tool calls
        { role: 'user', content: 'Current', timestamp: new Date().toISOString() },
        {
          role: 'assistant',
          content: null,
          timestamp: new Date().toISOString(),
          tool_calls: [
            {
              id: 'call-a',
              type: 'function' as const,
              function: { name: 'core_memory', arguments: '{}' },
            },
            {
              id: 'call-b',
              type: 'function' as const,
              function: { name: 'core_state', arguments: '{}' },
            },
          ],
        },
        {
          role: 'tool',
          content: '{"a": true}',
          tool_call_id: 'call-a',
          timestamp: new Date().toISOString(),
        },
        {
          role: 'tool',
          content: '{"b": true}',
          tool_call_id: 'call-b',
          timestamp: new Date().toISOString(),
        },
        { role: 'assistant', content: 'Current response', timestamp: new Date().toISOString() },
      ];

      await setConversationData(storage, 'user-1', messages);

      // Request only last 1 turn
      const history = await manager.getHistory('user-1', { maxRecentTurns: 1 });

      // Should include: user + assistant(tool_calls) + 2 tool + assistant = 5 messages
      expect(history).toHaveLength(5);

      // Verify tool call IDs are present
      const toolMessages = history.filter((m) => m.role === 'tool');
      expect(toolMessages).toHaveLength(2);
      expect(toolMessages.map((m) => m.tool_call_id).sort()).toEqual(['call-a', 'call-b']);

      // Verify assistant with tool_calls is present
      const assistantWithCalls = history.find((m) => m.tool_calls && m.tool_calls.length > 0);
      expect(assistantWithCalls).toBeDefined();
      expect(assistantWithCalls?.tool_calls?.map((tc) => tc.id).sort()).toEqual([
        'call-a',
        'call-b',
      ]);
    });
  });

  describe('edge cases', () => {
    it('handles conversation with only system messages (0 turns = empty history)', async () => {
      // Only system messages, no user messages = 0 turns
      const messages: StoredMessage[] = [
        { role: 'system', content: 'System prompt', timestamp: new Date().toISOString() },
      ];

      await setConversationData(storage, 'user-1', messages);

      // 0 user messages = 0 turns
      const needsCompaction = await manager.needsCompaction('user-1');
      expect(needsCompaction).toBe(false);

      // When requesting turns and there are 0 turns, findTurnStartIndex returns
      // messages.length, so the slice returns empty array
      const history = await manager.getHistory('user-1', { maxRecentTurns: 10 });
      expect(history).toHaveLength(0);
    });

    it('handles conversation with only assistant messages (0 turns)', async () => {
      const messages: StoredMessage[] = [
        { role: 'assistant', content: 'Proactive greeting', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'Another message', timestamp: new Date().toISOString() },
      ];

      await setConversationData(storage, 'user-1', messages);

      // 0 user messages = 0 turns
      const needsCompaction = await manager.needsCompaction('user-1');
      expect(needsCompaction).toBe(false);
    });

    it('handles requesting more turns than exist', async () => {
      const messages: StoredMessage[] = [
        { role: 'user', content: 'Only message', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'Only response', timestamp: new Date().toISOString() },
      ];

      await setConversationData(storage, 'user-1', messages);

      // Request 100 turns when only 1 exists
      const history = await manager.getHistory('user-1', { maxRecentTurns: 100 });

      // Should return all messages (1 turn = 2 messages)
      expect(history).toHaveLength(2);
    });

    it('handles tool message at the very start of messages array', async () => {
      // This is an edge case that shouldn't happen normally but tests robustness
      const messages: StoredMessage[] = [
        // Orphaned tool message (shouldn't happen but testing edge case)
        {
          role: 'tool',
          content: '{"orphan": true}',
          tool_call_id: 'orphan-call',
          timestamp: new Date().toISOString(),
        },
        { role: 'user', content: 'Real turn', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'Response', timestamp: new Date().toISOString() },
      ];

      await setConversationData(storage, 'user-1', messages);

      // Should still work without errors
      const history = await manager.getHistory('user-1', { maxRecentTurns: 1 });
      expect(history.length).toBeGreaterThanOrEqual(2);
    });

    it('counts turns correctly with interleaved tool calls', async () => {
      // Complex interleaving pattern
      const messages: StoredMessage[] = [];

      // 8 turns with varying tool call patterns
      for (let i = 0; i < 8; i++) {
        messages.push({
          role: 'user',
          content: `Question ${i}`,
          timestamp: new Date().toISOString(),
        });

        // Even turns have tool calls
        if (i % 2 === 0) {
          messages.push({
            role: 'assistant',
            content: null,
            timestamp: new Date().toISOString(),
            tool_calls: [
              {
                id: `call-${i}`,
                type: 'function' as const,
                function: { name: 'core_memory', arguments: '{}' },
              },
            ],
          });
          messages.push({
            role: 'tool',
            content: '{}',
            tool_call_id: `call-${i}`,
            timestamp: new Date().toISOString(),
          });
        }

        messages.push({
          role: 'assistant',
          content: `Answer ${i}`,
          timestamp: new Date().toISOString(),
        });
      }

      await setConversationData(storage, 'user-1', messages);

      // 8 user messages = 8 turns, under threshold
      const needsCompaction = await manager.needsCompaction('user-1');
      expect(needsCompaction).toBe(false);
    });
  });

  describe('getMessagesToCompact filters tool messages', () => {
    it('only includes user/assistant messages for summarization', async () => {
      // Create > 10 turns to trigger compaction eligibility
      const messages: StoredMessage[] = [];
      for (let i = 0; i < 12; i++) {
        messages.push({
          role: 'user',
          content: `User ${i}`,
          timestamp: new Date().toISOString(),
        });

        // Add tool calls for some turns
        if (i < 3) {
          messages.push({
            role: 'assistant',
            content: null,
            timestamp: new Date().toISOString(),
            tool_calls: [
              {
                id: `call-${i}`,
                type: 'function' as const,
                function: { name: 'core_memory', arguments: '{}' },
              },
            ],
          });
          messages.push({
            role: 'tool',
            content: '{}',
            tool_call_id: `call-${i}`,
            timestamp: new Date().toISOString(),
          });
        }

        messages.push({
          role: 'assistant',
          content: `Response ${i}`,
          timestamp: new Date().toISOString(),
        });
      }

      await setConversationData(storage, 'user-1', messages);

      const toCompact = await manager.getMessagesToCompact('user-1');

      // Should only include user and assistant messages (no tool messages)
      const toolMessages = toCompact.filter((m) => m.role === 'tool');
      expect(toolMessages).toHaveLength(0);

      // All messages should be user or assistant
      for (const msg of toCompact) {
        expect(['user', 'assistant']).toContain(msg.role);
      }
    });
  });
});
