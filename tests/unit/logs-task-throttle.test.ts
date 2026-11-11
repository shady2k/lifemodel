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
    const [fast, large] = value.calls;
    expect(fast.run).toBe('fast');
    expect(fast.rate).toBe(1000);
    expect(fast.size).toBe(0);
    expect(large.run).toBe('large');
    expect(large.rate).toBe(20);
    expect(large.size).toBe(20 * 1024);
    expect(fast.seconds).toBe(3 + fast.bound);
    expect(large.seconds).toBe(3 + large.bound);
    expect(value.created).toEqual(['trusted']);
    expect(value.elapsed).toBeGreaterThanOrEqual(3);
    expect(result.stdout).toContain('all three writers overlap by line timestamps');
    expect(result.stdout).toContain('at least 3 s required');
  });
  it('lets both task writers run through the other launch and covers both with the trusted writer', () => {
    const result = run('valid');
    const value = JSON.parse(
      (result.stdout.split('\n').find((line) => line.startsWith('INTEGRATION ')) ?? '').slice(
        'INTEGRATION '.length
      )
    ) as {
      calls: { seconds: number; bound: number }[];
      manifests: { name: string; seconds: number }[];
    };
    const bound = value.calls[0].bound;
    for (const call of value.calls) expect(call.seconds).toBe(3 + bound);
    expect(value.manifests).toEqual([
      { name: 'walk-trusted-writer', seconds: 3 + 3 * bound + 20 },
    ]);
  });
  it('says how short the overlap was and which writer started last', () => {
    const result = run('no-overlap');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('TEST NOT VALID');
    expect(result.stdout).toContain('5000 ms short of the required 3 s');
    expect(result.stdout).toContain('task-large started last');
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
  it('notes a processing-time gap without comparing it with the lines\' write time (r53)', () => {
    const result = run('processing-gap');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('"ok": true');
    expect(result.stdout).toContain('NOTE');
    expect(result.stdout).toContain(
      'task-fast: 1 window(s) without counters inside a collector process'
    );
    expect(result.stdout).toContain('2026-11-10T15:52:00Z');
  });
  it('judges windows per collector process and notes the handover', () => {
    const result = run('two-collectors');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('"ok": true');
    expect(result.stdout).toContain('task-fast: counter windows come from 2 collector processes');
  });
  it('fails a stored-line mismatch and names the pod', () => {
    const result = run('stored-mismatch');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('TEST NOT VALID');
    expect(result.stdout).toContain(
      'task-fast: accepted total 110260 differs from 110261 stored line(s)'
    );
  });
  it.each([
    ['duplicate', 'task-large: window 2026-11-10T00:00:00Z has 2 accepted records'],
    ['missing', 'task-large: window 2026-11-10T00:00:00Z has no complete counter pair'],
  ])('fails a duplicate or unpaired counter and names the window: %s', (mode, detail) => {
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
      expect(large.seconds).toBe(seconds + large.bound);
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
