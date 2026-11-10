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

function harness(mode: string): Run {
  const fixture = join(directory, mode + '.json');
  writeFileSync(fixture, '{}');
  return python([HARNESS, mode, WALK, fixture]);
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'logs-volume-flood-walk-'));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('the volume flood walk\'s arguments and header', () => {
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
      '--metrics-port',
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
    expect(header).toContain('127.0.0.1:9598');
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
      'COMMIT',
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
      'MARGIN',
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
      'TRUSTED',
    );
    expect(value.intact).toBe(true);
    expect(value.lost).toBe(false);
    expect(value.detail).toContain('seq 42..43');
  });

  it('judges the throttle windows and reports the rate as the limit it is', () => {
    const value = jsonLine<{ good: boolean; bad: boolean; detail: string }>(
      harness('throttle-windows'),
      'THROTTLE',
    );
    expect(value.good).toBe(true);
    expect(value.bad).toBe(false);
    expect(value.detail).toContain('500 events per second per pod');
  });

  it('fails the page when a status read answered nothing', () => {
    const value = jsonLine<{ ok: boolean; bad: boolean; detail: string }>(
      harness('readings'),
      'READINGS',
    );
    expect(value.ok).toBe(true);
    expect(value.bad).toBe(false);
    expect(value.detail).toContain('timeout');
  });
});
