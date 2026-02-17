/**
 * Tests for signal deferral when COGNITION is disabled by stress.
 *
 * When CPU stress is high/critical, activeLayers.cognition = false.
 * Deferrable signals (thought, message_reaction, user_message, motor_result)
 * must be re-queued — not dropped — so they are processed once stress recovers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Signal, ThoughtData } from '../../src/types/signal.js';
import { createSignal } from '../../src/types/signal.js';
import { Priority } from '../../src/types/priority.js';

const DEFERRABLE_TYPES = ['thought', 'message_reaction', 'user_message', 'motor_result'];

/**
 * Simulates the CoreLoop's signal deferral logic for stress scenarios.
 * Mirrors the widened condition: cognitionUnavailable = pendingCognition || !activeLayers.cognition
 */
class MockStressProcessor {
  private pendingSignals: Array<{ signal: Signal; timestamp: Date }> = [];
  private cognitionBusy = false;
  private cognitionEnabled = true;
  private processedSignals: Signal[] = [];

  setCognitionBusy(busy: boolean): void {
    this.cognitionBusy = busy;
  }

  setCognitionEnabled(enabled: boolean): void {
    this.cognitionEnabled = enabled;
  }

  pushSignal(signal: Signal): void {
    this.pendingSignals.push({ signal, timestamp: new Date() });
  }

  processTick(): { processed: Signal[]; deferred: Signal[] } {
    // Drain pending signals
    const signals: Signal[] = [];
    while (this.pendingSignals.length > 0 && signals.length < 100) {
      const pending = this.pendingSignals.shift();
      if (pending) signals.push(pending.signal);
    }

    let allSignals = signals;
    const deferred: Signal[] = [];

    // Mirror the widened gate condition
    const hasDeferrableSignals = allSignals.some((s) => DEFERRABLE_TYPES.includes(s.type));
    const cognitionUnavailable = this.cognitionBusy || !this.cognitionEnabled;

    if (cognitionUnavailable && hasDeferrableSignals) {
      const toDefer = allSignals.filter((s) => DEFERRABLE_TYPES.includes(s.type));
      const otherSignals = allSignals.filter((s) => !DEFERRABLE_TYPES.includes(s.type));

      // Re-queue at the front for next tick (FIFO order preserved)
      for (let i = toDefer.length - 1; i >= 0; i--) {
        this.pendingSignals.unshift({ signal: toDefer[i], timestamp: new Date() });
      }

      deferred.push(...toDefer);
      allSignals = otherSignals;
    }

    this.processedSignals.push(...allSignals);
    return { processed: allSignals, deferred };
  }

  getPendingCount(): number {
    return this.pendingSignals.length;
  }

  getProcessedSignals(): Signal[] {
    return this.processedSignals;
  }
}

function createThoughtSignal(content: string): Signal {
  return createSignal('thought', 'cognition.thought', { value: 1 }, {
    priority: Priority.NORMAL,
    data: {
      kind: 'thought',
      content,
      triggerSource: 'conversation',
      depth: 0,
      rootThoughtId: `thought_${Date.now()}`,
    } as ThoughtData,
  });
}

function createUserMessage(text: string, chatId = '123'): Signal {
  return createSignal('user_message', 'sense.telegram', { value: 1 }, {
    priority: Priority.HIGH,
    data: { kind: 'user_message', text, chatId, recipientId: `recipient_${chatId}` },
  });
}

function createReactionSignal(): Signal {
  return createSignal('message_reaction', 'sense.telegram', { value: 1 }, {
    priority: Priority.NORMAL,
    data: { kind: 'message_reaction', chatId: '123', messageId: 1, emoji: '👍', recipientId: 'r1' },
  });
}

function createPluginEvent(): Signal {
  return createSignal('plugin_event', 'neuron.rss', { value: 0.3 }, {
    priority: Priority.LOW,
    data: { kind: 'plugin_event', pluginId: 'rss', event: 'new_items' },
  });
}

