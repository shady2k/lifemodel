/** WALK-LOGS-CRASH (ADR-016 L07, §6): the walk is an operator script for a
 * deployed build, so these checks hold its verdict, its not-valid states and the
 * way it reads the collector's buffer against the fake node in
 * `tests/fixtures/logs-crash-walk-harness.py`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function harness(mode: string): Run {
  const fixture = join(directory, mode + '.json');
  writeFileSync(fixture, '{}');
  return python([HARNESS, mode, WALK, fixture]);
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'logs-crash-walk-'));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('the crash walk\'s argument handling', () => {
  it('prints its usage and exits 0 on --help', () => {
    const run = python([WALK, '--help']);
    expect(run.status).toBe(0);
    const help = run.lines.join('\n');
    for (const name of [
      '--password-file',
      '--collector',
      '--writer-namespace',
      '--metrics-port',
      '--crictl',
      '--fill-bound',
      '--recover-bound',
      '--saturated-seconds',
      '--unsaturated-lines',
    ]) {
      expect(help).toContain(name);
    }
  });

  it('refuses an unknown argument and a missing password file', () => {
    expect(python([WALK, '--no-such-argument']).status).toBe(2);
    expect(python([WALK]).status).toBe(2);
  });
});

describe('the crash walk states its rows and what it cannot prove', () => {
  it('names its walk, L07, the buffer gauges and the kubelet verdict', () => {
    const header = readFileSync(WALK, 'utf8').split('\n').slice(0, 200).join('\n');
    expect(header).toContain('WALK-LOGS-CRASH');
    expect(header).toMatch(/ADR-016 L07/);
    expect(header).toContain('vector_buffer_size_events');
    expect(header).toContain('vector_buffer_max_size_events');
    expect(header).toContain('/var/log/pods');
    expect(header).toContain('kill -9');
    expect(header).toMatch(/What it does not cover/);
  });

  it('says exactly what the saturated case needs when nothing exposes the buffer', () => {
    const run = harness('not-valid-buffer');
    const value = jsonLine<{ text: string; saturated: boolean }>(run, 'GAP');
    expect(value.saturated).toBe(false);
    expect(value.text).toContain('internal_metrics');
    expect(value.text).toContain('prometheus_exporter');
    expect(value.text).toContain('vector.yaml');
  });

  it('fails the kill when crictl reports pid 1', () => {
    const run = harness('not-valid-pid');
    const value = jsonLine<{ pid: number | null; detail: string }>(run, 'PID');
    expect(value.pid).toBeNull();
    expect(value.detail).toContain('pid 1');
    expect(value.detail).toContain('nothing would be killed');
  });

  it('kills the vector process by a real pid', () => {
    const run = harness('pid-real');
    expect(jsonLine<{ pid: number }>(run, 'PID').pid).toBe(4242);
  });
});

describe('a fake node for the crash walk', () => {
  it('passes when every line still in the kubelet\'s files was delivered', () => {
    const run = harness('verdict-pass');
    const value = jsonLine<{ ok: boolean; detail: string }>(run, 'VERDICT');
    expect(value.ok).toBe(true);
    expect(value.detail).toContain('2 duplicated');
  });

  it('fails a line lost while still in the kubelet\'s files, naming it', () => {
    const run = harness('verdict-lost');
    const value = jsonLine<{ ok: boolean; detail: string }>(run, 'VERDICT');
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("lost while still in the kubelet's files: seq 7..8");
  });

  it('allows a line the kubelet has rotated away', () => {
    const run = harness('verdict-rotated');
    const value = jsonLine<{ ok: boolean; detail: string }>(run, 'VERDICT');
    expect(value.ok).toBe(true);
    expect(value.detail).toContain('3 rotated away');
  });
});
