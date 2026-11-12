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

function integration(result: ReturnType<typeof run>) {
  const line = result.stdout.split('\n').find((value) => value.startsWith('INTEGRATION '));
  return JSON.parse((line ?? '').slice('INTEGRATION '.length));
}

describe('the throttle volume is written by walk-owned pods in the task namespace', () => {
  it('keeps one real task for the untrusted proof and writes the volume itself', () => {
    const result = run('valid');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const value = integration(result);
    expect(value.ok).toBe(true);
    expect(value.task_calls).toHaveLength(1);
    expect(value.task_calls[0]).toMatchObject({
      run: 'fast',
      rate: 1000,
      size: 0,
      seconds: 3,
      bound: 360,
    });
    const [trusted, fast, large] = value.manifests;
    expect(value.manifests.map((entry: { name: string }) => entry.name)).toEqual([
      'walk-trusted-writer',
      'walk-throttle-fast',
      'walk-throttle-large',
    ]);
    expect(trusted).toMatchObject({ namespace: 'trusted', seconds: 43, interval: 20 });
    expect(fast).toMatchObject({
      namespace: 'lifemodel-logs-walk',
      module: 'walk-throttle-fast',
      seconds: 13,
      interval: 1,
      size: 0,
    });
    expect(large).toMatchObject({
      namespace: 'lifemodel-logs-walk',
      module: 'walk-throttle-large',
      seconds: 13,
      interval: 50,
      size: 20 * 1024,
    });
    expect(result.stdout).toContain(
      'walk-owned throttle pods run 13 s (throttle-seconds 3 plus the 10 s recover bound)'
    );
    expect(result.stdout).toContain(
      "walk-owned pods walk-throttle-fast, walk-throttle-large in the walk's own namespace lifemodel-logs-walk"
    );
    expect(result.stdout).toContain('the task namespace admits only core-created pods');
    expect(result.stdout).toContain('the collector throttles every namespace outside its trusted list');
    expect(result.stdout).toContain(
      'records from lifemodel-logs-walk/walk-throttle-fast are stored with untrusted=true'
    );
    expect(result.stdout).toContain('all three writers overlap by line timestamps');
    expect(result.stdout).toContain('10000 ms common timestamp interval');
    expect(result.stdout).toContain('at least 3 s required');
    expect(value.deleted).toEqual([
      ['lifemodel-logs-walk', 'walk-throttle-fast'],
      ['lifemodel-logs-walk', 'walk-throttle-large'],
    ]);
    expect(result.stdout).toContain(
      'walk-owned throttle pod lifemodel-logs-walk/walk-throttle-large stopped after the evidence was read'
    );
  });
  it('creates the trusted writer before both throttle pods and runs them through the recover bound', () => {
    const result = run('valid');
    const value = integration(result) as {
      manifests: { name: string; seconds: number }[];
    };
    expect(value.manifests.map((entry) => entry.name)).toEqual([
      'walk-trusted-writer',
      'walk-throttle-fast',
      'walk-throttle-large',
    ]);
    const [trusted, ...volume] = value.manifests;
    for (const entry of volume) expect(entry.seconds).toBe(3 + 10);
    expect(trusted.seconds).toBe(3 + 10 + 30);
  });
  it('refuses to replace a pod of its own name that already exists', () => {
    const result = run('existing-pod');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('TEST NOT VALID');
    expect(result.stdout).toContain(
      'throttle volume pod lifemodel-logs-walk/walk-throttle-fast already exists'
    );
    expect(result.stdout).toContain('refuses to replace a pod it did not create');
  });
  it.each([
    ['trusted-namespace', 'untrusted=false, not true: the namespace is trusted'],
    ['no-untrusted-record', 'untrusted=absent, not true: the namespace is trusted'],
  ])('refuses a volume namespace that is not untrusted: %s', (mode, detail) => {
    const result = run(mode);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('TEST NOT VALID');
    expect(result.stdout).toContain('a record from lifemodel-logs-walk/walk-throttle-fast');
    expect(result.stdout).toContain(detail);
    expect(result.stdout).toContain('the throttle case would prove nothing');
  });
  it('names the pod-security policy that refused the volume pod', () => {
    const result = run('refused-apply');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('TEST NOT VALID');
    expect(result.stdout).toContain(
      'throttle volume pod lifemodel-logs-walk/walk-throttle-fast was refused'
    );
    expect(result.stdout).toContain('violates PodSecurity "restricted:latest"');
  });
  it('restore deletes only the pods the walk created', () => {
    const result = run('restore');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const line = result.stdout.split('\n').find((entry) => entry.startsWith('RESTORE '));
    const body = JSON.parse((line ?? '').slice('RESTORE '.length));
    expect(body.rows.map((row: [string, string, boolean]) => [row[0], row[1]])).toEqual([
      ['trusted', 'walk-trusted-writer'],
      ['trusted', 'walk-flood-trusted'],
      ['lifemodel-logs-walk-pg', 'walk-flood-pg'],
      ['lifemodel-logs-walk', 'walk-throttle-fast'],
      ['lifemodel-logs-walk', 'walk-throttle-large'],
    ]);
  });
  it('takes lifetimes from stored lines, so a rotated container log cannot shrink the overlap', () => {
    const result = run('rotated-log');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('"ok": true');
    expect(result.stdout).toContain('10000 ms common timestamp interval');
    expect(result.stdout).not.toContain('TEST NOT VALID');
  });
  it('says how short the overlap was and which writer started last', () => {
    const result = run('no-overlap');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('TEST NOT VALID');
    expect(result.stdout).toContain('5000 ms short of the required 3 s');
    expect(result.stdout).toContain('walk-throttle-large started last');
  });
  it('judges each pod in its own processing-time windows, not the writers\' overlap', () => {
    const result = run('processing-windows');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('"ok": true');
    const detail = result.stdout.split('\n').find((line) => line.includes('input and accepted'));
    expect(detail).toContain('walk-throttle-fast: 37 window(s), input 370000, accepted 110260');
    expect(detail).toContain('walk-throttle-large: 5 window(s), input 600, accepted 600');
    expect(result.stdout).toContain('450000 ms common timestamp interval');
  });
  it('notes a processing-time gap without comparing it with the lines\' write time (r53)', () => {
    const result = run('processing-gap');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('"ok": true');
    expect(result.stdout).toContain(
      'walk-throttle-fast: 1 window(s) without counters inside a collector process'
    );
    expect(result.stdout).toContain('2026-11-10T15:52:00Z');
  });
  it('judges windows per collector process and notes the handover', () => {
    const result = run('two-collectors');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('"ok": true');
    expect(result.stdout).toContain(
      'walk-throttle-fast: counter windows come from 2 collector processes'
    );
  });
  it('fails a stored-line mismatch and names the pod', () => {
    const result = run('stored-mismatch');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('TEST NOT VALID');
    expect(result.stdout).toContain(
      'walk-throttle-fast: accepted total 110260 differs from 110261 stored line(s)'
    );
  });
  it.each([
    ['duplicate', 'walk-throttle-large: window 2026-11-10T00:00:00Z has 2 accepted records'],
    ['missing', 'walk-throttle-large: window 2026-11-10T00:00:00Z has no complete counter pair'],
  ])('fails a duplicate or unpaired counter and names the window: %s', (mode, detail) => {
    const result = run(mode);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('TEST NOT VALID');
    expect(result.stdout).toContain(detail);
  });
  it.each([60, 120])(
    'the real task request passes the validator at --throttle-seconds %i',
    (seconds) => {
      const result = run(`args-${seconds}`);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const value = integration(result);
      expect(value.ok).toBe(true);
      expect(value.validated).toHaveLength(1);
      expect(value.validated[0]).toMatchObject({
        run: 'fast',
        rate: 1000,
        seconds,
        validated: true,
      });
      expect(result.stdout).not.toContain('arguments are outside the bounded walk limits');
    }
  );
  it('names an input below accepted in its own window', () => {
    const result = run('bad-count');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('TEST NOT VALID');
    expect(result.stdout).toContain(
      'walk-throttle-large: window 2026-11-10T00:00:00Z has input 3000 below accepted 4000'
    );
  });
  it.each(['no-throttle', 'untrusted-writer'])(
    'fails unthrottled or untrusted evidence: %s',
    (mode) => {
      const result = run(mode);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('FAIL');
    }
  );
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
