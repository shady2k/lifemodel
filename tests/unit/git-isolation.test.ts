/**
 * No test can reach the repository whose hook started the suite
 * (lifemodel-q4x.4.2). A SENTINEL repository stands in for it: an inherited
 * GIT_DIR names it, and a fixture that runs `git init && git commit` in its own
 * temporary directory must leave it untouched once the environment is scrubbed.
 */
import { spawnSync } from 'node:child_process';
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
