/** The deployed-build walks of ADR-016 are operator scripts, not a cluster
 * simulation: these contract checks hold the parts a reviewer cannot see on a
 * test box — the PASS/FAIL lines, the restore on every exit, the password that
 * never reaches the output, and an inventory walk that reads lines only through
 * the logs API.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
});
