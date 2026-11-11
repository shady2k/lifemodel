/** WALK-LOGS-CRASH's delivery verdict: the drain wait, the store-side counts and
 * the per-writer arithmetic, driven against the fake store and node in
 * `tests/fixtures/logs-crash-walk-harness.py`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const WALK = join('deploy', 'platform', 'logs-crash-walk.py');
const HARNESS = join('tests', 'fixtures', 'logs-crash-walk-harness.py');

interface Run {
  readonly status: number | null;
  readonly lines: readonly string[];
}

function python(args: readonly string[]): Run {
  const result = spawnSync('python3', args, { encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  return { status: result.status, lines: result.stdout.split('\n') };
}

function jsonLine<T>(run: Run, prefix: string): T {
  const line = run.lines.find((entry) => entry.startsWith(prefix + ' '));
  expect(line).toBeDefined();
  return JSON.parse((line ?? '').slice(prefix.length + 1)) as T;
}

let directory = '';

function harness(mode: string, value: object = {}): Run {
  const fixture = join(directory, mode + '.json');
  writeFileSync(fixture, JSON.stringify(value));
  return python([HARNESS, mode, WALK, fixture]);
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'logs-crash-delivery-'));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('the delivery verdict is counted in the store itself', () => {
  it("counts every retained seq once, through the store's own LogsQL range query", () => {
    const run = harness('store-delivery');
    expect(run.status).toBe(0);
    const value = jsonLine<{
      verdict: { ok: boolean; detail: string };
      queries: number;
      sql: string[];
    }>(run, 'DELIVERY');
    expect(value.verdict.ok).toBe(true);
    expect(value.verdict.detail).toContain('10 written, 10 delivered, 0 duplicated');
    expect(value.verdict.detail).toContain("0 missing of which 0 are still in the kubelet's files");
    expect(value.sql[0]).toContain('pod:="walk-crash-writer"');
    expect(value.sql[0]).toContain('namespace:="lifemodel-logs-walk"');
    expect(value.sql[0]).toContain('extract "seq=<seq> "');
    expect(value.sql[0]).toContain('filter seq:range[');
    expect(value.sql[0]).toContain('stats count() n, count_uniq(seq) uniq');
  });

  it('finds a missing retained seq by bisecting ranges and names it', () => {
    const run = harness('store-delivery', { gap: true });
    expect(run.status).toBe(0);
    const value = jsonLine<{ verdict: { ok: boolean; detail: string }; queries: number }>(
      run,
      'DELIVERY'
    );
    expect(value.verdict.ok).toBe(false);
    expect(value.verdict.detail).toContain(
      "lost while still in the kubelet's files: walk-crash-writer seq 3"
    );
    expect(value.verdict.detail).toContain('1 missing of which 1 are still in');
    expect(value.queries).toBeGreaterThan(2);
  });

  it('names the writer whose retained line is missing', () => {
    const run = harness('store-delivery', { writers: 2, gap: true });
    const value = jsonLine<{ verdict: { ok: boolean; detail: string } }>(run, 'DELIVERY');
    expect(value.verdict.ok).toBe(false);
    expect(value.verdict.detail).toContain('walk-crash-writer seq 3');
    expect(value.verdict.detail).not.toContain('walk-crash-writer-2 seq');
  });

  it('reports duplicates as stored records minus distinct seqs', () => {
    const value = jsonLine<{ verdict: { ok: boolean; detail: string } }>(
      harness('store-delivery', { duplicates: 2 }),
      'DELIVERY'
    );
    expect(value.verdict.ok).toBe(true);
    expect(value.verdict.detail).toContain('20 duplicated');
  });

  it('allows a missing line the kubelet has rotated away', () => {
    const value = jsonLine<{ verdict: { ok: boolean; detail: string } }>(
      harness('store-delivery', { rotated: true, rotatedGap: true }),
      'DELIVERY'
    );
    expect(value.verdict.ok).toBe(true);
    expect(value.verdict.detail).toContain('1 rotated away');
  });

  it('waits for the drain to finish before counting the verdict', () => {
    const run = harness('drain', {
      readings: [
        { size: 1000, events: 3, received: 100, sent: 80, uniq: 5 },
        { size: 500, events: 1, received: 120, sent: 100, uniq: 7 },
        { size: 0, events: 0, received: 130, sent: 130, uniq: 7 },
      ],
    });
    expect(run.status).toBe(0);
    expect(jsonLine<{ ok: boolean; seconds: number; samples: number }>(run, 'DRAIN')).toEqual({
      ok: true,
      seconds: 20,
      samples: 3,
    });
    const output = run.lines.join('\n');
    expect(output).toContain(
      'drain bound: 20 events backlogged at the start (buffer received 100, sent 80), ' +
        'measured drain 2 events/s, expected 10 s -> 45 s'
    );
    expect(output).toContain('the collector read out the backlog it held before the delivery verdict');
    expect(output).toContain('per-writer unique counts=7 (stable for 10 s)');
  });

  it('finishes on the backlog read out while ordinary traffic keeps the buffer non-empty', () => {
    const run = harness('drain', {
      readings: [
        { size: 5000, events: 50, received: 1000, sent: 900, uniq: 5 },
        { size: 6000, events: 60, received: 1200, sent: 1000, uniq: 7 },
        { size: 7000, events: 70, received: 1400, sent: 1000, uniq: 7 },
      ],
    });
    expect(run.status).toBe(0);
    expect(jsonLine<{ ok: boolean; seconds: number; samples: number }>(run, 'DRAIN')).toEqual({
      ok: true,
      seconds: 20,
      samples: 3,
    });
    const output = run.lines.join('\n');
    expect(output).toContain('backlog read out=true');
    expect(output).toContain('size=7000 events=70');
    expect(output).toContain('sent 1000 reached received 1000');
    expect(output).not.toContain('TEST NOT VALID');
  });

  it('marks a drain that does not finish TEST NOT VALID with its last reading', () => {
    const run = harness('drain', {
      ceiling: 30,
      readings: [
        { size: 1000, events: 3, received: 100, sent: 80, uniq: 5 },
        { size: 1000, events: 3, received: 110, sent: 80, uniq: 7 },
        { size: 1000, events: 3, received: 120, sent: 80, uniq: 7 },
        { size: 1000, events: 3, received: 120, sent: 80, uniq: 7 },
      ],
    });
    expect(run.status).toBe(1);
    expect(jsonLine<{ ok: boolean }>(run, 'DRAIN').ok).toBe(false);
    const output = run.lines.join('\n');
    expect(output).toContain('TEST NOT VALID the drain did not finish within 30 s');
    expect(output).toContain('last buffer size=1000 events=3 received=120 sent=80');
    expect(output).toContain('the 20-event backlog it started with was not read out');
    expect(output).toContain('per-writer unique counts=7');
    expect(output).toContain('writer counts stable for 20 s');
    expect(output).not.toMatch(/^FAIL /m);
  });

  it('counts a line that was still draining only after the drain finished', () => {
    const value = jsonLine<{ verdict: { ok: boolean; detail: string } }>(
      harness('drain-late'),
      'LATE'
    );
    expect(value.verdict.ok).toBe(true);
    expect(value.verdict.detail).toContain('10 delivered');
  });

  it('reports restarts as the delta since the walk started', () => {
    expect(
      jsonLine<{ before: number; now: number; delta: number }>(harness('restart-delta'), 'RESTARTS')
    ).toEqual({ before: 1, now: 4, delta: 3 });
    const run = harness('crash-load-release');
    expect(run.lines.join('\n')).toContain(
      'the collector restarted 1 time(s) since the walk started (restartCount 0 -> 1)'
    );
  });

  it('makes the per-writer missing figures add up, or says unresolved', () => {
    type Account = { written: number; uniq: number; missing: number; rotated: number };
    const account = (output: string): Account => {
      const match = output.match(
        /writer walk-crash-writer: written=(\d+) retained=\d+ stored=\d+ uniq=(\d+) duplicates=\d+ missing-retained=(\d+) missing-rotated=(\d+)/
      );
      expect(match).not.toBeNull();
      return {
        written: Number(match?.[1]),
        uniq: Number(match?.[2]),
        missing: Number(match?.[3]),
        rotated: Number(match?.[4]),
      };
    };
    const gap = account(harness('store-delivery', { gap: true }).lines.join('\n'));
    expect(gap.missing + gap.rotated).toBe(gap.written - gap.uniq);
    const late = account(
      harness('store-delivery', { rotated: true, rotatedGap: true }).lines.join('\n')
    );
    expect(late.missing + late.rotated).toBe(late.written - late.uniq);
    const unresolved = harness('store-delivery', { gap: true, unresolved: true });
    const output = unresolved.lines.join('\n');
    expect(output).toContain('unresolved=1 missing-found=0 missing-rotated=0');
    expect(output).not.toContain('missing-retained=');
  });

  it('marks a refused store query TEST NOT VALID with its HTTP status', () => {
    const run = harness('store-delivery', { refuse: 1 });
    expect(run.status).toBe(1);
    const value = jsonLine<{ verdict: null }>(run, 'DELIVERY');
    expect(value.verdict).toBeNull();
    const output = run.lines.join('\n');
    expect(output).toContain('TEST NOT VALID delivery query unavailable or incomplete');
    expect(output).toContain('the store answered HTTP 500');
    expect(output).not.toContain(
      "PASS every line still in the kubelet's files is delivered at least once"
    );
  });
});

describe('the crash walk calls out a load bound close to the baseline', () => {
  it('recommends --max-load when the baseline is within 2 of the bound', () => {
    const run = harness('max-load-note', { baseline: 15.0, bound: 16.0 });
    const output = run.lines.join('\n');
    expect(output).toContain('within 1.0 of the load bound 16.00');
    expect(output).toContain('--max-load');
    expect(output).toContain('headroom');
  });

  it('says nothing when the bound has headroom above the baseline', () => {
    const run = harness('max-load-note', { baseline: 1.0, bound: 16.0 });
    expect(run.lines.join('\n')).not.toContain('--max-load');
  });
});
