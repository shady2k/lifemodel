/**
 * No test can reach the repository whose hook started the suite
 * (lifemodel-q4x.4.2). A SENTINEL repository stands in for it: an inherited
 * GIT_DIR names it, and a fixture that runs `git init && git commit` in its own
 * temporary directory must leave it untouched once the environment is scrubbed.
 */
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { gitVariables, scrubGitEnvironment } from '../helpers/git-isolation.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  const run = spawnSync(
    'git',
    ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args],
    { cwd, env, encoding: 'utf8' }
  );
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

/** A repository with one commit, standing in for the one a hook runs in. */
function sentinel(): { dir: string; head: () => string; config: () => string } {
  const dir = tempDir('git-sentinel-');
  const clean = scrubGitEnvironment({ ...process.env });
  git(dir, ['init', '-q'], clean);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'the real work'], clean);
  return {
    dir,
    head: () => git(dir, ['rev-parse', 'HEAD'], clean),
    config: () => readFileSync(join(dir, '.git', 'config'), 'utf8'),
  };
}

/** What a test fixture does: a repository of its own, a commit, a remote. */
function fixture(env: NodeJS.ProcessEnv): void {
  const dir = tempDir('git-fixture-');
  git(dir, ['init', '-q'], env);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'a fixture commit'], env);
  git(dir, ['remote', 'add', 'upstream', 'https://example.com/fixture.git'], env);
}

/** The environment a git hook hands the suite, naming the sentinel. */
function hookEnvironment(repo: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_DIR: join(repo, '.git'),
    GIT_WORK_TREE: repo,
    GIT_INDEX_FILE: join(repo, '.git', 'index'),
  };
}

describe('a suite started from a git hook', () => {
  it('lets a fixture write into the hook repository when GIT_* is inherited (the hazard is real)', () => {
    const repo = sentinel();
    const before = repo.head();

    fixture(hookEnvironment(repo.dir));

    expect(repo.head()).not.toBe(before);
    expect(repo.config()).toContain('[remote "upstream"]');
  });

  it('leaves the hook repository untouched once the environment is scrubbed', () => {
    const repo = sentinel();
    const before = repo.head();
    const configBefore = repo.config();

    const env = hookEnvironment(repo.dir);
    expect(scrubGitEnvironment(env).sort()).toEqual(['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']);
    fixture(env);

    expect(repo.head()).toBe(before);
    expect(repo.config()).toBe(configBefore);
  });

  it('runs every test file with no GIT_* variable, through the vitest setup', () => {
    expect(gitVariables(process.env)).toEqual([]);
    const config = readFileSync(
      fileURLToPath(new URL('../../vitest.config.ts', import.meta.url)),
      'utf8'
    );
    expect(config).toContain("setupFiles: ['tests/setup/scrub-git-env.ts']");
  });

  it('runs git only on the child worktree when git names the commit index explicitly', () => {
    // `git commit --only <path>` gives the hook a commit-specific
    // GIT_INDEX_FILE; the suite's scrub still removes it before any test's git
    // runs (the child below gets the same environment a hook hands the suite,
    // WITH that index named, and the real setup executes before its git).
    const repo = sentinel();
    const before = repo.head();
    const configBefore = repo.config();

    const env = hookEnvironment(repo.dir);
    env['GIT_COMMON_DIR'] = join(repo.dir, '.git');
    fixture(scrubGitEnvironment(env));

    expect(repo.head()).toBe(before);
    expect(repo.config()).toBe(configBefore);
  });

  it('has the husky hook drop GIT_* in the product-checks subshell only, keeping the gates’ git environment', () => {
    const hook = readFileSync(
      fileURLToPath(new URL('../../.husky/pre-commit', import.meta.url)),
      'utf8'
    );
    const lines = hook.split('\n');
    const lineOf = (needle: string): number => lines.findIndex((line) => line.includes(needle));
    const subshellLine = lines.findIndex((line) => line.trim() === '(');
    const closeLine = lines.findIndex((line) => line.trim() === ')');
    const unsetLine = lineOf('unset "$_var"');
    const gateLine = lineOf('node .backlog/gate.mjs');
    const startLine = lineOf('npx lint-staged');
    const testsLine = lineOf('npx vitest run');
    // The comment mentions the command too; the actual guard line is exact.
    const guardLine = lines.findIndex((line) => line.trim().startsWith('if git diff --cached'));
    // After lint-staged, before the tests: the checks run env-clean.
    expect(unsetLine).toBeGreaterThan(startLine);
    expect(unsetLine).toBeLessThan(testsLine);
    // ...inside a subshell...
    expect(subshellLine).toBeGreaterThan(startLine);
    expect(unsetLine).toBeGreaterThan(subshellLine);
    expect(closeLine).toBeGreaterThan(unsetLine);
    // ...and the hook's own gates AFTER the subshell keep the hook's git
    // environment: the tracker guard judges the commit's index, not the
    // repository's default one (git commit --only names another).
    expect(closeLine).toBeLessThan(guardLine);
    expect(gateLine).toBeGreaterThan(closeLine);
  });

  it('has the husky hook drop GIT_* after lint-staged and before the tests', () => {
    const hook = readFileSync(
      fileURLToPath(new URL('../../.husky/pre-commit', import.meta.url)),
      'utf8'
    );
    const unset = hook.indexOf('unset "$_var"');
    expect(unset).toBeGreaterThan(hook.indexOf('npx lint-staged'));
    expect(unset).toBeLessThan(hook.indexOf('npx vitest run'));
  });
});

