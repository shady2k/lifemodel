import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function run(mode: string) {
  const result = spawnSync(
    'python3',
    ['tests/fixtures/logs-crash-pickup-harness.py', 'deploy/platform/logs-crash-walk.py', mode],
    { encoding: 'utf8' }
  );
  expect(result.status, result.stderr).toBe(0);
  const line = result.stdout.split('\n').find((line) => line.startsWith('OBSERVED '))!;
  return { output: result.stdout, value: JSON.parse(line.slice(9)) };
}

describe('crash walk waits for new writer log discovery', () => {
  it('ignores heartbeat-sized changes until three seconds of target lines arrive', () => {
    const { output, value } = run('delayed');
    expect(value.seconds).toBe(60);
    expect(value.result.received).toBe(18300);
    expect(output).toMatch(/pickup.*120/);
    expect(output).toContain('5100');
    expect(output).toMatch(/picked up.*60/);
  });
  it('starts fill only after pickup even when its fill bound is shorter than discovery', () => {
    const { output, value } = run('integration');
    expect(value.seconds).toBe(63);
    expect(output).toMatch(/picked up.*60/);
    expect(output.indexOf('achieved source rate')).toBeGreaterThan(
      output.indexOf('source picked up')
    );
    expect(output).toContain('fixture stops at fill sample');
    expect(output).not.toContain('never reached its maximum');
  });
  it.each(['timeout', 'missing', 'reset'])(
    'fails boundedly on %s without starting fill',
    (mode) => {
      const { output, value } = run(mode);
      expect(value.result).toBeNull();
      expect(value.seconds).toBeLessThanOrEqual(120);
      expect(output).toContain('TEST NOT VALID');
      if (mode === 'missing') expect(output).toContain('503');
      if (mode === 'reset') expect(output).toMatch(/reset/);
    }
  );
});
