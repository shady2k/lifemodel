import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/ci-web-provenance-paths.sh', import.meta.url));
const producer = fileURLToPath(new URL('../../scripts/ci-product-paths.sh', import.meta.url));
function selectProducerOutput(...paths: string[]): string {
  const output = execFileSync('sh', [producer], {
    input: `${paths.join('\n')}\n`,
    encoding: 'utf8',
  });
  expect(output).toMatch(/product=(?:true|false)\n$/);
  return execFileSync('sh', [script], { input: output, encoding: 'utf8' }).trim();
}

describe('web provenance CI path classification', () => {
  it.each([
    ['component-only', ['web/kit/components/ui/button.tsx']],
    ['theme-only', ['web/kit/theme.css']],
    ['lock-only', ['web/kit/registry-lock/manifest.json']],
    ['generator-only', ['scripts/shadcn-add.sh']],
    ['app-only', ['web/app/src/App.tsx']],
    ['root Vitest config', ['vitest.config.ts']],
  ])('%s selects provenance through the producer contract', (_name, changed) => {
    expect(selectProducerOutput(...changed)).toBe('web_app=true');
  });
  it('does not select provenance for unrelated changes through the producer contract', () => {
    expect(selectProducerOutput('src/core/agent.ts', 'docs/architecture.md')).toBe('web_app=false');
  });
  it('does not select provenance for a docs-only change', () => {
    expect(selectProducerOutput('docs/architecture.md', 'README.md')).toBe('web_app=false');
  });
  it('selects provenance when the producer supplies no changed-path records', () => {
    // No records: no path was readable, so no path is evidence of safety —
    // the same rule the producer applies to its own empty input.
    expect(selectProducerOutput()).toBe('web_app=true');
  });
  it('selects provenance for the unknown-range fallback the workflow runs', () => {
    const workflow = readFileSync(
      fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)),
      'utf8'
    );
    // The no-range branch writes the producer's output to the same file the
    // selector reads, so what the fallback writes is exactly what the selector
    // must classify.
    expect(workflow).toContain('scripts/ci-product-paths.sh < /dev/null > "$out"');
    expect(workflow).toContain('scripts/ci-web-provenance-paths.sh < "$out" >> "$GITHUB_OUTPUT"');
    // The real producer on no input — what the fallback writes — carries no
    // records and a product verdict, and the real selector answers true on it.
    const fallback = execFileSync('sh', [producer], { input: '', encoding: 'utf8' });
    expect(fallback).not.toMatch(/^changed: /m);
    expect(fallback).toMatch(/product=true\n$/);
    expect(execFileSync('sh', [script], { input: fallback, encoding: 'utf8' }).trim()).toBe(
      'web_app=true'
    );
  });
  it('keeps the workflow producer-to-selector command contract intact', () => {
    const workflow = readFileSync(
      fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)),
      'utf8'
    );
    expect(workflow).toContain('scripts/ci-changed-paths.sh "$range" > "$out"');
    expect(workflow).toContain('scripts/ci-product-paths.sh < /dev/null > "$out"');
    expect(workflow).toContain('scripts/ci-web-provenance-paths.sh < "$out" >> "$GITHUB_OUTPUT"');
  });
});