describe('CoreLoop - Stress-based Signal Deferral', () => {
  let processor: MockStressProcessor;

  beforeEach(() => {
    processor = new MockStressProcessor();
  });

  describe('high stress (cognition disabled)', () => {
    beforeEach(() => {
      processor.setCognitionEnabled(false);
    });

    it('should defer user_message when cognition disabled by stress', () => {
      const msg = createUserMessage('Hello!');
      processor.pushSignal(msg);

      const { processed, deferred } = processor.processTick();

      expect(processed).toHaveLength(0);
      expect(deferred).toHaveLength(1);
      expect(deferred[0].type).toBe('user_message');
      expect(processor.getPendingCount()).toBe(1);
    });

    it('should process user_message after stress recovers', () => {
      const msg = createUserMessage('Hello!');
      processor.pushSignal(msg);

      // Tick 1: stressed — deferred
      processor.processTick();
      expect(processor.getPendingCount()).toBe(1);

      // Stress recovers
      processor.setCognitionEnabled(true);

      // Tick 2: processed
      const { processed } = processor.processTick();
      expect(processed).toHaveLength(1);
      expect(processed[0].id).toBe(msg.id);
      expect(processor.getPendingCount()).toBe(0);
    });

    it('should defer thought signals when cognition disabled', () => {
      const thought = createThoughtSignal('Reflect on conversation');
      processor.pushSignal(thought);

      const { processed, deferred } = processor.processTick();

      expect(processed).toHaveLength(0);
      expect(deferred).toHaveLength(1);
      expect(deferred[0].type).toBe('thought');
    });

    it('should let non-deferrable signals through even under stress', () => {
      const pluginEvent = createPluginEvent();
      processor.pushSignal(pluginEvent);

      const { processed, deferred } = processor.processTick();

      expect(processed).toHaveLength(1);
      expect(processed[0].type).toBe('plugin_event');
      expect(deferred).toHaveLength(0);
    });

    it('should defer mixed batch: user_message + thought deferred, plugin_event passes', () => {
      const msg = createUserMessage('Hey');
      const thought = createThoughtSignal('Think about it');
      const reaction = createReactionSignal();
      const pluginEvent = createPluginEvent();

      processor.pushSignal(msg);
      processor.pushSignal(thought);
      processor.pushSignal(reaction);
      processor.pushSignal(pluginEvent);

      const { processed, deferred } = processor.processTick();

      // Only plugin_event passes through
      expect(processed).toHaveLength(1);
      expect(processed[0].type).toBe('plugin_event');

      // All deferrable signals held
      expect(deferred).toHaveLength(3);
      const deferredTypes = deferred.map((s) => s.type);
      expect(deferredTypes).toContain('user_message');
      expect(deferredTypes).toContain('thought');
      expect(deferredTypes).toContain('message_reaction');

      expect(processor.getPendingCount()).toBe(3);
    });
  });

  describe('critical stress (cognition + aggregation disabled)', () => {
    beforeEach(() => {
      processor.setCognitionEnabled(false);
      // In critical stress, aggregation is also disabled — but deferral happens
      // before aggregation, so signals are still preserved
    });

    it('should defer user_message even at critical stress', () => {
      const msg = createUserMessage('Important message');
      processor.pushSignal(msg);

      const { deferred } = processor.processTick();
      expect(deferred).toHaveLength(1);
      expect(deferred[0].type).toBe('user_message');

      // Stress recovers
      processor.setCognitionEnabled(true);
      const { processed } = processor.processTick();
      expect(processed).toHaveLength(1);
      expect(processed[0].id).toBe(msg.id);
    });
  });

  describe('repeated deferral (no duplicate side effects)', () => {
    it('should not duplicate signals across multiple deferred ticks', () => {
      processor.setCognitionEnabled(false);

      const msg = createUserMessage('Hello');
      processor.pushSignal(msg);

      // Tick 1: deferred
      processor.processTick();
      expect(processor.getPendingCount()).toBe(1);

      // Tick 2: still stressed, deferred again
      processor.processTick();
      expect(processor.getPendingCount()).toBe(1);

      // Tick 3: still stressed, deferred again
      processor.processTick();
      expect(processor.getPendingCount()).toBe(1);

      // Recover
      processor.setCognitionEnabled(true);
      const { processed } = processor.processTick();

      // Exactly one signal processed — no duplicates
      expect(processed).toHaveLength(1);
      expect(processed[0].id).toBe(msg.id);
      expect(processor.getPendingCount()).toBe(0);
    });

    it('should preserve FIFO order through multiple deferral ticks', () => {
      processor.setCognitionEnabled(false);

      const msg1 = createUserMessage('First');
      const msg2 = createUserMessage('Second');
      processor.pushSignal(msg1);
      processor.pushSignal(msg2);

      // Deferred once
      processor.processTick();

      // New message arrives while stressed
      const msg3 = createUserMessage('Third');
      processor.pushSignal(msg3);

      // Deferred again — now 3 in queue
      processor.processTick();
      expect(processor.getPendingCount()).toBe(3);

      // Recover
      processor.setCognitionEnabled(true);
      const { processed } = processor.processTick();

      expect(processed).toHaveLength(3);
      expect(processed[0].id).toBe(msg1.id);
      expect(processed[1].id).toBe(msg2.id);
      expect(processed[2].id).toBe(msg3.id);
    });
  });

  describe('cognition busy vs stress interaction', () => {
    it('should defer when cognition is busy (not stress)', () => {
      processor.setCognitionBusy(true);
      processor.setCognitionEnabled(true);

      const msg = createUserMessage('Hello');
      processor.pushSignal(msg);

      const { deferred } = processor.processTick();
      expect(deferred).toHaveLength(1);
    });

    it('should defer when both busy and stressed', () => {
      processor.setCognitionBusy(true);
      processor.setCognitionEnabled(false);

      const msg = createUserMessage('Hello');
      processor.pushSignal(msg);

      const { deferred } = processor.processTick();
      expect(deferred).toHaveLength(1);
    });

    it('should NOT defer when cognition is free and enabled', () => {
      processor.setCognitionBusy(false);
      processor.setCognitionEnabled(true);

      const msg = createUserMessage('Hello');
      processor.pushSignal(msg);

      const { processed, deferred } = processor.processTick();
      expect(processed).toHaveLength(1);
      expect(deferred).toHaveLength(0);
    });
  });
});
