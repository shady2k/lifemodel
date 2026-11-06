/**
 * Tests for the repeat runner (scripts/ci-repeat-changed-tests.sh).
 *
 * CI runs this once, after the full check, on a pull request: it diffs the
 * merge base of the base branch and the pull request head, selects the added
 * or changed test files, and calls the isolated launcher (lifemodel-hbsi).
 *
 * These tests build a real temporary Git repository, so the real diff, the
 * real merge base and Git's own path quoting are what the script sees. The
 * launcher is a stub that records its argv, so the assertion is exactly what
 * the repeat mode would be asked to run. Paths travel NUL-delimited end to
 * end: a space, a tab or a quote in a test file name must survive unchanged,
 * and a name git would C-quote must not be dropped.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../../scripts/ci-repeat-changed-tests.sh', import.meta.url));
const selector = fileURLToPath(new URL('../../scripts/ci-repeat-test-paths.sh', import.meta.url));

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  /** The argv the stub launcher received, when it ran at all. */
  launcher: string[] | undefined;
}

describe('scripts/ci-repeat-changed-tests.sh', () => {
  let dir: string;
  let headSha: string;
  let out: string;

  function git(...args: string[]): string {
    const result = spawnSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
      { cwd: dir, encoding: 'utf8' }
    );
    if (result.status !== 0)
      throw new Error(`git ${args.join(' ')} failed: ${result.stdout}${result.stderr}`);
    return result.stdout.trim();
  }

  function write(relative: string, content = 'export const value = 1;\n'): void {
    const target = join(dir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  function run(env: Record<string, string | undefined>): Run {
    if (out) rmSync(out, { force: true });
    const result = spawnSync('bash', [join(dir, 'scripts', 'ci-repeat-changed-tests.sh')], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, STUB_OUT: out, ...env },
    });
    let launcher: string[] | undefined;
    try {
      launcher = JSON.parse(readFileSync(out, 'utf8')) as string[];
    } catch {
      launcher = undefined;
    }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, launcher };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lifemodel-repeat-runner-'));
    out = join(dir, 'launcher-argv.json');
    git('init', '-q', '-b', 'main');
    // The runner and selector as committed, plus a stub launcher that records
    // exactly the argv the repeat mode would receive.
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    cpSync(runner, join(dir, 'scripts', 'ci-repeat-changed-tests.sh'));
    cpSync(selector, join(dir, 'scripts', 'ci-repeat-test-paths.sh'));
    chmodSync(join(dir, 'scripts', 'ci-repeat-changed-tests.sh'), 0o755);
    chmodSync(join(dir, 'scripts', 'ci-repeat-test-paths.sh'), 0o755);
    writeFileSync(
      join(dir, 'scripts', 'test-isolated.mjs'),
      "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.STUB_OUT, JSON.stringify(process.argv.slice(2)));\n"
    );
    // The base commit every change below starts from.
    write('tests/unit/stable.test.ts');
    write('tests/unit/changed.test.ts');
    write('tests/unit/deleted.test.ts');
    write('tests/unit/helpers/stores.ts');
    write('src/a.ts');
    git('add', '-A');
    git('commit', '-qm', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-q', '-b', 'feature');
    // The change under test: one changed test, one deleted test, a helper-only
    // change, and names that need exact bytes: a space, a tab (git quotes it
    // without -z) and a single quote.
    write('tests/unit/changed.test.ts', 'export const value = 2;\n');
    rmSync(join(dir, 'tests', 'unit', 'deleted.test.ts'));
    write('tests/unit/helpers/stores.ts', 'export const helper = 2;\n');
    write('tests/unit/with space.test.ts');
    write('tests/unit/tab\tname.test.ts');
    write("tests/unit/quote'name.test.ts");
    git('add', '-A');
    git('commit', '-qm', 'feature');
    headSha = git('rev-parse', 'HEAD');
    // Main advances after the branch point. Diffing the base branch tip instead
    // of the merge base would wrongly select this file.
    git('checkout', '-q', 'main');
    write('tests/unit/main-only.test.ts');
    git('add', '-A');
    git('commit', '-qm', 'main only');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-q', 'feature');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('diffs the merge base to the head and repeats only the changed test files', () => {
    const result = run({ BASE_REF: 'main', HEAD_SHA: headSha });
    expect(result.status).toBe(0);
    // The changed test and the three names that need exact bytes; not the
    // deleted test, not the helper, not a change only on the base branch, not
    // the unchanged test.
    expect(result.launcher).toEqual([
      'repeat',
      '--',
      'tests/unit/changed.test.ts',
      "tests/unit/quote'name.test.ts",
      'tests/unit/tab\tname.test.ts',
      'tests/unit/with space.test.ts',
    ]);
    expect(result.stdout).toContain('repeating:');
    expect(result.stdout).toContain('repeat run took');
  });

  it('refuses when BASE_REF or HEAD_SHA is missing, before any launcher call', () => {
    for (const env of [
      { BASE_REF: undefined, HEAD_SHA: headSha },
      { BASE_REF: '', HEAD_SHA: headSha },
      { BASE_REF: 'main', HEAD_SHA: undefined },
      { BASE_REF: 'main', HEAD_SHA: '' },
    ]) {
      const result = run(env);
      expect(result.status, JSON.stringify(env)).toBe(2);
      expect(result.stderr).toMatch(/BASE_REF|HEAD_SHA/);
      expect(result.launcher, JSON.stringify(env)).toBeUndefined();
    }
  });

  it('fails with exit 2 when the diff cannot be computed, never taking the empty-selection path', () => {
    const result = run({ BASE_REF: 'main', HEAD_SHA: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('the diff cannot be computed');
    expect(result.launcher).toBeUndefined();
  });
});
