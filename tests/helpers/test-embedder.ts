import type { Embedder } from '../../src/storage/embedder.js';

/** Deterministic sparse embeddings for store tests; production uses the ONNX embedder. */
export function createTestEmbedder(): Embedder {
  const embed = (text: string): Float32Array => {
    const vector = new Float32Array(384);
    for (const token of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      let hash = 2166136261;
      for (const character of token) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
      const index = (hash >>> 0) % vector.length;
      vector[index] += 1;
    }
    const norm = Math.hypot(...vector);
    if (norm > 0) for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    return vector;
  };
  return {
    embed: async (text) => embed(text),
    embedBatch: async (texts) => texts.map(embed),
    dimensions: () => 384,
  };
}
