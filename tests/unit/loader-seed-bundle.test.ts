import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('loader image release seed bundle', () => {
  it('prepares the full-history bundle before the release workflow builds the loader', async () => {
    const workflow = await readFile('.github/workflows/release.yml', 'utf8');
    const prepare = workflow.indexOf('scripts/release/prepare-loader-context.sh');
    const build = workflow.indexOf('file: docker/loader/Dockerfile');
    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(build).toBeGreaterThan(prepare);
    expect(workflow.slice(prepare - 160, build)).toContain(
      'run: scripts/release/prepare-loader-context.sh'
    );
  });

  it('lets the prepared bundle into the loader image and shares bundle creation with the instance builder', async () => {
    const dockerfile = await readFile('docker/loader/Dockerfile', 'utf8');
    const ignore = await readFile('.dockerignore', 'utf8');
    const instanceBuilder = await readFile('scripts/build-image.sh', 'utf8');
    const prepareScript = await readFile('scripts/release/prepare-loader-context.sh', 'utf8');
    expect(dockerfile).toContain(
      'COPY --chown=root:root .docker-context/seed.bundle /opt/lifemodel/seed.bundle'
    );
    expect(ignore).toContain('!.docker-context');
    expect(ignore).toContain('!.docker-context/**');
    expect(instanceBuilder).toContain('scripts/release/prepare-loader-context.sh');
    expect(prepareScript).toContain('git bundle create "$context/seed.bundle" HEAD');
    expect(prepareScript).toContain('git bundle verify "$context/seed.bundle"');
  });
});
