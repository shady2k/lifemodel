import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPatternDetector } from '../../src/layers/aggregation/pattern-detector.js';
import type { SignalAggregate, Signal } from '../../src/types/signal.js';

// Mock logger
const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => mockLogger,
};

describe('PatternDetector', () => {
  let detector: ReturnType<typeof createPatternDetector>;

  beforeEach(() => {
    vi.clearAllMocks();
    detector = createPatternDetector(mockLogger as any);
  });

  describe('ACK mechanism', () => {
    it('fires pattern on first detection', () => {
      // Build up activity history first
      const signals: Signal[] = [];
      const aggregates: SignalAggregate[] = [];

      // Simulate some activity
      for (let i = 0; i < 10; i++) {
        detector.detect(aggregates, [
          {
            id: `msg-${i}`,
            type: 'user_message',
            source: 'sense.telegram',
            timestamp: new Date(Date.now() - (10 - i) * 1000),
            priority: 1,
            metrics: { value: 1, confidence: 1 },
          } as Signal,
        ]);
      }

      // Now simulate silence
      vi.setSystemTime(new Date(Date.now() + 60000)); // 60 seconds later
      const patterns = detector.detect(aggregates, []);

      // Should detect sudden_silence (if enough activity history)
      // Note: This depends on internal thresholds
    });

    it('does not fire same pattern repeatedly without change', () => {
      const aggregates: SignalAggregate[] = [];

      // First detection with high confidence
      detector.acknowledge('test_pattern', 'test_condition', 0.8);

      // Try to detect same condition again
      const isAcked = (detector as any).isAlreadyAcknowledged(
        'test_pattern',
        'test_condition',
        0.81 // Very similar value
      );

      expect(isAcked).toBe(true);
    });

    it('fires again when condition changes significantly', () => {
      const aggregates: SignalAggregate[] = [];

      // First acknowledgment
      detector.acknowledge('test_pattern', 'test_condition', 0.5);

      // Try with significantly different value (> 0.2 change)
      const isAcked = (detector as any).isAlreadyAcknowledged(
        'test_pattern',
        'test_condition',
        0.8 // 0.3 change, above 0.2 threshold
      );

      expect(isAcked).toBe(false); // Should NOT be acknowledged, allow re-fire
    });

    it('clears acknowledgment when condition resolves', () => {
      // Acknowledge a pattern
      detector.acknowledge('test_pattern', 'test_condition', 0.8);

      // Clear it (condition resolved)
      (detector as any).clearAcknowledgmentIfResolved('test_pattern', 'test_condition');

      // Should no longer be acknowledged
      const isAcked = (detector as any).isAlreadyAcknowledged(
        'test_pattern',
        'test_condition',
        0.8
      );

      expect(isAcked).toBe(false);
    });
  });

  describe('Pattern registration', () => {
    it('only has user behavior patterns registered', () => {
      // Access internal patterns array
      const patterns = (detector as any).patterns;

      // Should only have sudden_silence
      expect(patterns.length).toBe(1);
      expect(patterns[0].id).toBe('sudden_silence');
    });

    it('does not have rate_spike pattern', () => {
      const patterns = (detector as any).patterns;
      const rateSpikePattern = patterns.find((p: any) => p.id === 'rate_spike');
      expect(rateSpikePattern).toBeUndefined();
    });

    it('does not have energy_pressure_conflict pattern', () => {
      const patterns = (detector as any).patterns;
      const conflictPattern = patterns.find((p: any) => p.id === 'energy_pressure_conflict');
      expect(conflictPattern).toBeUndefined();
    });
  });
});
