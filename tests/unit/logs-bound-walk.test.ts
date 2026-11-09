/** WALK-LOGS-BOUND (ADR-016 L06): the byte bound's refusal with both numbers,
 * the accepted largest bound, and the day arithmetic the retention cases rest
 * on, held against the fake node in
 * `tests/fixtures/logs-walk-stage2-harness.py`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const WALK = join('deploy', 'platform', 'logs-bound-walk.py');
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

function harness(mode: string): Run {
  const fixture = join(directory, mode + '.json');
  writeFileSync(fixture, '{}');
  return python([HARNESS, mode, WALK, fixture]);
}

function jsonLine(run: Run, prefix: string): unknown {
  const line = run.lines.find((entry) => entry.startsWith(prefix + ' '));
  expect(line).toBeDefined();
  return JSON.parse((line ?? '').slice(prefix.length + 1));
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'logs-bound-walk-'));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('the bound walk\'s argument handling', () => {
  it('prints its usage and exits 0 on --help', () => {
    const run = python([WALK, '--help']);
    expect(run.status).toBe(0);
    const help = run.lines.join('\n');
    for (const name of [
      '--password-file',
      '--byte-bound-mib',
      '--canary-days-back',
      '--canary-records',
      '--today-mib',
      '--old-day-mib',
      '--old-days',
      '--age-days',
      '--retention-bound',
    ]) {
      expect(help).toContain(name);
    }
  });

  it('refuses an unknown argument and a missing password file', () => {
    expect(python([WALK, '--no-such-argument']).status).toBe(2);
    expect(python([WALK]).status).toBe(2);
  });
});

describe('the bound walk states what it proves and what it does not', () => {
  it('names the refusal, the accepted bounds and both retention parts', () => {
    const header = readFileSync(WALK, 'utf8').split('\n').slice(0, 110).join('\n');
    expect(header).toContain('WALK-LOGS-BOUND');
    expect(header).toContain('ADR-016 L06');
    expect(header).toMatch(/refus/i);
    expect(header).toMatch(/300 MiB byte bound/);
    expect(header).toMatch(/age bound/);
    expect(header).toMatch(/canary/);
    expect(header).toMatch(/What it does not cover/);
    expect(header).toMatch(/two-day floor|two newest days/);
  });

  it('counts only its own records and removes only its own days', () => {
    const source = readFileSync(WALK, 'utf8');
    expect(source).toContain('run_id');
    expect(source).toMatch(/detach/);
    expect(source).toMatch(/remove_day|rmtree/);
  });
});

describe('a fake node for the bound walk', () => {
  it('accepts the largest bound and refuses one above it, with both numbers', () => {
    const run = harness('bound-refusal');
    const pass = run.passes.join('\n');
    expect(pass).toContain('a bound above volume minus the evictor threshold is refused');
    expect(pass).toContain('is accepted');
    expect(run.failures).toEqual([]);
    expect(run.status).toBe(0);
  }, 30000);

  it('fails when an over-large bound is accepted', () => {
    const run = harness('bound-refusal-accepted');
    expect(run.failures.join('\n')).toContain('a bound above volume minus the evictor threshold is refused');
    expect(run.status).toBe(1);
  }, 30000);

  it('keeps only days older than the age deadline in the removed set', () => {
    const run = harness('bound-days');
    const result = jsonLine(run, 'DAYS') as {
      olderOnly: boolean;
      youngerRemoved: boolean;
      youngerCase: boolean;
      dropped: string[];
    };
    expect(result.olderOnly).toBe(true);
    expect(result.youngerRemoved).toBe(false);
    expect(result.youngerCase).toBe(true);
    expect(result.dropped).toEqual(['20261030', '20261105']);
    expect(run.status).toBe(0);
  }, 30000);

  it('marks a canary that was never stored as TEST NOT VALID, not as a retention result', () => {
    const run = harness('bound-canary-absent');
    expect(run.invalid.join('\n')).toContain('canary');
    expect(run.status).toBe(1);
  }, 30000);

  it('reads the window count from the API\'s own answer', () => {
    const run = harness('bound-count');
    expect(jsonLine(run, 'COUNT')).toBe(200);
  }, 30000);
});
