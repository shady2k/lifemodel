import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const dockerfile = readFileSync(`${root}/docker/core/Dockerfile`, 'utf8');
const entrypoint = readFileSync(`${root}/docker/core/entrypoint.sh`, 'utf8');
const buildScript = readFileSync(`${root}/scripts/build-core-image.sh`, 'utf8');

describe('core image policy', () => {
  it('runs as non-root with only /tmp as the writable runtime location', () => {
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toContain('DATA_PATH=/tmp/lifemodel');
    expect(dockerfile).toContain('COPY --from=model /opt/model-cache');
    expect(dockerfile).toContain('.npmrc');
    expect(dockerfile).toContain('LIFEMODEL_MODEL_DIR=/opt/model-cache');
    expect(entrypoint).not.toMatch(/(mkdir|cp).*model|DATA_PATH\/models/);
    expect(entrypoint).toContain('exec node /opt/lifemodel/dist/index.js');
    expect(dockerfile).not.toMatch(/(loader|caddy|seed\.bundle)/i);
  });

  it('has a build-only script with the documented image default and tag arguments', () => {
    expect(buildScript).toContain('LIFEMODEL_CORE_IMAGE:-ghcr.io/shady2k/lifemodel-core');
    expect(buildScript).toContain('docker build');
    expect(buildScript).not.toContain('docker push');
    expect(buildScript).toContain('--tag \"$image:$tag\"');
  });

  it('bakes the embedder model into the image at a stable path', () => {
    expect(dockerfile).toContain('Xenova/paraphrase-multilingual-MiniLM-L12-v2');
    expect(dockerfile).toContain('/opt/model-cache');
  });
});
