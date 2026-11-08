/** The deployed-build walks of ADR-016 are operator scripts, not a cluster
 * simulation: these contract checks hold the parts a reviewer cannot see on a
 * test box — the PASS/FAIL lines, the restore on every exit, the password that
 * never reaches the output, and an inventory walk that reads lines only through
 * the logs API.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Walk {
  readonly path: string;
  readonly id: string;
  readonly shell: boolean;
}

const WALKS: readonly Walk[] = [
  { path: 'deploy/platform/logs-all-walk.py', id: 'WALK-LOGS-ALL', shell: false },
  { path: 'deploy/platform/logs-volume-walk.sh', id: 'WALK-LOGS-VOLUME', shell: true },
  { path: 'deploy/platform/logs-wait-walk.sh', id: 'WALK-LOGS-WAIT', shell: true },
];

function text(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('ADR-016 acceptance walks', () => {
  it.each(WALKS)('$path names its walk in its header', ({ path, id }) => {
    const header = text(path).split('\n').slice(0, 30).join('\n');
    expect(header).toContain(id);
  });

  it.each(WALKS)('$path reports one PASS/FAIL line per assertion', ({ path }) => {
    const source = text(path);
    expect(source).toContain('PASS');
    expect(source).toContain('FAIL');
    // The failure count decides the exit status, never a printed line alone.
    expect(source).toMatch(/(return 1 if |exit 1|fails|FAILS)/);
  });

  it.each(WALKS)('$path restores what it changed on every exit', ({ path, shell }) => {
    const source = text(path);
    if (shell) {
      expect(source).toMatch(/^trap \w+ EXIT/m);
      expect(source).toContain('RESTORE');
    } else {
      expect(source).toContain('finally:');
      expect(source).toContain('RESTORE');
    }
  });

  it('reads lines only through the logs API in the inventory walk', () => {
    const source = text('deploy/platform/logs-all-walk.py');
    expect(source).not.toMatch(/kubectl'?\s*,?\s*'logs'/);
    expect(source).not.toMatch(/'logs',\s*'-n'/);
    expect(source).not.toContain('crictl');
    // The only line source is the loader's own query route.
    expect(source).toContain('/api/logs');
    // A pod the API does not name is judged by its files' size and age, never
    // by reading them.
    expect(source).toContain('st_size');
    expect(source).toContain('st_mtime');
    expect(source).not.toMatch(/open\(/);
  });

  it('keeps the password out of the inventory walk arguments and output', () => {
    const source = text('deploy/platform/logs-all-walk.py');
    expect(source).toContain('--password-file');
    expect(source).not.toMatch(/--password(?!-file)/);
    // Read from the file, never from argv or an environment value, and never printed.
    expect(source).toMatch(/read_text\(/);
    expect(source).not.toMatch(/print\([^)]*\bsecret\b/);
    expect(source).not.toMatch(/report\.[a-z_]+\([^)]*\bsecret\b/);
  });

  it.each(WALKS.filter((walk) => walk.shell))('$path parses as bash', ({ path }) => {
    const result = spawnSync('bash', ['-n', path], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('defaults the walks to the test VM and keeps every change explicit', () => {
    // The two walks that reach the loader default to its installed host name.
    expect(text('deploy/platform/logs-all-walk.py')).toContain('boot-lifemodel.local');
    expect(text('deploy/platform/logs-volume-walk.sh')).toContain('boot-lifemodel.local');
    const volume = text('deploy/platform/logs-volume-walk.sh');
    expect(volume).toContain('var-lib-lifemodel\\x2dlogs.mount');
    expect(volume).toContain('/var/lib/lifemodel-logs/data');
    const wait = text('deploy/platform/logs-wait-walk.sh');
    expect(wait).toContain('platform-logs-store');
    expect(wait).toContain('reconcile.fluxcd.io/requestedAt');
    expect(wait).toContain('wait: false');
  });

  it('waits for the logs API answer after the remount within its argument', () => {
    const volume = text('deploy/platform/logs-volume-walk.sh');
    expect(volume).toContain('--api-wait');
    expect(volume).toMatch(/^API_WAIT=60$/m);
    expect(volume).toMatch(/wait_until "\$API_WAIT" logs_api_answers/);
    // The single-shot form would fail on the Service's readiness lag again.
    expect(volume).not.toContain("check 'the logs API answers after the remount'");
  });
});

/** A fake node for the inventory walk: one Running pod per entry, with the
 * kubelet log files the walk inspects for size and age. */
interface FakePod {
  readonly namespace: string;
  readonly name: string;
  readonly uid: string;
  readonly module: string;
  readonly files: readonly ('empty' | 'recent' | 'stale')[];
  readonly found: boolean;
}

