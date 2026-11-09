/** The stage-2 deployed-build walks of ADR-016 (L06, L08, L14, L15, L16) are
 * operator scripts, not a cluster simulation. These checks hold what a reviewer
 * cannot see on this box: the header that states what each walk proves, the
 * PASS/FAIL/NOTE lines, the restore on every exit, the `TEST NOT VALID` exit,
 * the password that is read from a file and never printed, and the clients the
 * five Python walks share through `deploy/platform/logs_walk_support.py`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Walk {
  readonly path: string;
  readonly id: string;
  /** The browser walk has no cluster client: it is run by hand outside the repo. */
  readonly browser: boolean;
}

export const STAGE2_WALKS: readonly Walk[] = [
  { path: 'deploy/platform/logs-fresh-walk.py', id: 'WALK-LOGS-FRESH', browser: false },
  { path: 'deploy/platform/logs-setting-walk.py', id: 'WALK-LOGS-SETTING', browser: false },
  { path: 'deploy/platform/logs-bound-walk.py', id: 'WALK-LOGS-BOUND', browser: false },
  { path: 'deploy/platform/logs-evict-walk.py', id: 'WALK-LOGS-EVICT', browser: false },
  { path: 'deploy/platform/logs-latency-walk.py', id: 'WALK-LOGS-LATENCY', browser: false },
  { path: 'deploy/platform/logs-page-walk.mjs', id: 'WALK-LOGS-PAGE', browser: true },
];

const SUPPORT = 'deploy/platform/logs_walk_support.py';

function text(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('the stage-2 walks share one set of clients', () => {
  it('keeps the loader, store, kubectl and volume clients in one file', () => {
    const support = text(SUPPORT);
    for (const name of ['class Loader', 'class Store', 'class Cluster', 'class Volume', 'class Report']) {
      expect(support).toContain(name);
    }
    // A walk does not copy the clients: it imports the one module beside it.
    for (const walk of STAGE2_WALKS.filter((entry) => !entry.browser)) {
      expect(text(walk.path)).toMatch(/^from logs_walk_support import/m);
    }
  });

  it('never prints a secret, a key or an environment', () => {
    const support = text(SUPPORT);
    expect(support).not.toMatch(/print\([^)]*secret/);
    expect(support).toMatch(/def secret_value/);
    // The key is read into a variable and travels in a request body or query only.
    expect(support).not.toMatch(/print\([^)]*partition_key/);
  });

  it('compiles as Python', () => {
    const result = spawnSync('python3', ['-m', 'py_compile', SUPPORT], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});

describe.each(STAGE2_WALKS)('$path', ({ path, id, browser }) => {
  it('names its walk and states what it proves, changes and restores', () => {
    const header = text(path).split('\n').slice(0, 80).join('\n');
    expect(header).toContain(id);
    expect(header).toMatch(/What it proves/);
    expect(header).toMatch(/What it changes/);
    // The row it covers is named so a reviewer can follow it from the ADR (the
    // page walk serves the ADR's sections and PRA-001, not one constraint row).
    expect(header).toMatch(browser ? /ADR-016/ : /ADR-016 L\d\d/);
  });

  it('reports PASS, FAIL and NOTE lines and exits on the failure count', () => {
    const source = text(path);
    if (browser) {
      expect(source).toContain('PASS');
      expect(source).toContain('FAIL');
      expect(source).toContain('NOTE');
    } else {
      // The five Python walks print through the one Report beside them, so a
      // verdict line cannot drift per script.
      expect(source).toMatch(/Report\(/);
      expect(source).toContain('report.check(');
    }
    // The exit status comes from the failure count, never a printed line alone.
    if (browser) {
      expect(source).toMatch(/process\.exit\(failures \? 1 : 0\)/);
    } else {
      expect(source).toContain('return report.result()');
    }
  });

  it('marks a walk that never reached the state it asserts on', () => {
    const source = text(path);
    if (browser) {
      expect(source).toContain('TEST NOT VALID');
    } else {
      expect(source).toMatch(/not_valid\(/);
      expect(text('deploy/platform/logs_walk_support.py')).toContain('TEST NOT VALID');
    }
  });

  it('restores what it changed on every exit and says so', () => {
    const source = text(path);
    expect(source).toContain('RESTORE');
    expect(source).toMatch(browser ? /finally\s*\{/ : /finally:/);
  });

  it('takes the password from a file and never prints it', () => {
    const source = text(path);
    expect(source).toMatch(browser ? /password-file|pwFile/ : /--password-file/);
    expect(source).not.toMatch(/--password(?!-file)/);
    expect(source).not.toMatch(/print\([^)]*secret/);
    expect(source).not.toMatch(/console\.log\([^)]*secret/);
  });

  it('defaults to the test VM', () => {
    expect(text(path)).toContain('boot-lifemodel.local');
  });

  it('uses k3s kubectl where it reaches the cluster', () => {
    const source = text(path);
    if (browser) {
      expect(source).not.toContain('kubectl');
      return;
    }
    expect(source).toContain('k3s kubectl');
  });
});
