import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function run(mode: string) {
  const result = spawnSync(
    'python3',
    [
      'tests/fixtures/logs-task-throttle-harness.py',
      mode,
      'deploy/platform/logs-volume-flood-walk.py',
      'deploy/platform/logs_task_writer.py',
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
  it('judges each pod in its own processing-time windows, not the writers\' overlap', () => {
    const result = run('processing-windows');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('"ok": true');
    const detail = result.stdout.split('\n').find((line) => line.includes('input and accepted'));
    expect(detail).toContain('task-fast: 37 window(s), input 370000, accepted 110260');
    expect(detail).toContain('task-large: 5 window(s), input 600, accepted 600');
    expect(result.stdout).toContain('7000 ms common timestamp interval');
  });
  it('allows a counter gap inside one collector process only when the pod wrote nothing then', () => {
    const idle = run('gap-idle');
    expect(idle.status, idle.stdout + idle.stderr).toBe(0);
    expect(idle.stdout).toContain('"ok": true');
    expect(idle.stdout).toContain('task-fast: 36 window(s)');
    const written = run('gap-with-line');
    expect(written.status).toBe(1);
    expect(written.stdout).toContain('TEST NOT VALID');
    expect(written.stdout).toContain('task-fast: window 2026-11-10T15:52:00Z is missing');
  });
  it.each([
    ['two-collectors', 'task-fast: counter windows name 2 collector processes'],
    ['stored-mismatch', 'task-fast: accepted total 110260 differs from 110261 stored line(s)'],
  ])('names the pod and the windows that do not reconcile: %s', (mode, detail) => {
    const result = run(mode);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('TEST NOT VALID');
    expect(result.stdout).toContain(detail);
  });
  it.each([60, 120])(
    'the throttle case\'s own writer arguments pass the validator at --throttle-seconds %i',
    (seconds) => {
      const result = run(`args-${seconds}`);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const line = result.stdout.split('\n').find((value) => value.startsWith('INTEGRATION '));
      const value = JSON.parse((line ?? '').slice('INTEGRATION '.length)) as {
        ok: boolean;
        validated: { run: string; rate: number; seconds: number; bound: number; validated: boolean }[];
      };
      expect(value.ok).toBe(true);
      expect(value.validated).toHaveLength(2);
      const [fast, large] = value.validated;
      expect(fast.run).toBe('fast');
      expect(fast.rate).toBe(1000);
      expect(large.run).toBe('large');
      expect(large.rate).toBe(20);
      expect(large.seconds).toBe(seconds);
      expect(fast.seconds).toBe(seconds + fast.bound);
      for (const call of value.validated) expect(call.validated).toBe(true);
      expect(result.stdout).not.toContain('arguments are outside the bounded walk limits');
    }
  );
  it('names an input below accepted in its own window', () => {
    const result = run('bad-count');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('TEST NOT VALID');
    expect(result.stdout).toContain(
      'task-large: window 2026-11-10T00:00:00Z has input 3000 below accepted 4000'
    );
  });
  it.each(['no-throttle', 'untrusted-writer'])('fails unthrottled or untrusted evidence: %s', (mode) => {
    const result = run(mode);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL');
  });
  for (const mode of [
    'denied',
    'empty',
    'unrelated',
    'no-overlap',
    'missing',
    'duplicate',
    'different-window',
    'forged',
    'message-only',
    'malformed-duplicate',
    'partial-window',
    'mixed-instance',
    'missing-instance',
    'bad-count',
  ]) {
    it(`does not pass without actual task-specific counters: ${mode}`, () => {
      const result = run(mode);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('TEST NOT VALID');
    });
  }
});
