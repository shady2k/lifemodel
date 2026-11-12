/** WALK-LOGS-SETTING (ADR-016 L08): the retention setting's two numbers, the
 * pending/applied answer, the durable revision and the idempotent repeat, held
 * against the fake node in `tests/fixtures/logs-walk-stage2-harness.py`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const WALK = join('deploy', 'platform', 'logs-setting-walk.py');
const HARNESS = join('tests', 'fixtures', 'logs-walk-stage2-harness.py');

interface Run {
  readonly status: number | null;
  readonly lines: readonly string[];
  readonly failures: readonly string[];
  readonly passes: readonly string[];
  readonly notes: readonly string[];
  readonly invalid: readonly string[];
}

function python(args: readonly string[]): Run {
  const result = spawnSync('python3', args, { encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  const lines = result.stdout.split('\n');
  return {
    status: result.status,
    lines,
    failures: lines.filter((line) => line.startsWith('FAIL ')),
    passes: lines.filter((line) => line.startsWith('PASS ')),
    notes: lines.filter((line) => line.startsWith('NOTE ')),
    invalid: lines.filter((line) => line.startsWith('TEST NOT VALID')),
  };
}

let directory = '';

function harness(mode: string, data: Record<string, unknown> = {}): Run {
  const fixture = join(directory, mode + '.json');
  writeFileSync(fixture, JSON.stringify(data));
  return python([HARNESS, mode, WALK, fixture]);
}

const ROLLING = { spec: { replicas: 1 }, status: { updatedReplicas: 0, availableReplicas: 0 } };
const DEPLOYED = { spec: { replicas: 1 }, status: { updatedReplicas: 1, availableReplicas: 1 } };

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'logs-setting-walk-'));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('the setting walk\'s argument handling', () => {
  it('prints its usage and exits 0 on --help', () => {
    const run = python([WALK, '--help']);
    expect(run.status).toBe(0);
    const help = run.lines.join('\n');
    for (const name of [
      '--password-file',
      '--loader-host',
      '--loader-namespace',
      '--apply-bound',
      '--days',
      '--days-next',
      '--loader-restart-bound',
    ]) {
      expect(help).toContain(name);
    }
  });

  it('refuses an unknown argument and a missing password file', () => {
    expect(python([WALK, '--no-such-argument']).status).toBe(2);
    expect(python([WALK]).status).toBe(2);
  });
});

describe('the setting walk states what it proves and what it does not', () => {
  it('names the two changes, the pending reason, the repeat and the crash', () => {
    const header = readFileSync(WALK, 'utf8').split('\n').slice(0, 100).join('\n');
    expect(header).toContain('WALK-LOGS-SETTING');
    expect(header).toContain('ADR-016 L08');
    expect(header).toMatch(/14 d|14 days/);
    expect(header).toMatch(/pending/);
    expect(header).toMatch(/identical|same values/);
    expect(header).toMatch(/killed|crash/i);
    expect(header).toMatch(/What it does not cover/);
  });

  it('writes with the session, the CSRF token and the exact Origin', () => {
    const source = readFileSync(WALK, 'utf8');
    expect(source).toContain('csrf');
    expect(source).toContain('origin');
    expect(source).toContain('/api/logs/settings');
  });
});

describe('a fake node for the setting walk', () => {
  it('passes the pending reason and the applied assertion', () => {
    const run = harness('setting-apply');
    const pass = run.passes.join('\n');
    expect(pass).toContain('the change to 7 days is accepted');
    expect(pass).toContain('the change is pending with a reason before it is applied');
    expect(pass).toContain('the change is applied');
    expect(run.failures).toEqual([]);
    expect(run.status).toBe(0);
  }, 30000);

  it('fails when the change never becomes applied', () => {
    const run = harness('setting-never-applied');
    expect(run.failures.join('\n')).toContain('the change is applied');
    expect(run.status).toBe(1);
  }, 30000);

  it('refuses a write without the CSRF token', () => {
    const run = harness('setting-refusal');
    expect(run.passes.join('\n')).toContain('the write demands the CSRF token and the exact Origin');
    expect(run.status).toBe(0);
  }, 30000);

  it('reads the flags only after the Deployment reports its rollout finished', () => {
    const run = harness('setting-rollout', { deploymentStates: [ROLLING, ROLLING, DEPLOYED] });
    const line = run.lines.find((entry) => entry.startsWith('ROLLOUT '));
    const value = JSON.parse((line ?? '').slice('ROLLOUT '.length));
    expect(value.finished).toBe(true);
    // Two reads while the old pod was still one of the replicas, the third done.
    expect(value.deployments).toBe(3);
    expect(run.passes.join('\n')).toContain('the store\'s rollout finished before the flags are read');
    expect(run.failures).toEqual([]);
    expect(run.status).toBe(0);
  }, 30000);

  it('does not read the flags on a rollout that never finishes', () => {
    const run = harness('setting-rollout', { deploymentStates: [ROLLING], bound: 1 });
    const line = run.lines.find((entry) => entry.startsWith('ROLLOUT '));
    const value = JSON.parse((line ?? '').slice('ROLLOUT '.length));
    expect(value.finished).toBe(false);
    expect(run.invalid.join('\n')).toContain('the store\'s rollout did not finish');
    expect(run.status).toBe(1);
  }, 30000);

  it('waits for the rollout inside the flags check, before the forward is opened', () => {
    const source = readFileSync(WALK, 'utf8');
    const check = source.slice(source.indexOf('def check_flags'));
    const body = check.slice(0, check.indexOf('def read_configmap'));
    expect(body).toMatch(/wait_store_rollout\(/);
    expect(body.indexOf('wait_store_rollout(')).toBeLessThan(body.indexOf('read_store_flags('));
  });

  it('reads the three flags back as the numbers the setting means', () => {
    const run = harness('setting-flags');
    const line = run.lines.find((entry) => entry.startsWith('FLAGS '));
    expect(line).toBeDefined();
    const value = JSON.parse((line ?? '').slice('FLAGS '.length));
    expect(value.agree).toBe(true);
    expect(value.days).toBe(7);
    expect(value.maxBytes).toBe(300 * 1024 * 1024);
    expect(value.minFreeBytes).toBe(805306368);
  }, 30000);
});
