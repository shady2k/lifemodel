/**
 * Tests for thought signal deferral when COGNITION is busy.
 *
 * These tests verify that thought signals are not lost when COGNITION
 * is already processing. Instead, they are re-queued for the next tick.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Signal, ThoughtData } from '../../src/types/signal.js';
import { createSignal } from '../../src/types/signal.js';
import { Priority } from '../../src/types/priority.js';

/**
 * Simulates the CoreLoop's signal processing logic to test deferral behavior.
 * This mirrors the actual implementation without needing full CoreLoop dependencies.
 */
class MockCoreLoopSignalProcessor {
  private pendingSignals: Array<{ signal: Signal; timestamp: Date }> = [];
  private cognitionBusy = false;
  private processedSignals: Signal[] = [];
  private deferredThoughts: Signal[] = [];

  setCognitionBusy(busy: boolean): void {
    this.cognitionBusy = busy;
  }

  pushSignal(signal: Signal): void {
    this.pendingSignals.push({ signal, timestamp: new Date() });
  }

  /**
   * Simulates collectIncomingSignals from CoreLoop.
   */
  collectIncomingSignals(maxSignals = 100): Signal[] {
    const signals: Signal[] = [];
    while (this.pendingSignals.length > 0 && signals.length < maxSignals) {
      const pending = this.pendingSignals.shift();
      if (pending) {
        signals.push(pending.signal);
      }
    }
    return signals;
  }

  /**
   * Simulates the thought deferral logic added to tick().
   * This mirrors the fix in core-loop.ts step 2b.
   */
  processTick(): { processed: Signal[]; deferred: Signal[] } {
    const signals = this.collectIncomingSignals();
    let allSignals = signals;

    // 2b. Defer thought signals if COGNITION is busy
    const hasThoughtSignals = allSignals.some((s) => s.type === 'thought');
    if (this.cognitionBusy && hasThoughtSignals) {
      const thoughtSignals = allSignals.filter((s) => s.type === 'thought');
      const otherSignals = allSignals.filter((s) => s.type !== 'thought');

      // Re-queue thoughts at the front for next tick (FIFO order preserved)
      for (let i = thoughtSignals.length - 1; i >= 0; i--) {
        this.pendingSignals.unshift({ signal: thoughtSignals[i], timestamp: new Date() });
      }

      // Track what was deferred
      this.deferredThoughts.push(...thoughtSignals);

      // Continue with non-thought signals only
      allSignals = otherSignals;
    }

    // These would go through AGGREGATION/COGNITION
    this.processedSignals.push(...allSignals);

    return {
      processed: allSignals,
      deferred: this.deferredThoughts.splice(0),
    };
  }

  getPendingCount(): number {
    return this.pendingSignals.length;
  }

  getProcessedSignals(): Signal[] {
    return this.processedSignals;
  }

  reset(): void {
    this.pendingSignals = [];
    this.processedSignals = [];
    this.deferredThoughts = [];
    this.cognitionBusy = false;
  }
}

/**
 * Helper to create a thought signal.
 */
function createThoughtSignal(content: string, options: Partial<ThoughtData> = {}): Signal {
  return createSignal(
    'thought',
    'cognition.thought',
    { value: 1 },
    {
      priority: Priority.NORMAL,
      data: {
        kind: 'thought',
        content,
        triggerSource: 'conversation',
        depth: 0,
        rootThoughtId: `thought_${Date.now()}`,
        ...options,
      } as ThoughtData,
    }
  );
}

/**
 * Helper to create a user message signal.
 */
function createUserMessage(text: string, chatId = '123'): Signal {
  return createSignal(
    'user_message',
    'sense.telegram',
    { value: 1 },
    {
      priority: Priority.HIGH,
      data: {
        kind: 'user_message',
        text,
        chatId,
        recipientId: `recipient_${chatId}`,
      },
    }
  );
}

