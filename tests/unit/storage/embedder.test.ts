import { afterEach, describe, expect, it, vi } from 'vitest';

const { modelEnv, remoteAttempt, pipeline } = vi.hoisted(() => {
  const modelEnv: Record<string, unknown> = {
    cacheDir: '/dev/default-cache',
    allowLocalModels: true,
    allowRemoteModels: true,
  };
  const remoteAttempt = vi.fn();
  const pipeline = vi.fn(async () => {
    if (modelEnv['allowRemoteModels']) remoteAttempt();
    return async () => ({ data: [1, 0] });
  });
  return { modelEnv, remoteAttempt, pipeline };
});

vi.mock('@huggingface/transformers', () => ({ env: modelEnv, pipeline }));

import { createEmbedder } from '../../../src/storage/embedder.js';

describe('embedder configured with a baked model directory', () => {
  const originalModelDir = process.env['LIFEMODEL_MODEL_DIR'];

  afterEach(() => {
    if (originalModelDir === undefined) delete process.env['LIFEMODEL_MODEL_DIR'];
    else process.env['LIFEMODEL_MODEL_DIR'] = originalModelDir;
    modelEnv['cacheDir'] = '/dev/default-cache';
    modelEnv['allowLocalModels'] = true;
    modelEnv['allowRemoteModels'] = true;
    pipeline.mockClear();
    remoteAttempt.mockClear();
  });

  it('uses the explicit directory and does not attempt a remote model download', async () => {
    process.env['LIFEMODEL_MODEL_DIR'] = '/opt/model-cache';

    const embedder = createEmbedder();
    await expect(embedder.embed('test')).resolves.toEqual(new Float32Array([1, 0]));

    expect(modelEnv['cacheDir']).toBe('/opt/model-cache');
    expect(modelEnv['allowRemoteModels']).toBe(false);
    expect(pipeline).toHaveBeenCalledOnce();
    expect(remoteAttempt).not.toHaveBeenCalled();
  });
});
