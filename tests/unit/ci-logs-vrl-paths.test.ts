import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/ci-logs-vrl-paths.sh', import.meta.url));
const producer = fileURLToPath(new URL('../../scripts/ci-product-paths.sh', import.meta.url));
function selectProducerOutput(...paths: string[]): string {
  const output = execFileSync('sh', [producer], {
    input: `${paths.join('\n')}\n`,
    encoding: 'utf8',
  });
  expect(output).toMatch(/product=(?:true|false)\n$/);
  return execFileSync('sh', [script], { input: output, encoding: 'utf8' }).trim();
}

describe('collector record-contract CI path classification', () => {
  it.each([
    [
      'the collector configuration whose remap program is the contract',
      ['deploy/platform/logs/config/vector.yaml'],
    ],
    ['the logger the record is written with', ['src/core/logger.ts']],
    ['the trace context that carries the turn conversation', ['src/core/trace-context.ts']],
    ['where the turn context is established', ['src/core/core-loop.ts']],
    ['the primary recipient the turn rule falls back to', ['src/core/globals.ts']],
    ['the cognition processor the seed drives', ['src/layers/cognition/processor.ts']],
    ['the turn conversation rule', ['src/layers/cognition/turn-context.ts']],
    ['the loader image logger', ['loader/src/logger.ts']],
    ['the loader image fatal line', ['loader/src/main.ts']],
    ['the check itself', ['scripts/check-logs-vrl.mjs']],
    ['the case builder', ['scripts/logs-record-shape.mjs']],
    ['the pinned binary runner', ['scripts/logs-vector-runner.mjs']],
    ['the real-logger seed harness', ['scripts/logs-vrl-real-loggers.mjs']],
    ['the heartbeat part of the check', ['scripts/logs-heartbeat-check.mjs']],
    ['the record contract fixtures', ['tests/fixtures/logs-vrl/cases.json']],
    ['the turn seed', ['tests/fixtures/logs-vrl/turn-record-lines.ts']],
    [
      'the container-shaped harness the turn seed starts',
      ['tests/helpers/core-loop-drain-harness.ts'],
    ],
    ['the check image', ['docker/logs-vrl/Dockerfile']],
    ["the logger's own dependency declaration", ['package.json']],
    ['the resolved dependency tree', ['package-lock.json']],
    ['the check image install policy', ['.npmrc']],
    ['the effect code the turn executes', ['src/core/intent-applicator.ts']],
    ['transitive source dependencies', ['src/models/user-model.ts']],
  ])('%s selects the check through the producer contract', (_name, changed) => {
    expect(selectProducerOutput(...changed)).toBe('logs_vrl_check=true');
  });
  it('does not select the check for a docs-only change', () => {
    expect(selectProducerOutput('docs/architecture.md', 'README.md')).toBe('logs_vrl_check=false');
  });
  it('does not select the check for product changes it never reads', () => {
    expect(selectProducerOutput('web/app/src/App.tsx')).toBe('logs_vrl_check=false');
  });
  it('does not select the check for its own suite test, which pins its input only', () => {
    expect(selectProducerOutput('tests/unit/logs-record-shape.test.ts')).toBe(
      'logs_vrl_check=false'
    );
  });
  it('does not select the check for the workflow and selectors that run it', () => {
    expect(
      selectProducerOutput(
        '.github/workflows/ci.yml',
        'scripts/ci-logs-vrl.sh',
        'scripts/ci-logs-vrl-paths.sh'
      )
    ).toBe('logs_vrl_check=false');
  });
  it('selects the check when the producer supplies no changed-path records', () => {
    // No records: no path was readable, so no path is evidence of safety —
    // the same rule the producer applies to its own empty input.
    expect(selectProducerOutput()).toBe('logs_vrl_check=true');
  });
});
