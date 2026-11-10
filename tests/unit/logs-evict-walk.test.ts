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
      '--run-sample-seconds',
      '--suspend-seconds',
      '--evictor-bound',
      '--fill-timeout',
      '--refuse-bound',
      '--read-only-bound',
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
    const header = readFileSync(WALK, 'utf8').split('\n').slice(0, 170).join('\n');
    expect(header).toContain('WALK-LOGS-EVICT');
    expect(header).toContain('ADR-016 L16');
    expect(header).toMatch(/restartCount/);
    expect(header).toMatch(/panic/);
    expect(header).toMatch(/logs-evictor/);
    expect(header).toMatch(/429/);
    expect(header).toMatch(/suspend/);
    expect(header).toMatch(/partition/);
    expect(header).toMatch(/lastSuccessfulTime/);
    expect(header).toMatch(/dropped with its day/);
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

  it('states the tail after the last drop from lines that were all found', () => {
    // The writer keeps running past the flood: 200 lines after the last drop,
    // all found, over more than two eviction intervals.
    const run = harness('evict-writer');
    expect(run.passes.join('\n')).toContain(
      'every line written after the last drop is found',
    );
    expect(run.passes.join('\n')).toContain('200 line(s), none lost');
    expect(run.notes.join('\n')).toContain('the longest gap of accepted new lines after the last drop');
    expect(run.failures).toEqual([]);
    expect(run.status).toBe(0);
  }, 30000);

  it('marks a run with no line after the last drop as not valid, never a pass', () => {
    const run = harness('evict-writer-no-tail');
    expect(run.invalid.join('\n')).toContain('no writer line was written after the last drop');
    expect(run.status).toBe(1);
  }, 30000);

  it('counts a line in a day the evictor removed as dropped with its day', () => {
    const run = harness('evict-writer');
    const window = (index: number): string =>
      run.notes.find((line) => line.startsWith(`NOTE writer window ${index}`)) ?? '';
    // The first drop names the day lines 1 and 2 went to; the second names
    // today's day, which line 5 was written into after the first drop.
    expect(window(1)).toContain('wrote 3, found 1, dropped with its day 2, lost 0');
    // Window 1 follows no drop: only the day rule could excuse its two lines.
    expect(window(1)).toContain('drop after: false');
    expect(window(2)).toContain('wrote 2, found 1, dropped with its day 1, lost 0');
    expect(run.passes.join('\n')).toContain('3 dropped with its day, 0 lost');
    expect(run.failures).toEqual([]);
    expect(run.status).toBe(0);
  }, 30000);

  it('counts a day dropped after the flood window but before the count', () => {
    // The run crossed midnight and the evictor's next run removed today's day,
    // which held every writer line; only the flood window's drops were read.
    const run = harness('evict-writer-late-drop');
    expect(run.notes.join('\n')).toContain(
      'wrote 3, found 1, dropped with its day 2, lost 0',
    );
    expect(run.notes.join('\n')).toContain('after the flood window');
    expect(run.passes.join('\n')).toContain('2 dropped with its day, 0 lost');
    expect(run.failures).toEqual([]);
    expect(run.status).toBe(0);
  }, 30000);

  it('fails a row lost in a day no drop names and outside a detach window', () => {
    const run = harness('evict-writer-lost');
    expect(run.notes.join('\n')).toContain('dropped with its day 0, lost 2');
    expect(run.failures.join('\n')).toContain(
      'a row is lost only with the day the evictor removed or inside a window that ended with a ' +
        'detach and a remove',
    );
    expect(run.status).toBe(1);
  }, 30000);

  it('counts two runs from the CronJob while it keeps one Job of history', () => {
    const run = harness('evict-quiet');
    expect(run.passes.join('\n')).toContain('two distinct evictor runs completed');
    expect(run.passes.join('\n')).toContain('2 run(s) in 2 s');
    expect(run.passes.join('\n')).toContain('one Job of history is kept');
    expect(run.failures).toEqual([]);
    expect(run.status).toBe(0);
  }, 30000);

  it('fails the quiet window when only one run is visible', () => {
    const run = harness('evict-quiet-one');
    expect(run.failures.join('\n')).toContain('two distinct evictor runs completed');
    expect(run.failures.join('\n')).toContain('1 run(s) in 2 s');
    expect(run.status).toBe(1);
  }, 30000);

  it('proves the read-only line while the evictor is healthy and removes the filler', () => {
    const run = harness('evict-read-only');
    const pass = run.passes.join('\n');
    expect(pass).toContain('the volume is filled below the store\'s margin while the evictor is');
    expect(pass).toContain('the store refuses a write (429) with the volume below its margin');
    expect(pass).toContain('the API says the store is refusing writes (read-only)');
    expect(pass).toContain('the page shows read-only without blaming the evictor');
    expect(pass).toContain('the store accepts writes again after the filler is removed');
    expect(pass).toContain('the API says the store is not read-only after the filler is removed');
    expect(run.failures).toEqual([]);
    expect(run.status).toBe(0);
  }, 60000);

  it('judges the read-only line on a known evictor state after unreadable polls', () => {
    const run = harness('evict-read-only-unknown-first');
    const pass = run.passes.join('\n');
    expect(pass).toContain('the page shows read-only without blaming the evictor');
    expect(pass).toContain('without a known value');
    expect(run.failures).toEqual([]);
    expect(run.status).toBe(0);
  }, 60000);

  it('fails as its own result when no poll has a known evictor state', () => {
    const run = harness('evict-read-only-unknown-all');
    const failure = run.failures.join('\n');
    expect(failure).toContain('the evictor\'s state while the store is read-only');
    expect(failure).toContain('carried both a staleness and the CronJob');
    expect(run.invalid.join('\n')).toContain('cannot be told apart from a failing evictor');
    expect(run.status).toBe(1);
  }, 60000);

  it('passes a stale evictor only with the run\'s own no_partition reason', () => {
    const run = harness('evict-read-only-stale-no-partition');
    const pass = run.passes.join('\n');
    expect(pass).toContain('the page names the evictor only because its last success is older');
    expect(pass).toContain('no_partition');
    expect(run.failures).toEqual([]);
    expect(run.status).toBe(0);
  }, 60000);

  it('fails a stale evictor with no failure line behind it', () => {
    const run = harness('evict-read-only-stale-no-failure');
    expect(run.failures.join('\n')).toContain('latest failure reason none');
    expect(run.status).toBe(1);
  }, 60000);

  it('fails when the status read blames the evictor', () => {
    const run = harness('evict-read-only-blames');
    expect(run.failures.join('\n')).toContain(
      'the page shows read-only without blaming the evictor: its last run is recent',
    );
    expect(run.status).toBe(1);
  }, 60000);

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

  it('accepts a missing key refused with 401 as the same refusal', () => {
    const run = harness('evict-partition-unauthorized');
    expect(run.passes.join('\n')).toContain('authKey');
    expect(run.passes.join('\n')).toContain('answered 401');
    expect(run.status).toBe(0);
  }, 30000);

  it('fails when the same list answers without a key', () => {
    const run = harness('evict-partition-open');
    expect(run.failures.join('\n')).toContain('authKey');
    expect(run.status).toBe(1);
  }, 30000);

  it('shows the evictor line absent before the suspension, added by it and gone after', () => {
    const run = harness('evict-suspend');
    const pass = run.passes.join('\n');
    expect(pass).toContain('the evictor line is absent while the evictor runs');
    expect(pass).toContain('the evictor is suspended');
    expect(pass).toContain('the API adds the evictor line');
    expect(pass).toContain('the evictor line goes away after the next successful run');
    expect(jsonLine<string[]>(run, 'PATCHES')).toHaveLength(2);
    expect(run.status).toBe(0);
  }, 30000);

  it('keeps the API\'s unreadable polls as their own result', () => {
    const run = harness('evict-suspend-unavailable-all');
    const failure = run.failures.join('\n');
    // Not "the line never came": the API answered nothing, and that is named.
    expect(failure).toContain('the API answers the evictor\'s status while the evictor is suspended');
    expect(failure).toContain('unreadable');
    expect(failure).toContain('state=unavailable');
    expect(run.invalid.join('\n')).toContain('cannot be judged');
    expect(run.status).toBe(1);
  }, 60000);

  it('survives an unreadable start and passes once the line comes', () => {
    const run = harness('evict-suspend-unavailable-first');
    const pass = run.passes.join('\n');
    expect(pass).toContain('the API adds the evictor line once its last run is older than two intervals');
    expect(pass).toContain('2 with no answer');
    expect(run.failures).toEqual([]);
    expect(run.status).toBe(0);
  }, 60000);

  it('starts the stale clock from the last success seen after the suspension', () => {
    const run = harness('evict-suspend-running-job');
    const pass = run.passes.join('\n');
    expect(pass).toContain('the API adds the evictor line');
    expect(run.failures).toEqual([]);
    expect(run.status).toBe(0);
  }, 60000);

  it('reports every poll it made when the line never comes', () => {
    const run = harness('evict-suspend-never');
    const failure = run.failures.join('\n');
    expect(failure).toContain('the API adds the evictor line');
    expect(failure).toContain('poll(s)');
    expect(failure).toContain('stale=false');
    expect(failure).toContain('CronJob last=');
    expect(run.status).toBe(1);
  }, 60000);

  it('refuses to blame the suspension for a line that was already there', () => {
    const run = harness('evict-suspend-stale');
    expect(run.invalid.join('\n')).toContain('the evictor is not fresh before it is suspended');
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
