/** Root-filesystem evidence for ADR-016 L05, separate from log-volume usage. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Result {
  actual?: {
    root_free_bytes: number;
    allocated_bytes: Record<string, number | null>;
    unreadable: Record<string, string>;
  };
  expected?: Record<string, number>;
  verdict?: {
    ok: boolean;
    root_drop_bytes: number;
    category_deltas: Record<string, number>;
    accounted_growth_bytes: number;
    unattributed_drop_bytes: number;
    allowance_bytes: number;
  } | null;
  notes?: string[];
  checks?: Array<{ ok: boolean; name: string; detail: string }>;
  invalid?: string[];
  usage?: Record<string, number> | null;
  timed_out?: Record<string, number> | null;
  growth?: Array<[string, number]>;
}

function run(mode: string): Result {
  const result = spawnSync(
    'python3',
    [
      join('tests', 'fixtures', 'logs-flood-accounting-harness.py'),
      mode,
      join('deploy', 'platform', 'logs_flood_accounting.py'),
    ],
    { encoding: 'utf8' }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Result;
}

describe('root filesystem allocated-byte accounting', () => {
  it('counts allocated blocks, rotation and distinct trees, not apparent image sizes', () => {
    const value = run('tree');
    expect(value.actual?.root_free_bytes).toBe(123 * 4096);
    expect(value.actual?.allocated_bytes).toEqual(value.expected);
    expect(value.actual?.unreadable).toEqual({});
    expect(value.actual?.allocated_bytes.images).toBeLessThan(128 * 1024 * 1024);
  });

  it.each(['missing', 'unreadable'])(
    'records a %s tree as unreadable with its reason',
    (mode) => {
      const value = run(mode);
      expect(value.actual?.allocated_bytes.container_logs).toBeNull();
      expect(value.actual?.unreadable.container_logs).toMatch(
        mode === 'missing' ? /FileNotFoundError/ : /PermissionError/
      );
    }
  );

  it('judges the root growth on the trees that were read when one could not be', () => {
    const value = run('partial');
    expect(value.verdict).toMatchObject({
      ok: true,
      root_drop_bytes: 3000,
      accounted_growth_bytes: 2200,
      unattributed_drop_bytes: 800,
      allowance_bytes: 800,
    });
    expect(value.verdict?.category_deltas).toEqual({
      images: 1000,
      walk_writer_logs: 0,
      k3s_datastore: 0,
      journal: 0,
      kubelet: 0,
      postgres: 1000,
      walk_files: 200,
    });
    expect(value.invalid).toEqual([]);
    const notes = value.notes?.join('\n') ?? '';
    expect(notes).toContain('container_logs');
    expect(notes).toContain('PermissionError');
    expect(value.checks?.map((check) => check.ok)).toEqual([true]);
  });

  it('subtracts measured image, container-log, Postgres and walk-file growth separately', () => {
    const value = run('explained');
    expect(value.verdict).toMatchObject({
      ok: true,
      root_drop_bytes: 3000,
      category_deltas: {
        images: 1000,
        container_logs: 500,
        walk_writer_logs: 500,
        k3s_datastore: 0,
        journal: 0,
        kubelet: 0,
        postgres: 1000,
        walk_files: 200,
      },
      accounted_growth_bytes: 3200,
      unattributed_drop_bytes: 0,
      allowance_bytes: 300,
    });
    expect(value.invalid).toEqual([]);
    const notes = value.notes?.join('\n') ?? '';
    for (const name of ['images', 'container_logs', 'walk_writer_logs',
      'k3s_datastore', 'journal', 'kubelet', 'postgres', 'walk_files']) {
      expect(notes).toContain(name);
    }
    expect(notes).toContain('10000');
    expect(notes).toContain('7000');
    expect(notes).toContain('3200');
    expect(notes).toContain('0');
    expect(value.checks?.map((check) => check.ok)).toEqual([true]);
  });

  it('fails unexplained residual growth without calling all root loss flood data', () => {
    const value = run('unexplained');
    expect(value.verdict).toMatchObject({
      ok: false,
      unattributed_drop_bytes: 1300,
    });
    expect(value.checks?.map((check) => check.ok)).toEqual([false]);
    expect(value.notes?.join('\n')).toContain('unattributed');
    expect(value.notes?.join('\n')).toContain(
      'top growing directories under / between the two readings (du -x, depth 2): ' +
        '/var/lib +800, /var/log +10, /new +5'
    );
  });

  it('counts the k3s datastore, journal and kubelet trees beside the walk\'s own', () => {
    const value = run('tree');
    expect(value.actual?.allocated_bytes.k3s_datastore).toBeGreaterThan(0);
    expect(value.actual?.allocated_bytes.journal).toBeGreaterThan(0);
    expect(value.actual?.allocated_bytes.kubelet).toBeGreaterThan(0);
  });

  it('reads one-filesystem directory usage with a time bound', () => {
    const value = run('du');
    expect(value.usage).toEqual({ '/': 4096, '/var': 8192, '/var/log': 16384 });
    expect(value.timed_out).toBeNull();
  });

  it('reports the ten largest growing directories, largest first', () => {
    const value = run('growth');
    expect(value.growth).toHaveLength(10);
    expect(value.growth?.[0]).toEqual(['/s11', 110]);
    expect(value.growth?.[9]).toEqual(['/s2', 20]);
  });

  it('uses signed net changes so image deletion cannot hide unexplained growth', () => {
    const value = run('deletions');
    expect(value.verdict).toMatchObject({
      ok: false,
      accounted_growth_bytes: 0,
      unattributed_drop_bytes: 1000,
    });
    expect(value.verdict?.category_deltas.images).toBe(-900);
  });

  it('reports no positive root drop when free space increased', () => {
    expect(run('freed').verdict).toMatchObject({
      ok: true,
      unattributed_drop_bytes: 0,
    });
  });

  it.each(['unknown', 'negative', 'errors'])(
    'judges the trees that were read when %s evidence is unusable',
    (mode) => {
      const value = run(mode);
      expect(value.verdict).not.toBeNull();
      expect(value.invalid).toEqual([]);
    }
  );

  it('marks an unreadable root filesystem not valid instead of guessing the drop', () => {
    const value = run('root-unknown');
    expect(value.verdict).toBeNull();
    expect(value.invalid?.length).toBeGreaterThan(0);
    expect(value.checks).toEqual([]);
  });
});
