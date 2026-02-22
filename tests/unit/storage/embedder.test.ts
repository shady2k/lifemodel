/**
 * Tests for the Embedder service.
 *
 * These tests load the real ONNX model (~50MB download on first run).
 * Opt-in only: set RUN_EMBEDDER_TESTS=true to run.
 */

import { describe, it, expect } from 'vitest';
import { createEmbedder } from '../../../src/storage/embedder.js';

// Skip unless explicitly opted in — these download a ~50MB model and are slow
const SKIP = process.env['RUN_EMBEDDER_TESTS'] !== 'true';

describe.skipIf(SKIP)('Embedder (real model)', () => {
  const embedder = createEmbedder({ cacheDir: 'data/models' });

  it('produces 384-dimensional output', async () => {
    const vec = await embedder.embed('Hello world');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(384);
  }, 30000);

  it('returns normalized vectors', async () => {
    const vec = await embedder.embed('Test normalization');
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 2);
  }, 15000);

  it('is deterministic', async () => {
    const vec1 = await embedder.embed('Deterministic test');
    const vec2 = await embedder.embed('Deterministic test');
    expect(Array.from(vec1)).toEqual(Array.from(vec2));
  }, 15000);

  it('batch produces consistent results', async () => {
    const single = await embedder.embed('Batch test');
    const batch = await embedder.embedBatch(['Batch test', 'Other text']);
    expect(Array.from(batch[0]!)).toEqual(Array.from(single));
    expect(batch[1]!.length).toBe(384);
  }, 15000);

  it('embeds Russian text with same dimensionality', async () => {
    const vec = await embedder.embed('Привет мир');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(384);
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 2);
  }, 15000);

  it('reports dimensions as 384', () => {
    expect(embedder.dimensions()).toBe(384);
  });
});