/**
 * The setup INTEGRATION, in a REAL child process (lifemodel-q4x.4.2, review
 * finding 7). The in-process guards cannot see a removed setup invocation: a
 * test file reaching this suite ALREADY has a scrubbed environment, so "no
 * GIT_* left" proves nothing about how it got that way, and the hook-environment
 * tests scrub explicitly by hand. The child below starts DIRTY - the sentinel
 * GIT_* sit in its environment, exactly what a hook hands the suite - and the
 * REAL setup module is the only thing between that environment and its git.
 *
 * Redness without the fix is part of the proof: the `noscrub` child runs the
 * same git fixture without any scrub and, because the hazard is real, the
 * sentinel MOVES - which is what this guard would report if the suite ever
 * reached git without the setup.
 */
describe('the setup integration against a removed invocation', { timeout: 60_000 }, () => {
  const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx');
  const CHILD = join(process.cwd(), 'tests', 'fixtures', 'git-isolation-child.ts');

  function runChild(
    mode: 'setup' | 'noscrub',
    repoDir: string,
    envWithSentinels: NodeJS.ProcessEnv
  ): Promise<{ status: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(
        TSX,
        [CHILD, mode, repoDir],
        { cwd: process.cwd(), env: envWithSentinels, encoding: 'utf8' },
        (error, stdout, stderr) => {
          const status =
            error && typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : 0;
          resolve({ status, stdout, stderr });
        }
      );
    });
  }

  it('the real setup keeps the sentinel safe in a child whose environment was handed to it dirty', async () => {
    const repo = sentinel();
    const before = repo.head();

    // What a hook hands the suite: GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE and
    // GIT_COMMON_DIR all name the repository the hook runs in.
    const env = hookEnvironment(repo.dir);
    env['GIT_COMMON_DIR'] = join(repo.dir, '.git');

    const child = await runChild('setup', repo.dir, { ...process.env, ...env });
    expect(child.status).toBe(0);
    expect(child.stderr).not.toContain('CHILD-FAIL');
    expect(child.stdout).toContain('CHILD-OK');
    expect(repo.head()).toBe(before);
  });

  it('without the setup the SAME environment does reach the sentinel (the mutation goes red)', async () => {
    const repo = sentinel();
    const env = hookEnvironment(repo.dir);
    env['GIT_COMMON_DIR'] = join(repo.dir, '.git');

    const child = await runChild('noscrub', repo.dir, { ...process.env, ...env });
    expect(child.status).toBe(0);
    expect(child.stdout).toContain('CHILD-REACHED-SENTINEL');
  });
});

