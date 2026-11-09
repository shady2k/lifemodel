/** WALK-LOGS-EVICT (ADR-016 L16): the arithmetic the displacement walk rests on
 * — the refusal windows, the gap of accepted lines, the per-window writer
 * counts, the threshold fill, the evictor's staleness and the store's
 * unauthenticated partition refusal — held against the fake node in
 * `tests/fixtures/logs-walk-stage2-harness.py`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const WALK = join('deploy', 'platform', 'logs-evict-walk.py');
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

function jsonLine<T>(run: Run, prefix: string): T {
  const line = run.lines.find((entry) => entry.startsWith(prefix + ' '));
  expect(line).toBeDefined();
  return JSON.parse((line ?? '').slice(prefix.length + 1)) as T;
}

let directory = '';

function harness(mode: string): Run {
  const fixture = join(directory, mode + '.json');
  writeFileSync(fixture, '{}');
  return python([HARNESS, mode, WALK, fixture]);
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'logs-evict-walk-'));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('the evict walk\'s argument handling', () => {
  it('prints its usage and exits 0 on --help', () => {
    const run = python([WALK, '--help']);
    expect(run.status).toBe(0);
    const help = run.lines.join('\n');
    for (const name of [
      '--password-file',
      '--flood-seconds',
      '--fill-bound',
      '--writer-interval-ms',
      '--writer-namespace',
      '--poll-seconds',
      '--settle-seconds',
      '--quiet-seconds',
      '--suspend-seconds',
    ]) {
      expect(help).toContain(name);
    }
  });

  it('refuses an unknown argument and a missing password file', () => {
    expect(python([WALK, '--no-such-argument']).status).toBe(2);
    expect(python([WALK]).status).toBe(2);
  });
});

describe('the evict walk states every assertion of its row', () => {
  it('names the restart, the panic, the drop lines, the writer, the 429 window and the suspend', () => {
    const header = readFileSync(WALK, 'utf8').split('\n').slice(0, 130).join('\n');
    expect(header).toContain('WALK-LOGS-EVICT');
    expect(header).toContain('ADR-016 L16');
    expect(header).toMatch(/restartCount/);
    expect(header).toMatch(/panic/);
    expect(header).toMatch(/logs-evictor/);
    expect(header).toMatch(/429/);
    expect(header).toMatch(/suspend/);
    expect(header).toMatch(/partition/);
    expect(header).toMatch(/What it does not cover/);
  });

  it('deletes its writer pod and restores the CronJob in a finally', () => {
    const source = readFileSync(WALK, 'utf8');
    expect(source).toContain('RESTORE');
    expect(source).toMatch(/suspend/);
    expect(source).toMatch(/finally:/);
  });
});

describe('a fake node for the evict walk', () => {
  it('groups the 429 answers into windows and states the longest gap', () => {
    const run = harness('evict-arith');
    const value = jsonLine<{
      windows: { seconds: number }[];
      gapSeconds: number;
      longestWindow: number;
    }>(run, 'ARITH');
    // 1000..3000 with 2000 and 4000 accepted: two windows of 1 s and 1 s.
    expect(value.windows.map((window) => window.seconds)).toEqual([1, 1]);
    // The accepted lines stop for 3 s between seq 2 (t=5000) and seq 3 (t=8000).
    expect(value.gapSeconds).toBe(3);
    expect(value.longestWindow).toBe(1);
    expect(run.status).toBe(0);
  }, 30000);

  it('counts the writer\'s lines per window and finds the loss only in a drop window', () => {
    const run = harness('evict-writer');
    const value = jsonLine<{
      windows: { written: number; found: number; lost: number; drop: boolean }[];
      lossInDropWindowsOnly: boolean;
    }>(run, 'WRITER');
    expect(value.windows.map((window) => window.lost)).toEqual([0, 2]);
    expect(value.windows[1]?.drop).toBe(true);
    expect(value.lossInDropWindowsOnly).toBe(true);
    expect(run.status).toBe(0);
  }, 30000);

  it('reports a fill that never reaches the threshold as not reached', () => {
    const run = harness('evict-fill-never');
    expect(run.invalid.join('\n')).toContain('threshold');
    expect(run.status).toBe(1);
  }, 30000);

  it('passes the fill once free space is below the threshold', () => {
    const run = harness('evict-fill');
    expect(run.passes.join('\n')).toContain('below the evictor\'s threshold');
    expect(run.status).toBe(0);
  }, 30000);

  it('passes the store\'s refusal of an unauthenticated partition list', () => {
    const run = harness('evict-partition');
    expect(run.passes.join('\n')).toContain('authKey');
    expect(run.status).toBe(0);
  }, 30000);

  it('fails when the same list answers without a key', () => {
    const run = harness('evict-partition-open');
    expect(run.failures.join('\n')).toContain('authKey');
    expect(run.status).toBe(1);
  }, 30000);

  it('calls the evictor stale only past two intervals', () => {
    const run = harness('evict-stale');
    const value = jsonLine<{ fresh: boolean; stale: boolean; never: boolean }>(run, 'STALE');
    expect(value.fresh).toBe(false);
    expect(value.stale).toBe(true);
    expect(value.never).toBe(true);
  }, 30000);
});
