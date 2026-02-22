/**
 * Embedder — Local ONNX embedding via @huggingface/transformers.
 *
 * Wraps a feature-extraction pipeline to produce normalized 384-dim
 * Float32Array vectors for cosine similarity search.
 *
 * Lazy init: the ONNX model is loaded on first embed() call (1-3s cold start).
 * Model files are cached in the configured cacheDir (default: data/models/).
 */

export interface Embedder {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  dimensions(): number;
}

export interface EmbedderConfig {
  cacheDir?: string | undefined;
}

/** Model ID and dimensions are coupled — changing one requires changing the other. */
const MODEL_ID = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const DIMENSIONS = 384;

type PipelineLike = (
  text: string,
  options: { pooling: string; normalize: boolean }
) => Promise<{ data: ArrayLike<number> }>;

export function createEmbedder(config?: EmbedderConfig): Embedder {
  const cacheDir = config?.cacheDir;

  let pipelinePromise: Promise<PipelineLike> | null = null;

  function getPipeline(): Promise<PipelineLike> {
    pipelinePromise ??= (async (): Promise<PipelineLike> => {
      const { pipeline, env } = await import('@huggingface/transformers');
      if (cacheDir) {
        env.cacheDir = cacheDir;
      }
      env.allowLocalModels = true;
      const pipe = await pipeline('feature-extraction', MODEL_ID, {
        dtype: 'fp32',
      });
      return pipe as unknown as PipelineLike;
    })();
    return pipelinePromise;
  }

  async function embed(text: string): Promise<Float32Array> {
    const pipe = await getPipeline();
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    return new Float32Array(output.data);
  }

  async function embedBatch(texts: string[]): Promise<Float32Array[]> {
    const pipe = await getPipeline();
    const results: Float32Array[] = [];
    for (const text of texts) {
      const output = await pipe(text, { pooling: 'mean', normalize: true });
      results.push(new Float32Array(output.data));
    }
    return results;
  }

  return {
    embed,
    embedBatch,
    dimensions: () => DIMENSIONS,
  };
}
