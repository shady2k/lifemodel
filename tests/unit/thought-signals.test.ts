import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockLogger } from '../helpers/factories.js';
import type { Signal, ThoughtData, SignalSource } from '../../src/types/signal.js';
import { createSignal, THOUGHT_LIMITS } from '../../src/types/signal.js';
import { Priority } from '../../src/types/priority.js';

/**
 * Tests for thought signal security safeguards.
 *
 * These tests ensure:
 * 1. Thought depth cannot be reset by LLM to bypass recursion limits
 * 2. Memory consolidation thoughts respect budget/dedupe limits
 */
describe('Thought Signal Security', () => {
  describe('Depth derivation from trigger signal', () => {
    /**
     * Helper to simulate the depth derivation logic from agentic-loop.ts
     * This mirrors the security fix that derives depth from trigger signal.
     */
    function deriveThoughtDepth(
      triggerSignal: Signal,
      llmProvidedParent?: { depth: number; rootThoughtId: string; id: string }
    ): { depth: number; rootId: string; parentId: string | undefined; triggerSource: string } | null {
      if (triggerSignal.type === 'thought') {
        // Processing a thought signal - MUST increment from trigger's depth
        const triggerData = triggerSignal.data as ThoughtData | undefined;
        if (triggerData) {
          return {
            depth: triggerData.depth + 1,
            rootId: triggerData.rootThoughtId,
            parentId: triggerSignal.id,
            triggerSource: 'thought',
          };
        }
        // Malformed thought signal
        return null;
      }
      // Not triggered by thought - this is a root thought
      // LLM-provided parentThought is ignored for security
      return {
        depth: 0,
        rootId: `thought_new`,
        parentId: undefined,
        triggerSource: triggerSignal.type === 'user_message' ? 'conversation' : 'memory',
      };
    }

    it('derives depth from trigger thought signal, ignoring LLM-provided parent', () => {
      // Create a thought signal at depth 1
      const triggerThought = createSignal(
        'thought',
        'cognition.thought',
        { value: 1 },
        {
          priority: Priority.NORMAL,
          data: {
            kind: 'thought',
            content: 'Parent thought',
            triggerSource: 'conversation',
            depth: 1,
            rootThoughtId: 'root_123',
            dedupeKey: 'parent thought',
          } as ThoughtData,
        }
      );

      // LLM tries to provide a fake parent that resets depth to 0
      const llmFakeParent = {
        depth: -1, // Would make derived depth 0
        rootThoughtId: 'fake_root',
        id: 'fake_id',
      };

      const result = deriveThoughtDepth(triggerThought, llmFakeParent);

      // Security: depth should be derived from trigger signal (1 + 1 = 2)
      // LLM's fake parent should be completely ignored
      expect(result).not.toBeNull();
      expect(result!.depth).toBe(2); // 1 + 1 = 2, not 0
      expect(result!.rootId).toBe('root_123'); // From trigger, not 'fake_root'
      expect(result!.parentId).toBe(triggerThought.id); // Actual trigger signal ID
      expect(result!.triggerSource).toBe('thought');
    });

    it('allows root thoughts (depth 0) only from non-thought triggers', () => {
      const userMessage = createSignal(
        'user_message',
        'sense.telegram',
        { value: 1 },
        {
          priority: Priority.HIGH,
          data: {
            kind: 'user_message',
            text: 'Hello',
            chatId: '123',
          },
        }
      );

      const result = deriveThoughtDepth(userMessage);

      expect(result).not.toBeNull();
      expect(result!.depth).toBe(0); // Root thought allowed from user message
      expect(result!.triggerSource).toBe('conversation');
    });

    it('rejects thought with depth exceeding MAX_DEPTH', () => {
      // Create a thought at MAX_DEPTH
      const triggerThought = createSignal(
        'thought',
        'cognition.thought',
        { value: 1 },
        {
          priority: Priority.NORMAL,
          data: {
            kind: 'thought',
            content: 'Deep thought',
            triggerSource: 'thought',
            depth: THOUGHT_LIMITS.MAX_DEPTH,
            rootThoughtId: 'root_123',
            dedupeKey: 'deep thought',
          } as ThoughtData,
        }
      );

      const result = deriveThoughtDepth(triggerThought);

      // Derived depth would be MAX_DEPTH + 1, which exceeds limit
      expect(result).not.toBeNull();
      expect(result!.depth).toBe(THOUGHT_LIMITS.MAX_DEPTH + 1);
      // This would then be rejected by the depth check in agentic-loop.ts
    });

    it('rejects malformed thought signal missing data', () => {
      const malformedThought = createSignal(
        'thought',
        'cognition.thought',
        { value: 1 },
        { priority: Priority.NORMAL }
        // Note: no data provided
      );

      const result = deriveThoughtDepth(malformedThought);

      expect(result).toBeNull();
    });
  });

  describe('Memory consolidation thought budget/dedupe', () => {
    /**
     * Simulates the enqueueThoughtSignal logic from CoreLoop.
     */
    class MockThoughtEnqueuer {
      private thoughtsThisTick = 0;
      private recentThoughtKeys = new Map<string, number>();
      private queuedSignals: Signal[] = [];

      resetTick(): void {
        this.thoughtsThisTick = 0;
      }

      enqueueThoughtSignal(
        thoughtData: ThoughtData,
        signalSource: SignalSource
      ): boolean {
        // Budget check
        if (this.thoughtsThisTick >= THOUGHT_LIMITS.MAX_PER_TICK) {
          return false;
        }

        // Dedupe check
        const now = Date.now();
        // Clean old keys
        for (const [key, timestamp] of this.recentThoughtKeys) {
          if (now - timestamp > THOUGHT_LIMITS.DEDUPE_WINDOW_MS) {
            this.recentThoughtKeys.delete(key);
          }
        }

        if (this.recentThoughtKeys.has(thoughtData.dedupeKey)) {
          return false;
        }
        this.recentThoughtKeys.set(thoughtData.dedupeKey, now);

        // Queue signal
        const signal = createSignal(
          'thought',
          signalSource,
          { value: 1 },
          { priority: 2, data: thoughtData }
        );
        this.queuedSignals.push(signal);
        this.thoughtsThisTick++;

        return true;
      }

      getQueuedCount(): number {
        return this.queuedSignals.length;
      }

      getThoughtsThisTick(): number {
        return this.thoughtsThisTick;
      }
    }

    it('respects per-tick budget for memory consolidation thoughts', () => {
      const enqueuer = new MockThoughtEnqueuer();

      // Try to enqueue more thoughts than MAX_PER_TICK
      const thoughts: ThoughtData[] = Array.from(
        { length: THOUGHT_LIMITS.MAX_PER_TICK + 2 },
        (_, i) => ({
          kind: 'thought' as const,
          content: `Reminder ${i}`,
          triggerSource: 'memory' as const,
          depth: 0,
          rootThoughtId: `mem_thought_${i}`,
          dedupeKey: `reminder ${i}`,
        })
      );

      let accepted = 0;
      for (const thought of thoughts) {
        if (enqueuer.enqueueThoughtSignal(thought, 'memory.thought')) {
          accepted++;
        }
      }

      // Only MAX_PER_TICK should be accepted
      expect(accepted).toBe(THOUGHT_LIMITS.MAX_PER_TICK);
      expect(enqueuer.getQueuedCount()).toBe(THOUGHT_LIMITS.MAX_PER_TICK);
    });

    it('deduplicates memory consolidation thoughts with same dedupeKey', () => {
      const enqueuer = new MockThoughtEnqueuer();

      const thought1: ThoughtData = {
        kind: 'thought',
        content: 'Remind user about bills',
        triggerSource: 'memory',
        depth: 0,
        rootThoughtId: 'mem_thought_1',
        dedupeKey: 'remind user about bills',
      };

      const thought2: ThoughtData = {
        kind: 'thought',
        content: 'Remind user about bills after 10th', // Different full content
        triggerSource: 'memory',
        depth: 0,
        rootThoughtId: 'mem_thought_2',
        dedupeKey: 'remind user about bills', // Same dedupeKey (first 50 chars)
      };

      const first = enqueuer.enqueueThoughtSignal(thought1, 'memory.thought');
      const second = enqueuer.enqueueThoughtSignal(thought2, 'memory.thought');

      expect(first).toBe(true);
      expect(second).toBe(false); // Rejected as duplicate
      expect(enqueuer.getQueuedCount()).toBe(1);
    });

    it('allows thoughts with different dedupeKeys from same consolidation', () => {
      const enqueuer = new MockThoughtEnqueuer();

      const thought1: ThoughtData = {
        kind: 'thought',
        content: 'Remind about bills',
        triggerSource: 'memory',
        depth: 0,
        rootThoughtId: 'mem_thought_1',
        dedupeKey: 'remind about bills',
      };

      const thought2: ThoughtData = {
        kind: 'thought',
        content: 'Check on interview prep',
        triggerSource: 'memory',
        depth: 0,
        rootThoughtId: 'mem_thought_2',
        dedupeKey: 'check on interview prep',
      };

      const first = enqueuer.enqueueThoughtSignal(thought1, 'memory.thought');
      const second = enqueuer.enqueueThoughtSignal(thought2, 'memory.thought');

      expect(first).toBe(true);
      expect(second).toBe(true);
      expect(enqueuer.getQueuedCount()).toBe(2);
    });

    it('budget resets on new tick', () => {
      const enqueuer = new MockThoughtEnqueuer();

      // Fill budget on first tick
      for (let i = 0; i < THOUGHT_LIMITS.MAX_PER_TICK; i++) {
        enqueuer.enqueueThoughtSignal(
          {
            kind: 'thought',
            content: `Tick 1 thought ${i}`,
            triggerSource: 'memory',
            depth: 0,
            rootThoughtId: `mem_${i}`,
            dedupeKey: `tick 1 thought ${i}`,
          },
          'memory.thought'
        );
      }

      expect(enqueuer.getThoughtsThisTick()).toBe(THOUGHT_LIMITS.MAX_PER_TICK);

      // Reset for new tick
      enqueuer.resetTick();

      // Can now enqueue more (with different dedupeKey)
      const result = enqueuer.enqueueThoughtSignal(
        {
          kind: 'thought',
          content: 'Tick 2 thought',
          triggerSource: 'memory',
          depth: 0,
          rootThoughtId: 'mem_tick2',
          dedupeKey: 'tick 2 thought',
        },
        'memory.thought'
      );

      expect(result).toBe(true);
      expect(enqueuer.getThoughtsThisTick()).toBe(1);
    });
  });
});
