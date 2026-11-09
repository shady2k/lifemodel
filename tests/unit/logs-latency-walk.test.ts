/** WALK-LOGS-LATENCY (ADR-016 L15): the percentile arithmetic the deadline
 * rests on, the pass and fail of a filter round, and total paging with its
 * "same page twice" check, held against the fake node in
 * `tests/fixtures/logs-walk-stage2-harness.py`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const WALK = join('deploy', 'platform', 'logs-latency-walk.py');
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
  directory = mkdtempSync(join(tmpdir(), 'logs-latency-walk-'));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("the latency walk's argument handling", () => {
  it('prints its usage and exits 0 on --help', () => {
    const run = python([WALK, '--help']);
    expect(run.status).toBe(0);
    const help = run.lines.join('\n');
    for (const name of [
      '--password-file',
      '--query-count',
      '--limit-ms',
      '--window-minutes',
      '--ingest-mib-per-s',
      '--same-time-records',
      '--identical-records',
      '--page-limit',
      '--large-window-records',
    ]) {
      expect(help).toContain(name);
    }
  });

  it('refuses an unknown argument and a missing password file', () => {
    expect(python([WALK, '--no-such-argument']).status).toBe(2);
    expect(python([WALK]).status).toBe(2);
  });
});

describe('the latency walk states what it proves and what it does not', () => {
  it('names the five filters, the deadline and the paging cases', () => {
    const header = readFileSync(WALK, 'utf8').split('\n').slice(0, 100).join('\n');
    expect(header).toContain('WALK-LOGS-LATENCY');
    expect(header).toContain('ADR-016 L15');
    expect(header).toMatch(/2\.5 s/);
    expect(header).toMatch(/conversation_id/);
    expect(header).toMatch(/byte-identical/);
    expect(header).toMatch(/250 records per page|250 per page/);
    expect(header).toMatch(/What it does not cover/);
  });

  it('writes its own conversation record and measures the filter on it', () => {
    const run = harness('latency-filters');
    const written = jsonLine<{
      conversation: string;
      inserted: number;
      modules: string[];
      withConversation: number;
      filters: string[];
    }>(run, 'FILTERS');
    // The VM has no conversation of the owner's: the walk brings its own, in a
    // module of its own, so the conversation filter measures a real query.
    expect(written.conversation).toBeTruthy();
    expect(written.inserted).toBeGreaterThan(0);
    expect(written.modules).toEqual(['walk-latency-filter']);
    expect(written.withConversation).toBe(written.inserted);
    expect(written.filters).toContain('conversation');
    expect(run.invalid).toEqual([]);
    expect(run.failures).toEqual([]);
    expect(run.status).toBe(0);
  }, 30000);

  it("measures through the loader's own route, not the store", () => {
    const source = readFileSync(WALK, 'utf8');
    expect(source).toContain('/api/logs');
    expect(source).toContain('percentile');
  });
});

describe('a fake node for the latency walk', () => {
  it('interpolates p50 and p95 the way a latency figure is read', () => {
    const run = harness('latency-percentiles');
    const value = jsonLine<{ p50: number; p95: number; max: number; count: number }>(
      run,
      'PERCENTILES'
    );
    expect(value.count).toBe(100);
    expect(value.p50).toBeCloseTo(50.5, 2);
    expect(value.p95).toBeCloseTo(95.05, 2);
    expect(value.max).toBe(100);
  }, 30000);

  it('passes a round inside the deadline and fails one past it', () => {
    const passed = harness('latency-round-pass');
    expect(passed.passes.join('\n')).toContain("the time filter stays inside the page's deadline");
    expect(passed.status).toBe(0);
    const failed = harness('latency-round-fail');
    expect(failed.failures.join('\n')).toContain(
      "the time filter stays inside the page's deadline"
    );
    expect(failed.status).toBe(1);
  }, 30000);

  it('passes total paging with the same page twice byte-identical', () => {
    const run = harness('latency-paging-ok');
    const pass = run.passes.join('\n');
    expect(pass).toContain('paging at 4 per page is total');
    expect(pass).toContain('every numbered record appears exactly once');
    expect(pass).toContain('every byte-identical line is accounted for');
    expect(pass).toContain('the same page fetched twice returns the same bytes');
    expect(run.failures).toEqual([]);
    expect(run.status).toBe(0);
  }, 30000);

  it('fails paging that repeats a numbered record', () => {
    const run = harness('latency-paging-dup');
    expect(run.failures.join('\n')).toContain('no numbered record appears twice');
    expect(run.status).toBe(1);
  }, 30000);

  it('marks a window whose records never arrived as TEST NOT VALID', () => {
    const run = harness('latency-paging-absent');
    expect(run.invalid.join('\n')).toContain('paging cannot be judged');
    expect(run.status).toBe(1);
  }, 30000);
});

describe('the status the first page asks for', () => {
  it('is measured over the same stepped windows, and an unknown collection still passes', () => {
    const run = harness('latency-status-ok');
    const value = jsonLine<{ params: Record<string, string>[] }>(run, 'STATUS');
    expect(value.params).toHaveLength(3);
    for (const params of value.params) {
      expect(params['status']).toBe('1');
      expect(params['limit']).toBe('1');
    }
    // The windows step back a minute per request, so no two asks are the same.
    const ends = value.params.map((params) => Number(params['to']));
    expect(ends[0]! - ends[1]!).toBe(60_000);
    expect(run.passes.join('\n')).toContain("the status stays inside the page's deadline");
    expect(run.invalid).toEqual([]);
    expect(run.status).toBe(0);
  }, 30000);

  it('fails past the deadline and is not valid without a status answer', () => {
    const failed = harness('latency-status-fail');
    expect(failed.failures.join('\n')).toContain("the status stays inside the page's deadline");
    expect(failed.status).toBe(1);
    const absent = harness('latency-status-absent');
    expect(absent.invalid.join('\n')).toContain('the first page answered without a status');
    expect(absent.status).toBe(1);
  }, 30000);
});

describe('the large window option', () => {
  it('plants the requested count in every measured window and anchors the rounds', () => {
    const run = harness('latency-large-window');
    const value = jsonLine<{
      planted: boolean;
      written: number;
      modules: string[];
      firstTime: string | null;
      lastTime: string | null;
      anchor: number | null;
    }>(run, 'LARGE');
    // 1,000 records in every 60-minute window over a 62-minute span.
    expect(value.planted).toBe(true);
    expect(value.written).toBe(Math.round((1000 * 62) / 60));
    expect(value.modules).toEqual(['walk-latency']);
    expect(value.firstTime).not.toBeNull();
    expect(value.lastTime).not.toBeNull();
    expect(Date.parse(value.lastTime ?? '')).toBeGreaterThan(Date.parse(value.firstTime ?? ''));
    // The rounds measure windows inside the planted span: the anchor is its end,
    // one step after the last planted record.
    expect(value.anchor).not.toBeNull();
    expect((value.anchor ?? 0) - Date.parse(value.lastTime ?? '')).toBeGreaterThan(0);
    // The anchor is the span's end: one step after the last record, whose
    // timestamp `stamp` truncates to the second.
    expect((value.anchor ?? 0) - Date.parse(value.lastTime ?? '')).toBeLessThanOrEqual(5000);
    expect(run.passes.join('\n')).toContain('the large window is stored');
    expect(run.status).toBe(0);
  }, 30000);

  it('is not valid when the records never arrive or the store refuses them', () => {
    const absent = harness('latency-large-window-absent');
    expect(absent.invalid.join('\n')).toContain('never all arrived');
    expect(absent.status).toBe(1);
    const refused = harness('latency-large-window-insert-refused');
    expect(refused.invalid.join('\n')).toContain('the large window was not written');
    expect(refused.status).toBe(1);
  }, 30000);
});
