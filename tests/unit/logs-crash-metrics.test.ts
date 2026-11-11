/** WALK-LOGS-CRASH's collector-exporter reading: the Prometheus body, its sink
 * gauges and the reason a failed read gives, driven against the fake exporter
 * bodies in `tests/fixtures/logs-crash-walk-harness.py`.
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
  directory = mkdtempSync(join(tmpdir(), 'logs-crash-metrics-'));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('the collector exporter reading names what it actually read', () => {
  it('finds the logs-store gauge in a body of more than two thousand lines', () => {
    const value = jsonLine<{
      state: { size: number | null; events: number | null; max: number | null };
      report: { lines: number; vectorLines: number; bufferComponents: string[] };
    }>(harness('metrics-body'), 'BODY');
    expect(value.state).toMatchObject({ size: 1000, events: 10, max: 335544320 });
    expect(value.report.lines).toBeGreaterThan(2300);
    expect(value.report.bufferComponents).toContain('logs-store');
  });

  it('reads the throttle build\'s sink gauges among memory buffers and double spaces', () => {
    const value = jsonLine<{
      state: Record<string, number | string | null>;
      report: { sinkFamilies: string[] };
    }>(harness('metrics-body', { kind: 'r55' }), 'BODY');
    expect(value.state).toEqual({
      size: 37966240,
      max: 335544320,
      writable_max: 201326592,
      unit: 'bytes',
      events: 96579,
      received: null,
      sent: null,
      source_received: null,
    });
    expect(value.report.sinkFamilies).toEqual([
      'vector_buffer_max_size_bytes[disk]',
      'vector_buffer_size_bytes[disk]',
      'vector_buffer_size_events[disk]',
      'vector_buffer_size_events[memory]',
    ]);
  });

  it('names a 200 body that carries no Vector metric at all', () => {
    const value = jsonLine<{ reason: string }>(
      harness('metrics-body', { kind: 'no-vector' }),
      'BODY'
    );
    expect(value.reason).toContain('GET /metrics on pod logs-collector-x answered 200');
    expect(value.reason).toContain('no vector_ metric');
    expect(value.reason).toContain("not the collector's exporter");
  });

  it('names the buffer component ids the body did carry', () => {
    const value = jsonLine<{ reason: string }>(
      harness('metrics-body', { kind: 'no-gauge' }),
      'BODY'
    );
    expect(value.reason).toContain('no buffer gauge for component_id="logs-store"');
    expect(value.reason).toContain('buffer component ids seen: metrics, out');
  });

  it('picks the running Ready collector pod when a walk pod is listed first', () => {
    const pods = [
      {
        metadata: { name: 'walk-crash-writer', creationTimestamp: '2026-01-01T00:00:00Z' },
        status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
      },
      {
        metadata: { name: 'logs-collector-abc', creationTimestamp: '2026-01-02T00:00:00Z' },
        status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
      },
    ];
    expect(jsonLine<{ name: string }>(harness('collector-pod', { pods }), 'POD').name).toBe(
      'logs-collector-abc'
    );
  });

  it('prefers a Ready collector pod over an unready one', () => {
    const pods = [
      {
        metadata: { name: 'logs-collector-old', creationTimestamp: '2026-01-01T00:00:00Z' },
        status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }] },
      },
      {
        metadata: { name: 'logs-collector-new', creationTimestamp: '2026-01-02T00:00:00Z' },
        status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
      },
    ];
    expect(jsonLine<{ name: string }>(harness('collector-pod', { pods }), 'POD').name).toBe(
      'logs-collector-new'
    );
  });

  it('never takes a walk pod as the collector', () => {
    const pods = [{ metadata: { name: 'walk-crash-writer' }, status: { phase: 'Running' } }];
    expect(
      jsonLine<{ name: string | null }>(harness('collector-pod', { pods }), 'POD').name
    ).toBeNull();
  });
});
