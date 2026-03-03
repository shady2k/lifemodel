/**
 * Tests for unified conversation compaction with memory-backed summaries.
 *
 * Features tested:
 * - getLatestByKind() on MemoryProvider
 * - compactMessages() CAS guard on ConversationManager
 * - getHistory() no longer injects compactedSummary
 * - Full compaction flow in processor (mocked)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ConversationManager,
  createConversationManager,
} from '../../src/storage/conversation-manager.js';
import {
  JsonMemoryProvider,
  createJsonMemoryProvider,
} from '../../src/storage/memory-provider.js';
import type { Storage } from '../../src/storage/storage.js';
import type { MemoryEntry } from '../../src/layers/cognition/tools/core/memory.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

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

async function setConversationData(
  storage: Storage,
  userId: string,
  messages: StoredMessage[],
  extra?: Record<string, unknown>
): Promise<void> {
  await storage.save(`conversation:${userId}`, { messages, ...extra });
}

function makeMemoryEntry(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    type: 'message',
    content: 'test content',
    timestamp: new Date(),
    confidence: 1.0,
    tags: [],
    metadata: {},
    ...overrides,
  };
}

// ─── getLatestByKind ─────────────────────────────────────────────────────────

describe('JsonMemoryProvider.getLatestByKind', () => {
  let memoryProvider: JsonMemoryProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    memoryProvider = createJsonMemoryProvider(createTestLogger(), {
      storage: createMockStorage(),
      storageKey: 'memory',
      maxEntries: 1000,
    });
  });

  it('returns the most recent entry by timestamp', async () => {
    const older = makeMemoryEntry({
      id: 'mem-1',
      content: 'old summary',
      timestamp: new Date('2026-01-01T00:00:00Z'),
      metadata: { kind: 'conversation_summary' },
    });
    const newer = makeMemoryEntry({
      id: 'mem-2',
      content: 'new summary',
      timestamp: new Date('2026-02-01T00:00:00Z'),
      metadata: { kind: 'conversation_summary' },
    });

    await memoryProvider.save(older);
    await memoryProvider.save(newer);

    const result = await memoryProvider.getLatestByKind('conversation_summary');
    expect(result).toBeDefined();
    expect(result!.id).toBe('mem-2');
    expect(result!.content).toBe('new summary');
  });

  it('returns undefined when no entries match', async () => {
    await memoryProvider.save(
      makeMemoryEntry({
        id: 'mem-1',
        metadata: { kind: 'other_kind' },
      })
    );

    const result = await memoryProvider.getLatestByKind('conversation_summary');
    expect(result).toBeUndefined();
  });

  it('filters by recipientId correctly', async () => {
    const chatA = makeMemoryEntry({
      id: 'mem-a',
      content: 'summary for chat-a',
      timestamp: new Date('2026-03-01T00:00:00Z'),
      recipientId: 'chat-a',
      metadata: { kind: 'conversation_summary' },
    });
    const chatB = makeMemoryEntry({
      id: 'mem-b',
      content: 'summary for chat-b',
      timestamp: new Date('2026-03-02T00:00:00Z'),
      recipientId: 'chat-b',
      metadata: { kind: 'conversation_summary' },
    });

    await memoryProvider.save(chatA);
    await memoryProvider.save(chatB);

    const result = await memoryProvider.getLatestByKind('conversation_summary', 'chat-a');
    expect(result).toBeDefined();
    expect(result!.id).toBe('mem-a');
    expect(result!.recipientId).toBe('chat-a');
  });

  it('returns undefined when recipientId has no entries', async () => {
    await memoryProvider.save(
      makeMemoryEntry({
        id: 'mem-1',
        recipientId: 'chat-x',
        metadata: { kind: 'conversation_summary' },
      })
    );

    const result = await memoryProvider.getLatestByKind('conversation_summary', 'chat-y');
    expect(result).toBeUndefined();
  });
});

// ─── compactMessages CAS guard ──────────────────────────────────────────────

describe('ConversationManager.compactMessages', () => {
  let storage: Storage;
  let manager: ConversationManager;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = createMockStorage();
    manager = createConversationManager(storage, createTestLogger());
  });

  it('trims to last 3 turns when count matches', async () => {
    // 6 turns = 12 messages (simple user+assistant pairs)
    const messages: StoredMessage[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push({
        role: 'user',
        content: `User ${i}`,
        timestamp: new Date().toISOString(),
      });
      messages.push({
        role: 'assistant',
        content: `Response ${i}`,
        timestamp: new Date().toISOString(),
      });
    }

    await setConversationData(storage, 'user-1', messages);

    const result = await manager.compactMessages('user-1', 12);
    expect(result).toBe(true);

    // Should keep last 3 turns = 6 messages
    const history = await manager.getHistory('user-1', { maxRecentTurns: 100 });
    expect(history).toHaveLength(6);
    expect(history[0]?.content).toBe('User 3');
  });

  it('returns false when count is stale (concurrent compaction)', async () => {
    const messages: StoredMessage[] = [];
    for (let i = 0; i < 5; i++) {
      messages.push({
        role: 'user',
        content: `User ${i}`,
        timestamp: new Date().toISOString(),
      });
      messages.push({
        role: 'assistant',
        content: `Response ${i}`,
        timestamp: new Date().toISOString(),
      });
    }

    await setConversationData(storage, 'user-1', messages);

    // Pass wrong expected count
    const result = await manager.compactMessages('user-1', 999);
    expect(result).toBe(false);

    // Messages should be unchanged
    const history = await manager.getHistory('user-1', { maxRecentTurns: 100 });
    expect(history).toHaveLength(10);
  });

  it('returns true when no messages to compact', async () => {
    // Only 2 turns — fewer than recentTurnsToKeep (3)
    const messages: StoredMessage[] = [
      { role: 'user', content: 'Hello', timestamp: new Date().toISOString() },
      { role: 'assistant', content: 'Hi!', timestamp: new Date().toISOString() },
    ];

    await setConversationData(storage, 'user-1', messages);

    const result = await manager.compactMessages('user-1', 2);
    expect(result).toBe(true);
  });
});

// ─── getHistory no longer injects compactedSummary ──────────────────────────

describe('ConversationManager.getHistory (no compactedSummary)', () => {
  let storage: Storage;
  let manager: ConversationManager;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = createMockStorage();
    manager = createConversationManager(storage, createTestLogger());
  });

  it('does not inject compactedSummary even when present in storage', async () => {
    const messages: StoredMessage[] = [
      { role: 'user', content: 'Hello', timestamp: new Date().toISOString() },
      { role: 'assistant', content: 'Hi!', timestamp: new Date().toISOString() },
    ];

    // Simulate old data with compactedSummary still in storage
    await setConversationData(storage, 'user-1', messages, {
      compactedSummary: 'Old summary from before migration',
    });

    const history = await manager.getHistory('user-1');

    // Should only have the 2 actual messages, no summary system message
    expect(history).toHaveLength(2);
    expect(history.every((m) => m.role !== 'system')).toBe(true);
  });
});

// ─── getMessageCount ─────────────────────────────────────────────────────────

describe('ConversationManager.getMessageCount', () => {
  let storage: Storage;
  let manager: ConversationManager;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = createMockStorage();
    manager = createConversationManager(storage, createTestLogger());
  });

  it('returns correct message count', async () => {
    const messages: StoredMessage[] = [
      { role: 'user', content: 'Hello', timestamp: new Date().toISOString() },
      { role: 'assistant', content: 'Hi!', timestamp: new Date().toISOString() },
      { role: 'user', content: 'How are you?', timestamp: new Date().toISOString() },
    ];

    await setConversationData(storage, 'user-1', messages);

    const count = await manager.getMessageCount('user-1');
    expect(count).toBe(3);
  });

  it('returns 0 for empty conversation', async () => {
    const count = await manager.getMessageCount('nonexistent');
    expect(count).toBe(0);
  });
});
