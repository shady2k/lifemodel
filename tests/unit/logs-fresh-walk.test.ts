/** WALK-LOGS-FRESH (ADR-016 L14): the walk is an operator script, so these
 * checks hold its contract and its decisions — the 90 s threshold, the
 * stopped/live/read-only split, and the `TEST NOT VALID` exit for a walk that
 * never stopped the collector — against the fake node in
 * `tests/fixtures/logs-walk-stage2-harness.py`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const WALK = join('deploy', 'platform', 'logs-fresh-walk.py');
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
  directory = mkdtempSync(join(tmpdir(), 'logs-fresh-walk-'));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('the fresh walk\'s argument handling', () => {
  it('prints its usage and exits 0 on --help', () => {
    const run = python([WALK, '--help']);
    expect(run.status).toBe(0);
    const help = run.lines.join('\n');
    for (const name of [
      '--password-file',
      '--loader-host',
      '--stopped-bound',
      '--live-bound',
      '--fill-timeout',
      '--heartbeat-fresh',
      '--stop-label-key',
    ]) {
      expect(help).toContain(name);
    }
    expect(help).toContain('WALK-LOGS-FRESH');
  });

  it('refuses an unknown argument', () => {
    const run = python([WALK, '--no-such-argument']);
    expect(run.status).toBe(2);
  });

  it('refuses to run without a password file', () => {
    const run = python([WALK]);
    expect(run.status).toBe(2);
  });

  it('fails cleanly when the password file does not exist', () => {
    const run = python([WALK, '--password-file', join(directory, 'absent')]);
    expect(run.status).toBe(1);
    expect(run.failures.join('\n')).toContain('the credential file is readable');
  });
});

describe('the fresh walk states its cases and its limits', () => {
  it('names the collector stop, the pod-log stall, the read-only store and the unknown state', () => {
    const header = readFileSync(WALK, 'utf8').split('\n').slice(0, 140).join('\n');
    expect(header).toContain('WALK-LOGS-FRESH');
    expect(header).toContain('ADR-016 L14');
    expect(header).toMatch(/collection stopped/);
    expect(header).toMatch(/\/var\/log\/pods/);
    expect(header).toMatch(/read-only/);
    expect(header).toMatch(/collection status unknown|before any heartbeat/);
    expect(header).toMatch(/What it does not cover/);
  });

  it('states what the store\'s own source says about the read-only state', () => {
    const header = readFileSync(WALK, 'utf8').split('\n').slice(0, 140).join('\n');
    // The decision, the free-space number it compares, its cache, and the gauge
    // the loader reads: each with the store source's own file and line.
    expect(header).toContain('lib/logstorage/storage.go:1335');
    expect(header).toContain('f_bavail');
    expect(header).toContain('fs.go:297');
    expect(header).toContain('429 Too Many Requests');
    expect(header).toContain('vl_storage_is_read_only');
    expect(header).toContain('app/vlstorage/main.go:697');
  });

  it('asserts on the API status and never on the screen', () => {
    const source = readFileSync(WALK, 'utf8');
    expect(source).toContain('logs_status');
    expect(source).not.toMatch(/playwright|locator\(|screenshot/);
  });

  it('keeps the 90 s threshold the page uses', () => {
    expect(readFileSync(WALK, 'utf8')).toContain('STOPPED_THRESHOLD_MS = 90_000');
  });
});

describe('a fake node for the fresh walk', () => {
  it('marks a collector that never stops as TEST NOT VALID and fails', () => {
    const run = harness('fresh-never-stopped');
    expect(run.failures.join('\n')).toContain('the collector is stopped');
    expect(run.invalid.join('\n')).toContain('the collector never stopped');
    expect(run.status).toBe(1);
  }, 30000);

  it('passes the stopped assertion and carries the age past the threshold', () => {
    const run = harness('fresh-stopped');
    const pass = run.passes.join('\n');
    expect(pass).toContain('the collector is stopped');
    expect(pass).toContain('the API says collection stopped while the collector is stopped');
    expect(pass).toContain('stoppedForMs=140000');
    // The pod-log half of the walk still has no state to assert on this fake.
    expect(run.invalid.length).toBeGreaterThan(0);
  }, 30000);

  it('passes the read-only assertion when the API and the gauge both say so', () => {
    const run = harness('fresh-read-only');
    const pass = run.passes.join('\n');
    expect(pass).toContain('the API says the store is refusing writes (read-only)');
    expect(pass).toContain('vl_storage_is_read_only gauge is 1');
    expect(run.failures).toEqual([]);
    expect(run.status).toBe(0);
  }, 30000);

  it('fails, without hiding it as invalid, when the API never reports read-only', () => {
    const run = harness('fresh-read-only-never');
    expect(run.failures.join('\n')).toContain('the API says the store is refusing writes');
    expect(run.failures.join('\n')).toContain('vl_storage_is_read_only gauge is 1');
    expect(run.invalid).toEqual([]);
    expect(run.status).toBe(1);
  }, 30000);

  it('keeps probing until the store refuses, and lists every answer', () => {
    const run = harness('fresh-refused-late');
    expect(jsonLine<{ status: number; answers: number[] }>(run, 'REFUSED')).toEqual({
      status: 429,
      answers: [200, 200, 429],
    });
  }, 30000);

  it('says what the store answered each time it never refuses', () => {
    const run = harness('fresh-refused-never');
    expect(jsonLine<{ status: number; answers: number[] }>(run, 'REFUSED')).toEqual({
      status: 200,
      answers: [200],
    });
    expect(run.notes.join('\n')).toContain('never refused a write');
    expect(run.notes.join('\n')).toContain('answered 200');
  }, 30000);

  it('restores each change once and leaves nothing for the final restore to redo', () => {
    const run = harness('fresh-restore-twice');
    expect(jsonLine<Record<string, unknown>>(run, 'RESTORE')).toEqual({
      stopped: true,
      stalled: true,
      selector: [true, true],
      pods: [true, true],
      patches: 4,
    });
    expect(run.lines.join('\n')).toContain('RESTORE collector lifemodel-logs/logs-collector Ready');
    expect(run.lines.join('\n')).not.toContain('RESTORE incomplete');
  }, 30000);

  it('names the step that did not put the machine back', () => {
    const run = harness('fresh-restore-report');
    const incomplete = run.lines.find((line) => line.startsWith('RESTORE incomplete:'));
    expect(incomplete).toContain('the collector nodeSelector');
    expect(incomplete).toContain('the collector pod-log volume');
  }, 30000);

  it('reports an unreached fill as not reached, never as an assertion', () => {
    const run = harness('fresh-fill-never');
    const reached = run.lines.find((line) => line.startsWith('REACHED '));
    expect(reached).toBe('REACHED False 2147483648 805306368');
  }, 30000);
});
