import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('loader image git runtime dependency', () => {
  it('installs git in the runtime stage', async () => {
    const dockerfile = await readFile('docker/loader/Dockerfile', 'utf8');
    const buildStage = dockerfile.indexOf('AS build');
    const runtimeStart = dockerfile.indexOf('FROM ${NODE_IMAGE}', buildStage);
    const runtime = runtimeStart < 0 ? undefined : dockerfile.slice(runtimeStart);
    expect(runtime, 'runtime stage must exist').toBeDefined();
    expect(runtime).toMatch(/apt-get install[^\n]*\bgit\b/);
  });
});
