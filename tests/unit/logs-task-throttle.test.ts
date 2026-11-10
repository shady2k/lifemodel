import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function run(mode: string) {
  const result = spawnSync(
    'python3',
    [
      'tests/fixtures/logs-task-throttle-harness.py',
      mode,
      'deploy/platform/logs-volume-flood-walk.py',
    ],
    { encoding: 'utf8' }
  );
  expect(result.error).toBeUndefined();
  return result;
}

describe('the throttle uses admitted core task writers', () => {
  it('overlaps both real task rates with a trusted writer and waits for the burst', () => {
    const result = run('valid');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const line = result.stdout.split('\n').find((value) => value.startsWith('INTEGRATION '));
    const value = JSON.parse((line ?? '').slice('INTEGRATION '.length));
    expect(value.ok).toBe(true);
    expect(value.calls).toEqual([
      { run: 'fast', rate: 1000, size: 0 },
      { run: 'large', rate: 20, size: 20 * 1024 },
    ]);
    expect(value.created).toEqual(['trusted']);
    expect(value.elapsed).toBeGreaterThanOrEqual(3);
  });
  it('uses durable task timestamps after the core deletes completed pods', () => {
    const result = run('deleted-pods');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('"ok": true');
  });
  for (const mode of ['denied', 'empty', 'unrelated', 'no-overlap']) {
    it(`does not pass without actual task-specific counters: ${mode}`, () => {
      const result = run(mode);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('TEST NOT VALID');
    });
  }
});
