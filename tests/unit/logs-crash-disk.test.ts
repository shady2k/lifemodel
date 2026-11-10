import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function run(fixture: object) {
  const result = spawnSync(
    'python3',
    [
      'tests/fixtures/logs-crash-disk-harness.py',
      'deploy/platform/logs-crash-walk.py',
      JSON.stringify(fixture),
    ],
    { encoding: 'utf8' }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as {
    saturated?: boolean;
    memory?: number;
    pid?: number;
    commands?: string[][];
    count?: number;
    queries?: { to: string; expected?: string }[];
    state?: { max: number; size: number; writable_max: number; unit: string; sent: number };
    ok?: boolean;
    events?: string[];
  };
}

describe('crash walk disk-byte evidence', () => {
  it('uses exported bytes without the memory-only maximum event gauge', () => {
    const value = run({ mode: 'disk' });
    expect(value.saturated).toBe(true);
    expect(value.state).toMatchObject({
      max: 335544320,
      size: 201326592,
      writable_max: 201326592,
      unit: 'bytes',
      sent: 100,
    });
  });

  it('requires 95% of writable bytes after the 128 MiB segment reservation', () => {
    expect(run({ mode: 'disk', size: 192 * 1024 * 1024 * 0.94 }).saturated).toBe(false);
    expect(run({ mode: 'disk', size: Math.ceil(192 * 1024 * 1024 * 0.95) }).saturated).toBe(true);
  });

  it('waits for collector restart while the store is still down, then restores the store', () => {
    expect(run({ mode: 'recovery' })).toMatchObject({
      ok: true,
      events: ['collector-ready', 'store-up', 'store-ready'],
    });
  });

  it('runs saturated, separate store-down restart, and informative cases', () => {
    expect(run({ mode: 'run-order' }).events).toEqual(['saturated', 'store-down', 'informative']);
  });

  it('exercises the real crash case lifecycle and counts every writer', () => {
    const value = run({ mode: 'case-order' });
    expect(value.ok).toBe(true);
    expect(value.events).toEqual([
      'kill',
      'collector-ready',
      'store-up',
      'store-ready',
      'walk-crash-writer',
      'walk-crash-writer-2',
      'query',
    ]);
    expect(run({ mode: 'case-order', gap: true }).ok).toBe(false);
  });

  it('waits for the fixed retained target, not merely the first delivered line', () => {
    const value = run({ mode: 'case-order', delayed: true });
    expect(value.ok).toBe(true);
    expect(value.events?.filter((event) => event === 'query')).toHaveLength(2);
  });

  it('pins pagination time and expected count for the real loader contract', () => {
    const value = run({ mode: 'pagination' });
    expect(value.count).toBe(1001);
    expect(value.queries?.[1]?.expected).toBe('1001');
    expect(value.queries?.[0]?.to).toBe(value.queries?.[1]?.to);
  });

  it('executes CRI on the node, never through the kubectl prefix', () => {
    const value = run({ mode: 'native-cri' });
    expect(value.pid).toBe(4242);
    expect(value.commands).toEqual([
      [
        'k3s',
        'crictl',
        'ps',
        '--name',
        'logs-collector',
        '--label',
        'io.kubernetes.pod.name=collector',
        '--label',
        'io.kubernetes.pod.namespace=logs',
        '--output',
        'json',
      ],
      ['k3s', 'crictl', 'inspect', 'c'],
    ]);
  });

  it('reads the CRI UInt64Value cgroup usage rather than the smaller working set', () => {
    expect(run({ mode: 'cri-memory' }).memory).toBe(104857600);
  });

  it('fails measured memory above the limit even without a restart', () => {
    expect(run({ mode: 'memory' }).ok).toBe(false);
  });

  it('reads rotated kubelet files for this pod and run, excluding another pod and run', () => {
    const root = mkdtempSync(join(tmpdir(), 'crash-kubelet-'));
    try {
      for (const pod of ['walk-ns_writer_uid', 'walk-ns_other_uid']) {
        const container = join(root, pod, 'writer');
        mkdirSync(container, { recursive: true });
        writeFileSync(
          join(container, '0.log'),
          'walk-crash wanted seq=1\nwalk-crash stale seq=9\n'
        );
        writeFileSync(join(container, '0.log.20261110'), 'walk-crash wanted seq=2\n');
      }
      const result = spawnSync(
        'python3',
        [
          'tests/fixtures/logs-crash-disk-harness.py',
          'deploy/platform/logs-crash-walk.py',
          JSON.stringify({ mode: 'kubelet', root }),
        ],
        { encoding: 'utf8' }
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([1, 2]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