describe('CoreLoop - Thought Signal Deferral', () => {
  let processor: MockCoreLoopSignalProcessor;

  beforeEach(() => {
    processor = new MockCoreLoopSignalProcessor();
  });

  describe('when COGNITION is busy', () => {
    beforeEach(() => {
      processor.setCognitionBusy(true);
    });

    it('should defer thought signals to next tick', () => {
      const thought = createThoughtSignal('News article summary about tech');
      processor.pushSignal(thought);

      const { processed, deferred } = processor.processTick();

      // Thought should be deferred, not processed
      expect(processed).toHaveLength(0);
      expect(deferred).toHaveLength(1);
      expect(deferred[0].id).toBe(thought.id);

      // Thought should be back in pending queue
      expect(processor.getPendingCount()).toBe(1);
    });

    it('should process user messages immediately even when busy', () => {
      const userMessage = createUserMessage('Hello!');
      const thought = createThoughtSignal('Check reminders');

      processor.pushSignal(thought);
      processor.pushSignal(userMessage);

      const { processed, deferred } = processor.processTick();

      // User message processed, thought deferred
      expect(processed).toHaveLength(1);
      expect(processed[0].type).toBe('user_message');
      expect(deferred).toHaveLength(1);
      expect(deferred[0].type).toBe('thought');

      // Thought back in queue
      expect(processor.getPendingCount()).toBe(1);
    });

    it('should handle multiple deferred thoughts preserving order', () => {
      const thought1 = createThoughtSignal('First thought');
      const thought2 = createThoughtSignal('Second thought');
      const thought3 = createThoughtSignal('Third thought');

      processor.pushSignal(thought1);
      processor.pushSignal(thought2);
      processor.pushSignal(thought3);

      const { deferred } = processor.processTick();

      // All thoughts deferred
      expect(deferred).toHaveLength(3);

      // All thoughts back in queue
      expect(processor.getPendingCount()).toBe(3);

      // Now simulate COGNITION becoming free
      processor.setCognitionBusy(false);

      const { processed: processedAfter } = processor.processTick();

      // All thoughts now processed in original order
      expect(processedAfter).toHaveLength(3);
      expect(processedAfter[0].id).toBe(thought1.id);
      expect(processedAfter[1].id).toBe(thought2.id);
      expect(processedAfter[2].id).toBe(thought3.id);
    });

    it('should process mixed signals correctly - thoughts deferred, others processed', () => {
      const thought = createThoughtSignal('Memory consolidation');
      const userMessage = createUserMessage('How are you?');
      const internalSignal = createSignal(
        'internal',
        'neuron.energy',
        { value: 0.5 },
        { priority: Priority.NORMAL }
      );

      processor.pushSignal(thought);
      processor.pushSignal(userMessage);
      processor.pushSignal(internalSignal);

      const { processed, deferred } = processor.processTick();

      // User message and internal signal processed
      expect(processed).toHaveLength(2);
      expect(processed.map((s) => s.type)).toContain('user_message');
      expect(processed.map((s) => s.type)).toContain('internal');

      // Thought deferred
      expect(deferred).toHaveLength(1);
      expect(deferred[0].type).toBe('thought');
    });
  });

  describe('when COGNITION is free', () => {
    beforeEach(() => {
      processor.setCognitionBusy(false);
    });

    it('should process thought signals immediately', () => {
      const thought = createThoughtSignal('Reflection on conversation');
      processor.pushSignal(thought);

      const { processed, deferred } = processor.processTick();

      // Thought processed immediately
      expect(processed).toHaveLength(1);
      expect(processed[0].id).toBe(thought.id);
      expect(deferred).toHaveLength(0);

      // Queue is empty
      expect(processor.getPendingCount()).toBe(0);
    });

    it('should process all signal types together', () => {
      const thought = createThoughtSignal('Planning next action');
      const userMessage = createUserMessage('What time is it?');

      processor.pushSignal(thought);
      processor.pushSignal(userMessage);

      const { processed, deferred } = processor.processTick();

      // Both processed
      expect(processed).toHaveLength(2);
      expect(deferred).toHaveLength(0);
      expect(processor.getPendingCount()).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should handle empty signal queue', () => {
      processor.setCognitionBusy(true);

      const { processed, deferred } = processor.processTick();

      expect(processed).toHaveLength(0);
      expect(deferred).toHaveLength(0);
    });

    it('should handle queue with only non-thought signals when busy', () => {
      processor.setCognitionBusy(true);

      const userMessage = createUserMessage('Hello');
      processor.pushSignal(userMessage);

      const { processed, deferred } = processor.processTick();

      // User message processed, nothing deferred
      expect(processed).toHaveLength(1);
      expect(processed[0].type).toBe('user_message');
      expect(deferred).toHaveLength(0);
    });

    it('should correctly re-queue thoughts after multiple busy ticks', () => {
      processor.setCognitionBusy(true);

      const thought = createThoughtSignal('Persistent thought');
      processor.pushSignal(thought);

      // First tick - thought deferred
      processor.processTick();
      expect(processor.getPendingCount()).toBe(1);

      // Second tick - still busy, thought deferred again
      processor.processTick();
      expect(processor.getPendingCount()).toBe(1);

      // Third tick - COGNITION free, thought processed
      processor.setCognitionBusy(false);
      const { processed } = processor.processTick();

      expect(processed).toHaveLength(1);
      expect(processed[0].id).toBe(thought.id);
      expect(processor.getPendingCount()).toBe(0);
    });

    it('should accumulate new thoughts while previous ones are deferred', () => {
      processor.setCognitionBusy(true);

      // First thought arrives
      const thought1 = createThoughtSignal('First thought');
      processor.pushSignal(thought1);
      processor.processTick();

      // Second thought arrives while first is still waiting
      const thought2 = createThoughtSignal('Second thought');
      processor.pushSignal(thought2);
      processor.processTick();

      // Both thoughts should be in queue
      expect(processor.getPendingCount()).toBe(2);

      // COGNITION becomes free - both processed
      processor.setCognitionBusy(false);
      const { processed } = processor.processTick();

      expect(processed).toHaveLength(2);
    });
  });
});
