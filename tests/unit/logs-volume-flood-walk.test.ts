/** WALK-LOGS-VOLUME-FLOOD (ADR-016 L05, §5, §6): the walk is an operator script
 * for a deployed build, so these checks hold its decisions - Postgres committing
 * throughout, the store's margin, the shared filesystem, the trusted writer and
 * the throttled pods' counters - against
 * `tests/fixtures/logs-volume-flood-walk-harness.py`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const WALK = join('deploy', 'platform', 'logs-volume-flood-walk.py');
const HARNESS = join('tests', 'fixtures', 'logs-volume-flood-walk-harness.py');

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

function harness(mode: string, fixture: object = {}): Run {
  const path = join(directory, mode + '.json');
  writeFileSync(path, JSON.stringify(fixture));
  return python([HARNESS, mode, WALK, path]);
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'logs-volume-flood-walk-'));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('the volume flood writer image', () => {
  it('resolves the deployed loader image before starting the walk', () => {
    const run = harness('writer-image');
    expect(run.status).toBe(0);
    expect(jsonLine<string>(run, 'IMAGE')).toBe('deployed-loader@sha256:fixture');
  });
  it('is not valid before writes when no deployed image is available', () => {
    const run = harness('missing-writer-image');
    expect(run.status).toBe(1);
    expect(run.lines.join('\n')).toContain('TEST NOT VALID');
  });
});

describe("the volume flood walk's arguments and header", () => {
  it('prints its usage and exits 0 on --help', () => {
    const run = python([WALK, '--help']);
    expect(run.status).toBe(0);
    const help = run.lines.join('\n');
    for (const name of [
      '--password-file',
      '--shared-path',
      '--postgres-image',
      '--commit-interval-ms',
      '--flood-seconds',
      '--commit-gap-bound',
      '--throttle-seconds',
    ]) {
      expect(help).toContain(name);
    }
  });

  it('names L05 and both halves of the check', () => {
    const header = readFileSync(WALK, 'utf8').split('\n').slice(0, 200).join('\n');
    expect(header).toContain('WALK-LOGS-VOLUME-FLOOD');
    expect(header).toMatch(/ADR-016 L05/);
    expect(header).toContain('10 %');
    expect(header).toContain('throttle-window');
    expect(header).toContain('lifemodel-motor');
    expect(header).toMatch(/What it does not cover/);
  });

  it('refuses an unknown argument and a missing password file', () => {
    expect(python([WALK, '--no-such-argument']).status).toBe(2);
    expect(python([WALK]).status).toBe(2);
  });
});

describe('a fake node for the volume flood walk', () => {
  it('passes Postgres commits with no gap past the bound', () => {
    const value = jsonLine<{ ok: boolean; errors: number; longest: number }>(
      harness('commit-pass'),
      'COMMIT'
    );
    expect(value.ok).toBe(true);
    expect(value.errors).toBe(0);
    expect(value.longest).toBeLessThanOrEqual(10);
  });

  it('fails a Postgres commit error', () => {
    const value = jsonLine<{ ok: boolean; errors: number }>(harness('commit-error'), 'COMMIT');
    expect(value.ok).toBe(false);
    expect(value.errors).toBe(1);
  });

  it('fails a margin breach past 10 % of the volume, and allows one inside it', () => {
    const value = jsonLine<{ inside: boolean; outside: boolean; detail: string }>(
      harness('margin-breach'),
      'MARGIN'
    );
    expect(value.inside).toBe(true);
    expect(value.outside).toBe(false);
    expect(value.detail).toContain('allowed');
  });

  it('fails a shared filesystem that lost space to the flood', () => {
    const value = jsonLine<{ quiet: boolean; flood: boolean }>(harness('shared-move'), 'SHARED');
    expect(value.quiet).toBe(true);
    expect(value.flood).toBe(false);
  });

  it('fails a trusted writer that lost a line, naming it', () => {
    const value = jsonLine<{ intact: boolean; lost: boolean; detail: string }>(
      harness('trusted-loss'),
      'TRUSTED'
    );
    expect(value.intact).toBe(true);
    expect(value.lost).toBe(false);
    expect(value.detail).toContain('seq 42..43');
  });

  it('judges the throttle windows and reports the rate as the limit it is', () => {
    const value = jsonLine<{ good: boolean; bad: boolean; detail: string }>(
      harness('throttle-windows'),
      'THROTTLE'
    );
    expect(value.good).toBe(true);
    expect(value.bad).toBe(false);
    expect(value.detail).toContain('task-fast: 2 window(s), input 700, accepted 120, stored 120');
  });

  it('counts each pod\'s stored lines with its own run id, over exact windows', () => {
    const value = jsonLine<{
      total: number;
      bad: string | null;
      queries: string[];
    }>(harness('stored-counts'), 'COUNTS');
    expect(value.total).toBe(42);
    expect(value.bad).toBe('store_count_value');
    expect(value.queries).toHaveLength(1);
    expect(value.queries[0]).toContain('module:"task" namespace:"lifemodel-motor"');
    expect(value.queries[0]).toContain('pod:="task-fast"');
    expect(value.queries[0]).toContain('_msg:"fast-a2"');
    expect(value.queries[0]).toContain('| stats count(*)');
    expect(value.queries[0]).toContain('_time:[1970-01-01T00:00:00.000Z, 1970-01-01T00:00:06.000Z]');
  });
  it('fails the page when a status read answered nothing', () => {
    const value = jsonLine<{ ok: boolean; bad: boolean; detail: string }>(
      harness('readings'),
      'READINGS'
    );
    expect(value.ok).toBe(true);
    expect(value.bad).toBe(false);
    expect(value.detail).toContain('timeout');
  });
});


describe('a loader page of the walk\'s largest lines', () => {
  it('stays well under the response limit and pages every record', () => {
    const value = jsonLine<{
      limit: number;
      total: number;
      collected: number | null;
      max_bytes: number;
      response_limit: number;
      pages: Array<{ records: number; bytes: number }>;
    }>(harness('loader-pages'), 'PAGES');
    expect(value.limit).toBeGreaterThan(1);
    expect(value.limit).toBeLessThan(1000);
    expect(value.collected).toBe(value.total);
    expect(value.max_bytes).toBeLessThan(value.response_limit);
    expect(value.pages.length).toBeGreaterThan(1);
    expect(value.pages[value.pages.length - 1]?.records).toBeLessThan(value.limit);
  });

  it('keeps the 1000-record cap for small lines and still pages past it', () => {
    const value = jsonLine<{
      limit: number;
      total: number;
      collected: number | null;
      max_bytes: number;
      response_limit: number;
      pages: Array<{ records: number; bytes: number }>;
    }>(harness('loader-pages', { line_bytes: 64, total: 1200 }), 'PAGES');
    expect(value.limit).toBe(1000);
    expect(value.collected).toBe(value.total);
    expect(value.pages.map((page) => page.records)).toEqual([1000, 200]);
    expect(value.max_bytes).toBeLessThan(value.response_limit);
  });

  it('keeps a refused page\'s HTTP status instead of returning an empty answer', () => {
    const value = jsonLine<{
      status: number;
      collected: number | null;
    }>(harness('loader-pages', { refuse_offset: 1024, refuse_status: 503 }), 'PAGES');
    expect(value.status).toBe(503);
    expect(value.collected).toBeNull();
  });
});

describe('the past days the evictor needs', () => {
  interface Plant {
    ok: boolean;
    writes: number;
    days: string[] | null;
    events: Array<{ kind: string; name: string }>;
  }
  it('plants two past days and requires both partitions', () => {
    const value = jsonLine<Plant>(harness('plant'), 'PLANT');
    expect(value.ok).toBe(true);
    expect(value.writes).toBe(2);
    expect(value.days).toHaveLength(2);
    expect(value.events.some((event) => event.kind === 'pass')).toBe(true);
  });

  it('is not valid when a planted day partition never appears', () => {
    const value = jsonLine<Plant>(harness('plant', { create: false }), 'PLANT');
    expect(value.ok).toBe(false);
    expect(
      value.events.some(
        (event) => event.kind === 'invalid' && event.name.includes('did not create')
      )
    ).toBe(true);
  });

  it('is not valid when retention leaves fewer than two past days', () => {
    const value = jsonLine<Plant>(harness('plant', { retention: '2d' }), 'PLANT');
    expect(value.ok).toBe(false);
    expect(
      value.events.some(
        (event) => event.kind === 'invalid' && event.name.includes('fewer than 2 past days')
      )
    ).toBe(true);
  });

  it('is not valid when the store refuses the planted records', () => {
    const value = jsonLine<Plant>(harness('plant', { insert_status: 429 }), 'PLANT');
    expect(value.ok).toBe(false);
    expect(
      value.events.some(
        (event) => event.kind === 'invalid' && event.name.includes('refused the planted records')
      )
    ).toBe(true);
  });
});
