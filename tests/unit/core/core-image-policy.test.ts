import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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

  it('assembles every core Dockerfile COPY source and release uses that context', () => {
    const directory = mkdtempSync(join(tmpdir(), 'core-image-context-'));
    const context = join(directory, 'context');
    try {
      const prepare = spawnSync(
        'sh',
        [
          fileURLToPath(new URL('../../../scripts/prepare-core-image-context.sh', import.meta.url)),
          context,
        ],
        { encoding: 'utf8' }
      );
      expect(prepare.status, prepare.stderr).toBe(0);
      const copySources = [...dockerfile.matchAll(/^COPY (?!\s*--from=)(?:--[^ ]+\s+)*(.+)$/gm)]
        .flatMap((match) => match[1].split(/\s+/).slice(0, -1))
        .filter((source) => !source.startsWith('--'));
      for (const source of copySources) {
        expect(existsSync(join(context, source)), source).toBe(true);
      }
      const workflow = readFileSync(`${root}/.github/workflows/release.yml`, 'utf8');
      expect(workflow).toContain('scripts/prepare-core-image-context.sh .docker-core-context');
      expect(workflow).toContain('context: .docker-core-context');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('installs only the WebAssembly sharp build for CPU-v1-compatible embedding', () => {
    expect(dockerfile).toContain('npm install --omit=dev --no-save --cpu=wasm32 sharp');
    expect(dockerfile).toMatch(/rm -rf[^\n]*@img\/sharp-linux-x64/);
    expect(dockerfile).toMatch(/rm -rf[^\n]*@img\/sharp-libvips-linux-x64/);
  });

  it('bakes the embedder model into the image at a stable path', () => {
    expect(dockerfile).toContain('Xenova/paraphrase-multilingual-MiniLM-L12-v2');
    expect(dockerfile).toContain('/opt/model-cache');
  });
});
