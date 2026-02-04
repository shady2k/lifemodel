/**
 * Tests for TraceContext - AsyncLocalStorage-based causal chain tracking.
 */

import { describe, it, expect } from 'vitest';
import {
  withTraceContext,
  createTraceContext,
  getTraceContext,
  generateChildSpan,
  extractTraceFromIntent,
  type TraceContext,
} from '../../src/core/trace-context.js';

describe('TraceContext', () => {
  describe('Context propagation', () => {
    it('propagates context through async boundaries', async () => {
      const ctx = createTraceContext('test-trace-1');
      let capturedContext: TraceContext | undefined;

      await withTraceContext(ctx, async () => {
        // Should be available in the same async scope
        expect(getTraceContext()).toEqual(ctx);

        await Promise.all([
          Promise.resolve().then(() => {
            capturedContext = getTraceContext();
          }),
          new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
            expect(getTraceContext()?.traceId).toBe('test-trace-1');
          }),
        ]);
      });

      // Context should have been captured in the promise chain
      expect(capturedContext).toEqual(ctx);
    });

    it('propagates context through nested async functions', async () => {
      const ctx = createTraceContext('test-trace-2');
      const results: string[] = [];

      const innerAsync = async () => {
        const current = getTraceContext();
        results.push(current?.traceId ?? 'no-context');
      };

      await withTraceContext(ctx, async () => {
        await innerAsync();
        await Promise.all([innerAsync(), innerAsync()]);
      });

      expect(results).toEqual(['test-trace-2', 'test-trace-2', 'test-trace-2']);
    });

    it('context is undefined outside withTraceContext', () => {
      expect(getTraceContext()).toBeUndefined();
    });

    it('context is cleared after withTraceContext completes', async () => {
      const ctx = createTraceContext('test-trace-3');

      await withTraceContext(ctx, async () => {
        expect(getTraceContext()?.traceId).toBe('test-trace-3');
      });

      expect(getTraceContext()).toBeUndefined();
    });
  });

  describe('Nested contexts', () => {
    it('nested contexts override parent', async () => {
      const parentCtx = createTraceContext('parent');
      const childCtx = createTraceContext('child', { parentId: parentCtx.traceId });

      await withTraceContext(parentCtx, async () => {
        expect(getTraceContext()?.traceId).toBe('parent');

        await withTraceContext(childCtx, async () => {
          expect(getTraceContext()?.traceId).toBe('child');
          expect(getTraceContext()?.parentId).toBe('parent');
        });

        // After child context exits, parent is restored
        expect(getTraceContext()?.traceId).toBe('parent');
      });
    });

    it('supports multiple levels of nesting', async () => {
      const level1 = createTraceContext('level1');
      const level2 = createTraceContext('level2', { parentId: 'level1' });
      const level3 = createTraceContext('level3', { parentId: 'level2' });

      const traceIds: string[] = [];

      await withTraceContext(level1, async () => {
        traceIds.push(getTraceContext()?.traceId ?? 'none');

        await withTraceContext(level2, async () => {
          traceIds.push(getTraceContext()?.traceId ?? 'none');

          await withTraceContext(level3, async () => {
            traceIds.push(getTraceContext()?.traceId ?? 'none');
          });

          traceIds.push(getTraceContext()?.traceId ?? 'none');
        });

        traceIds.push(getTraceContext()?.traceId ?? 'none');
      });

      expect(traceIds).toEqual(['level1', 'level2', 'level3', 'level2', 'level1']);
    });
  });

  describe('createTraceContext', () => {
    it('creates context with traceId and spanId', () => {
      const ctx = createTraceContext('test-id');

      expect(ctx.traceId).toBe('test-id');
      expect(ctx.spanId).toBeDefined();
      expect(ctx.spanId).toMatch(/^root_[a-z0-9]{8}$/);
    });

    it('creates context with correlationId', () => {
      const ctx = createTraceContext('test-id', { correlationId: 'corr-123' });

      expect(ctx.traceId).toBe('test-id');
      expect(ctx.correlationId).toBe('corr-123');
    });

    it('creates context with parentId', () => {
      const ctx = createTraceContext('test-id', { parentId: 'parent-abc' });

      expect(ctx.traceId).toBe('test-id');
      expect(ctx.parentId).toBe('parent-abc');
    });

    it('creates context with all optional fields', () => {
      const ctx = createTraceContext('test-id', {
        correlationId: 'corr-123',
        parentId: 'parent-abc',
      });

      expect(ctx.traceId).toBe('test-id');
      expect(ctx.correlationId).toBe('corr-123');
      expect(ctx.parentId).toBe('parent-abc');
      expect(ctx.spanId).toBeDefined();
    });
  });

  describe('generateChildSpan', () => {
    it('generates root span without parent', () => {
      const span = generateChildSpan();

      expect(span).toMatch(/^root_[a-z0-9]{8}$/);
    });

    it('generates child span with parent', () => {
      const parent = 'root_abc12345';
      const child = generateChildSpan(parent);

      expect(child).toMatch(/^root_abc12345_[a-z0-9]{8}$/);
    });

    it('generates unique spans', () => {
      const spans = new Set();

      for (let i = 0; i < 100; i++) {
        spans.add(generateChildSpan());
      }

      expect(spans.size).toBe(100);
    });
  });

  describe('extractTraceFromIntent', () => {
    it('extracts tickId and parentSignalId from intent trace', () => {
      const intent = {
        trace: {
          tickId: 'tick-123',
          parentSignalId: 'sig-456',
        },
      };

      const result = extractTraceFromIntent(intent);

      expect(result).toEqual({
        correlationId: 'tick-123',
        parentId: 'sig-456',
      });
    });

    it('extracts only tickId when parentSignalId is missing', () => {
      const intent = {
        trace: {
          tickId: 'tick-123',
        },
      };

      const result = extractTraceFromIntent(intent);

      expect(result).toEqual({
        correlationId: 'tick-123',
      });
    });

    it('extracts only parentSignalId when tickId is missing', () => {
      const intent = {
        trace: {
          parentSignalId: 'sig-456',
        },
      };

      const result = extractTraceFromIntent(intent);

      expect(result).toEqual({
        parentId: 'sig-456',
      });
    });

    it('returns undefined when intent has no trace', () => {
      const intent = {};

      const result = extractTraceFromIntent(intent);

      expect(result).toBeUndefined();
    });

    it('returns undefined when intent.trace is empty', () => {
      const intent = {
        trace: {},
      };

      const result = extractTraceFromIntent(intent);

      expect(result).toBeUndefined();
    });

    it('returns undefined when intent is undefined', () => {
      const result = extractTraceFromIntent(undefined);

      expect(result).toBeUndefined();
    });
  });

  describe('Real-world scenarios', () => {
    it('simulates signal processing trace chain', async () => {
      const tickId = 'tick-001';
      const signalId = 'sig-123';
      const intentId = 'intent-456';

      const logs: string[] = [];

      // Tick level
      await withTraceContext(createTraceContext(tickId), async () => {
        logs.push(`tick: ${getTraceContext()?.traceId}`);

        // Signal processing
        await withTraceContext(
          createTraceContext(signalId, { correlationId: tickId }),
          async () => {
            logs.push(`signal: ${getTraceContext()?.traceId}, corr: ${getTraceContext()?.correlationId}`);

            // Intent execution
            await withTraceContext(
              createTraceContext(intentId, {
                correlationId: tickId,
                parentId: signalId,
              }),
              async () => {
                logs.push(
                  `intent: ${getTraceContext()?.traceId}, corr: ${getTraceContext()?.correlationId}, parent: ${getTraceContext()?.parentId}`
                );
              }
            );
          }
        );
      });

      expect(logs).toEqual([
        'tick: tick-001',
        'signal: sig-123, corr: tick-001',
        'intent: intent-456, corr: tick-001, parent: sig-123',
      ]);
    });

    it('handles concurrent operations with different contexts', async () => {
      const logs: string[] = [];

      const processSignal = async (signalId: string, correlationId: string) => {
        await withTraceContext(createTraceContext(signalId, { correlationId }), async () => {
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
          logs.push(`${getTraceContext()?.traceId} (${getTraceContext()?.correlationId})`);
        });
      };

      // Process multiple signals concurrently
      await Promise.all([
        processSignal('sig-1', 'tick-001'),
        processSignal('sig-2', 'tick-001'),
        processSignal('sig-3', 'tick-001'),
      ]);

      expect(logs).toHaveLength(3);
      expect(logs.every((log) => log.includes('tick-001'))).toBe(true);
      expect(logs.some((log) => log.includes('sig-1'))).toBe(true);
      expect(logs.some((log) => log.includes('sig-2'))).toBe(true);
      expect(logs.some((log) => log.includes('sig-3'))).toBe(true);
    });
  });
});
