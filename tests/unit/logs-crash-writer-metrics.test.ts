import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function run(mode: string) {
  const result = spawnSync(
    'python3',
    [
      'tests/fixtures/logs-crash-writer-metrics-harness.py',
      'deploy/platform/logs-crash-walk.py',
      mode,
    ],
    { encoding: 'utf8' }
  );
  expect(result.status, result.stderr).toBe(0);
  const line = result.stdout.split('\n').find((line) => line.startsWith('OBSERVED '))!;
  return { output: result.stdout, value: JSON.parse(line.slice(9)) };
}

describe('writer-only Kubernetes source counters', () => {
  it('sums exact writer pod and namespace matches, ignoring first-series and other workloads', () => {
    const { value, output } = run('sum');
    expect(value.before.received).toBe(600);
    expect(value.current.received).toBe(1200);
    expect(value.rate).toBe(60);
    expect(value.current.per_writer).toEqual({
      'walk-crash-writer': 200,
      'walk-crash-writer-2': 400,
      'walk-crash-writer-3': 600,
    });
    for (const [pod, count] of Object.entries(value.current.per_writer)) {
      expect(output).toContain(pod);
      expect(output).toContain(String(count));
    }
    expect(output).toContain('walk-ns');
  });
  it('treats absent writer series as zero only for the successful precreation baseline', () => {
    const { value } = run('baseline');
    expect(value.before.received).toBe(0);
    expect(value.rate).toBe(120);
  });
  it('does not declare a measured rate while one writer series is absent', () => {
    const { value } = run('missing');
    expect(value.current.received).toBeNull();
    expect(value.current.per_writer['walk-crash-writer-2']).toBeNull();
    expect(value.rate).toBeNull();
  });
  it('detects a per-writer reset even when the sum grows', () => {
    const { value, output } = run('reset');
    expect(value.rate).toBeNull();
    expect(output).toContain('reset');
  });
});
