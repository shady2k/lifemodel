import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

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
  it.each(['loader', 'workbench'] as const)('round2: shared helper selects %s image', (image) => {
    const selector = fileURLToPath(new URL(`../../scripts/ci-${image}-paths.sh`, import.meta.url));
    for (const path of [
      'src/ports/task-transcript-bounds.mjs',
      'src/ports/task-transcript-bounds.d.mts',
    ])
      expect(
        execFileSync('sh', [selector], {
          input: `changed: ${path}\nproduct=true\n`,
          encoding: 'utf8',
        }).trim()
      ).toBe(`${image}_image=true`);
  });
  it.each([
    ['the loader program', ['loader/src/main.ts']],
    ['the loader UI', ['web/loader/src/app.tsx']],
    ['the shared UI kit the Dockerfile copies', ['web/kit/components/ui/button.tsx']],
    ['the Dockerfile itself', ['docker/loader/Dockerfile']],
    ['the runtime smoke command', ['scripts/smoke-image-modules.sh']],
    ['the image workflow', ['.github/workflows/ci.yml']],
    ['the context filter Docker reads when it assembles the build context', ['.dockerignore']],
    [
      'the release tree the seed bundle carries',
      ['deploy/platform/applications/lifemodel/kustomization.yaml'],
    ],
    ['the context script the job runs', ['scripts/release/prepare-loader-context.sh']],
    ['a digest pinner the job calls', ['scripts/release/set-core-digest.sh']],
    ['a wire file the Dockerfile copies into the UI build', ['src/web/contract.ts']],
    ['the attachment metadata type the wire contract imports', ['src/ports/message-attachment.ts']],
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
  it('selects the loader image when the producer supplies no changed-path records', () => {
    // No records: no path was readable, so no path is evidence of safety —
    // the same rule the producer applies to its own empty input.
    expect(selectProducerOutput()).toBe('loader_image=true');
  });
  it('selects the loader image for the unknown-range fallback the workflow runs', () => {
    const workflow = readFileSync(
      fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)),
      'utf8'
    );
    // The no-range branch writes the producer's output to the same file the
    // selector reads, so what the fallback writes is exactly what the selector
    // must classify.
    expect(workflow).toContain('scripts/ci-product-paths.sh < /dev/null > "$out"');
    expect(workflow).toContain('scripts/ci-loader-paths.sh < "$out" >> "$GITHUB_OUTPUT"');
    // The real producer on no input — what the fallback writes — carries no
    // records and a product verdict, and the real selector answers true on it.
    const fallback = execFileSync('sh', [producer], { input: '', encoding: 'utf8' });
    expect(fallback).not.toMatch(/^changed: /m);
    expect(fallback).toMatch(/product=true\n$/);
    expect(execFileSync('sh', [script], { input: fallback, encoding: 'utf8' }).trim()).toBe(
      'loader_image=true'
    );
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
  it('prepares the unpublished loader build without requiring release workbench pins', () => {
    const workflow = YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
    const steps = workflow.jobs['ci-loader-image'].steps;
    const prepare = steps.find(
      (step: { name?: string }) => step.name === 'Prepare the full-history loader seed bundle'
    );
    expect(prepare.run).toBe('scripts/release/prepare-loader-context.sh');
    const dummy = steps.find(
      (step: { name?: string }) => step.name === 'Pin dummy digests for this build only'
    );
    expect(dummy.run).toContain('scripts/release/set-core-digest.sh');
    expect(dummy.run).toContain('scripts/release/set-web-digest.sh');
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
