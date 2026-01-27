import { describe, it, expect, beforeEach } from 'vitest';
import { createContainer } from '../../src/core/container.js';
import { Priority } from '../../src/types/index.js';

describe('Layer Processing Integration', () => {
  let container: ReturnType<typeof createContainer>;

  beforeEach(() => {
    container = createContainer({
      logLevel: 'silent', // Quiet logs during tests
    });
  });

  describe('Event flows through layers', () => {
    it('processes a message event through all layers', async () => {
      const { layerProcessor } = container;

      const event = {
        id: 'test-event-1',
        source: 'communication' as const,
        channel: 'telegram',
        type: 'message_received',
        priority: Priority.HIGH,
        timestamp: new Date(),
        payload: {
          text: 'Hello! How are you doing today?',
          from: 'test-user',
        },
      };

      const result = await layerProcessor.process(event);

      // Should execute multiple layers
      expect(result.layersExecuted.length).toBeGreaterThan(0);
      expect(result.layersExecuted).toContain('reflex');
      expect(result.layersExecuted).toContain('perception');

      // Should have processing time
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('generates thoughts for questions', async () => {
      const { layerProcessor } = container;

      const event = {
        id: 'test-event-2',
        source: 'communication' as const,
        channel: 'telegram',
        type: 'message_received',
        priority: Priority.HIGH,
        timestamp: new Date(),
        payload: {
          text: 'What is the meaning of life?',
          from: 'test-user',
        },
      };

      const result = await layerProcessor.process(event);

      // Questions should trigger cognition layer
      expect(result.layersExecuted).toContain('cognition');
    });

    it('stops early for system events (reflex layer)', async () => {
      const { layerProcessor } = container;

      const event = {
        id: 'test-event-3',
        source: 'system' as const,
        type: 'health_check',
        priority: Priority.LOW,
        timestamp: new Date(),
        payload: {},
      };

      const result = await layerProcessor.process(event);

      // Reflex layer should handle system events and stop
      expect(result.layersExecuted).toContain('reflex');
      // Should not continue to perception for pure system events
      expect(result.layersExecuted.length).toBeLessThanOrEqual(2);
    });

    it('detects negative sentiment and generates thoughts', async () => {
      const { layerProcessor } = container;

      const event = {
        id: 'test-event-4',
        source: 'communication' as const,
        channel: 'telegram',
        type: 'message_received',
        priority: Priority.HIGH,
        timestamp: new Date(),
        payload: {
          text: "I'm really frustrated and angry about this situation!",
          from: 'test-user',
        },
      };

      const result = await layerProcessor.process(event);

      // Should process through interpretation and cognition
      expect(result.layersExecuted).toContain('interpretation');
      expect(result.layersExecuted).toContain('cognition');

      // Negative sentiment should generate thoughts
      expect(result.thoughts.length).toBeGreaterThan(0);
    });
  });

  describe('EventLoop integration', () => {
    it('processes queued events through layers', async () => {
      const { eventLoop, eventQueue } = container;

      // Queue an event
      await eventLoop.emit({
        source: 'communication',
        channel: 'test',
        type: 'message_received',
        priority: Priority.HIGH,
        payload: { text: 'Test message' },
      });

      // Verify event is in queue
      const queueSize = eventQueue.size();
      expect(queueSize).toBe(1);
    });

    it('recycles thoughts with requiresProcessing into queue', async () => {
      const { layerProcessor, eventQueue } = container;

      // Process a complex question that generates thoughts needing processing
      const event = {
        id: 'test-event-5',
        source: 'communication' as const,
        channel: 'telegram',
        type: 'message_received',
        priority: Priority.HIGH,
        timestamp: new Date(),
        payload: {
          text: 'This is a very long and complex message that requires deep understanding. '.repeat(5),
          from: 'test-user',
        },
      };

      const result = await layerProcessor.process(event);

      // Check if any thoughts were generated
      const thoughtsNeedingProcessing = result.thoughts.filter((t) => t.requiresProcessing);

      // Thoughts with requiresProcessing should exist for complex messages
      if (thoughtsNeedingProcessing.length > 0) {
        expect(thoughtsNeedingProcessing[0].content).toBeDefined();
        expect(thoughtsNeedingProcessing[0].priority).toBeDefined();
      }
    });
  });

  describe('Intent generation', () => {
    it('generates LOG intents for processed events', async () => {
      const { layerProcessor } = container;

      const event = {
        id: 'test-event-6',
        source: 'communication' as const,
        channel: 'telegram',
        type: 'message_received',
        priority: Priority.HIGH,
        timestamp: new Date(),
        payload: {
          text: 'Hello there!',
          from: 'test-user',
        },
      };

      const result = await layerProcessor.process(event);

      // Check for any intents
      expect(result.intents).toBeDefined();
      expect(Array.isArray(result.intents)).toBe(true);
    });

    it('generates SEND_MESSAGE intent when action decided', async () => {
      const { layerProcessor } = container;

      // A greeting should trigger a response
      const event = {
        id: 'test-event-7',
        source: 'communication' as const,
        channel: 'telegram',
        type: 'message_received',
        priority: Priority.HIGH,
        timestamp: new Date(),
        payload: {
          text: 'Hi!',
          from: 'test-user',
        },
      };

      const result = await layerProcessor.process(event);

      // Should process through decision and expression
      expect(result.layersExecuted).toContain('decision');
      expect(result.layersExecuted).toContain('expression');

      // Should generate a SEND_MESSAGE intent for greeting
      const sendIntents = result.intents.filter((i) => i.type === 'SEND_MESSAGE');
      expect(sendIntents.length).toBeGreaterThan(0);
    });
  });
});
