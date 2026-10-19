import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/ci-loader-paths.sh', import.meta.url));
const producer = fileURLToPath(new URL('../../scripts/ci-product-paths.sh', import.meta.url));
function selectProducerOutput(...paths: string[]): string {
  const output = execFileSync('sh', [producer], {
    input: `${paths.join('\n')}\n`,
    encoding: 'utf8',
  });
  expect(output).toMatch(/product=(?:true|false)\n$/);
  return execFileSync('sh', [script], { input: output, encoding: 'utf8' }).trim();
}

describe('loader image CI path classification', () => {
  it.each([
    ['the loader program', ['loader/src/main.ts']],
    ['the loader UI', ['web/loader/src/app.tsx']],
    ['the shared UI kit the Dockerfile copies', ['web/kit/components/ui/button.tsx']],
    ['the Dockerfile itself', ['docker/loader/Dockerfile']],
    [
      'the release tree the seed bundle carries',
      ['deploy/platform/applications/lifemodel/kustomization.yaml'],
    ],
    ['the context script the job runs', ['scripts/release/prepare-loader-context.sh']],
    ['a digest pinner the job calls', ['scripts/release/set-core-digest.sh']],
    ['a wire file the Dockerfile copies into the UI build', ['src/web/contract.ts']],
    ['the root manifest the UI build installs and runs from', ['package.json']],
    ['the root lockfile the UI build installs from', ['package-lock.json']],
  ])('%s selects the loader image through the producer contract', (_name, changed) => {
    expect(selectProducerOutput(...changed)).toBe('loader_image=true');
  });
  it('does not select the loader image for a docs-only change', () => {
    expect(selectProducerOutput('docs/architecture.md', 'README.md')).toBe('loader_image=false');
  });
  it('does not select the loader image for loader-unrelated product changes', () => {
    expect(
      selectProducerOutput('src/core/agent.ts', 'web/app/src/App.tsx', 'tests/a.test.ts')
    ).toBe('loader_image=false');
  });
  it('does not select the loader image for another image build script', () => {
    expect(selectProducerOutput('scripts/build-core-image.sh', 'scripts/build-web-image.sh')).toBe(
      'loader_image=false'
    );
  });
  it('answers loader_image=false for an empty change', () => {
    expect(selectProducerOutput()).toBe('loader_image=false');
  });
  it('keeps the workflow producer-to-selector command contract intact', () => {
    const workflow = readFileSync(
      fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)),
      'utf8'
    );
    expect(workflow).toContain('scripts/ci-changed-paths.sh "$range" > "$out"');
    expect(workflow).toContain('scripts/ci-product-paths.sh < /dev/null > "$out"');
    expect(workflow).toContain('scripts/ci-loader-paths.sh < "$out" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain('loader_image: ${{ steps.classify.outputs.loader_image }}');
  });
  it('gates the ci-loader-image job on the selector verdict', () => {
    const workflow = readFileSync(
      fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)),
      'utf8'
    );
    expect(workflow).toContain('  ci-loader-image:');
    expect(workflow).toContain("needs.changes.outputs.loader_image == 'true'");
  });
});