interface InventoryRun {
  readonly status: number | null;
  readonly failures: readonly string[];
  readonly notes: readonly string[];
}

const LOOKBACK_HOURS = 336;
const HOUR_MS = 3_600_000;

function runInventory(pods: readonly FakePod[]): InventoryRun {
  const dir = mkdtempSync(join(tmpdir(), 'logs-all-walk-'));
  const now = Date.now();
  try {
    const items = pods.map((pod) => ({
      metadata: {
        name: pod.name,
        namespace: pod.namespace,
        uid: pod.uid,
        labels: { 'app.kubernetes.io/name': pod.module },
      },
      status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
    }));
    writeFileSync(join(dir, 'pods.json'), JSON.stringify({ items }));

    const logRoot = join(dir, 'var', 'log', 'pods');
    const records: Record<string, unknown[]> = {};
    for (const pod of pods) {
      const container = join(logRoot, `${pod.namespace}_${pod.name}_${pod.uid}`, 'app');
      mkdirSync(container, { recursive: true });
      pod.files.forEach((kind, index) => {
        const file = join(container, `${index}.log`);
        writeFileSync(file, kind === 'empty' ? '' : 'a line\n');
        const older = kind === 'stale' ? (LOOKBACK_HOURS + 24) * HOUR_MS : HOUR_MS;
        utimesSync(file, (now - older) / 1000, (now - older) / 1000);
      });
      if (!pod.found) continue;
      records[pod.module] = [
        {
          time: new Date(now).toISOString(),
          fields: { pod: pod.name, namespace: pod.namespace, module: pod.module },
        },
      ];
    }

    const kubectl = join(dir, 'kubectl');
    writeFileSync(kubectl, `#!/bin/sh\ncat ${join(dir, 'pods.json')}\n`);
    chmodSync(kubectl, 0o755);
    writeFileSync(
      join(dir, 'fixture.json'),
      JSON.stringify({ kubectl, logRoot, records, lookbackHours: LOOKBACK_HOURS })
    );

    const result = spawnSync(
      'python3',
      [
        join('tests', 'fixtures', 'logs-all-walk-harness.py'),
        join('deploy', 'platform', 'logs-all-walk.py'),
        join(dir, 'fixture.json'),
      ],
      { encoding: 'utf8' }
    );
    expect(result.error).toBeUndefined();
    const lines = result.stdout.split('\n');
    return {
      status: result.status,
      failures: lines.filter((line) => line.startsWith('FAIL ')),
      notes: lines.filter((line) => line.startsWith('NOTE ')),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FOUND: FakePod = {
  namespace: 'lifemodel',
  name: 'core-0',
  uid: '4b7d0a41-0000-4000-8000-000000000001',
  module: 'core',
  files: ['recent'],
  found: true,
};

describe('the inventory walk on a fake node', () => {
  it('notes a pod whose newest log file is older than the lookback', () => {
    const run = runInventory([
      FOUND,
      {
        namespace: 'kube-system',
        name: 'svclb-traefik-9f4b7c2d1',
        uid: '4b7d0a41-0000-4000-8000-000000000002',
        module: 'traefik',
        files: ['stale'],
        found: false,
      },
    ]);
    const noted = run.notes.join('\n');
    expect(noted).toContain('kube-system/svclb-traefik-9f4b7c2d1');
    expect(noted).toContain('last line older than the lookback');
    expect(run.failures).toEqual([]);
    expect(run.status).toBe(0);
  });

  it('notes a pod whose log files are all empty', () => {
    const run = runInventory([
      FOUND,
      {
        namespace: 'lifemodel-system',
        name: 'model-gateway-55676495fc-q7x2m',
        uid: '4b7d0a41-0000-4000-8000-000000000003',
        module: 'model-gateway',
        files: ['empty'],
        found: false,
      },
    ]);
    const noted = run.notes.join('\n');
    expect(noted).toContain('lifemodel-system/model-gateway-55676495fc-q7x2m');
    expect(noted).toContain('wrote no line');
    expect(run.failures).toEqual([]);
    expect(run.status).toBe(0);
  });

  it('still fails a pod whose log files hold a line inside the lookback', () => {
    const run = runInventory([
      FOUND,
      {
        namespace: 'lifemodel-system',
        name: 'chat-6c8d9f7b4d-mm4tz',
        uid: '4b7d0a41-0000-4000-8000-000000000004',
        module: 'chat',
        files: ['recent'],
        found: false,
      },
    ]);
    expect(run.notes).toEqual([]);
    expect(run.failures.join('\n')).toContain('pod lifemodel-system/chat-6c8d9f7b4d-mm4tz');
    expect(run.failures.join('\n')).toContain('is found through the logs API');
    expect(run.status).toBe(1);
  });
});
