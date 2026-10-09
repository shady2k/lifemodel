/**
 * No test can reach the repository whose hook started the suite
 * (lifemodel-q4x.4.2). A SENTINEL repository stands in for it: an inherited
 * GIT_DIR names it, and a fixture that runs `git init && git commit` in its own
 * temporary directory must leave it untouched once the environment is scrubbed.
 */
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    // The scrub removes the variables IN PLACE and hands back their NAMES:
    // what git runs with is the scrubbed environment itself, not the list of
    // names (a removed-name array passed as an environment supplies numeric
    // keys instead, and a scrub that returned names without deleting would
    // stay green - review round 2, finding H).
    const removed = scrubGitEnvironment(env);
    expect(removed.sort()).toEqual(['GIT_COMMON_DIR', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']);
    fixture(env);

    expect(repo.head()).toBe(before);
    expect(repo.config()).toBe(configBefore);
  });

  it.each([false, true])(
    'dispatches the real hook with tracker staged in the commit index: %s',
    (trackerInCommit) => {
      const dir = tempDir('git-hook-dispatch-');
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      // No inherited Git settings or user/system Git configuration.
      const clean: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: dir,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      };
      git(dir, ['init', '-q'], clean);
      git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/fixture-feature'], clean);
      mkdirSync(join(dir, '.beads'));
      mkdirSync(join(dir, '.backlog'));
      const tracker = join(dir, '.beads', 'issues.jsonl');
      writeFileSync(tracker, 'base\n');
      writeFileSync(join(dir, '.backlog', 'config.json'), '{}\n');
      git(dir, ['add', '.beads/issues.jsonl', '.backlog/config.json'], clean);
      git(dir, ['commit', '-q', '-m', 'fixture base'], clean);

      const alternate = join(dir, '.git', 'commit-index');
      const alternateEnv = { ...clean, GIT_INDEX_FILE: alternate };
      git(dir, ['read-tree', 'HEAD'], alternateEnv);
      const commitContent = trackerInCommit ? 'commit\n' : 'base\n';
      const defaultContent = trackerInCommit ? 'base\n' : 'default\n';
      writeFileSync(tracker, commitContent);
      git(dir, ['add', '.beads/issues.jsonl'], alternateEnv);
      writeFileSync(tracker, defaultContent);
      git(dir, ['add', '.beads/issues.jsonl'], clean);

      const names = [
        'GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR',
        'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      ];
      const objects = join(dir, '.git', 'objects');
      const extraObjects = join(dir, 'extra-objects');
      mkdirSync(extraObjects);
      const dirty = {
        GIT_INDEX_FILE: alternate,
        GIT_DIR: join(dir, '.git'),
        GIT_WORK_TREE: dir,
        GIT_COMMON_DIR: join(dir, '.git'),
        GIT_OBJECT_DIRECTORY: objects,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: extraObjects,
      };
      const log = join(dir, 'calls.jsonl');
      // Only external tools are substituted. Git and the hook's shell,
      // tracker guard, branch lookup and HEAD lookup remain real.
      const shim = `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { basename } = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const tool = basename(process.argv[1]);
let phase;
if (tool === 'npx' && JSON.stringify(args) === '["lint-staged"]') phase = 'lint';
else if (tool === 'node' && JSON.stringify(args) === '["scripts/test-isolated.mjs","check"]') phase = 'product';
else if (tool === 'node' && JSON.stringify(args) === '[".backlog/gate.mjs"]') phase = 'gate';
else throw new Error('unexpected dispatch: ' + tool + ' ' + JSON.stringify(args));
const env = Object.fromEntries(${JSON.stringify(names)}.map(name => [name, process.env[name] ?? null]));
let staged = null;
if (phase !== 'product') {
  const result = spawnSync('git', ['show', ':0:.beads/issues.jsonl'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  staged = result.stdout;
}
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ phase, env, staged }) + '\\n');
`;
      for (const tool of ['npx', 'node']) {
        writeFileSync(join(bin, tool), shim, { mode: 0o755 });
      }
      expect(git(dir, ['show', ':0:.beads/issues.jsonl'], clean)).toBe(defaultContent.trim());
      expect(git(dir, ['show', ':0:.beads/issues.jsonl'], alternateEnv)).toBe(commitContent.trim());
      const hook = fileURLToPath(new URL('../../.husky/pre-commit', import.meta.url));
      const run = spawnSync('/bin/sh', [hook], {
        cwd: dir,
        env: { ...clean, ...dirty, PATH: `${bin}:${clean.PATH}` },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(run.error).toBeUndefined();
      expect(run.status).toBe(trackerInCommit ? 1 : 0);
      if (trackerInCommit) expect(run.stderr).toContain('TRACKER:');
      else expect(run.stderr).toBe('');
      const calls = readFileSync(log, 'utf8').trim().split('\n').map(
        (line) => JSON.parse(line)
      );
      expect(calls).toEqual([
        { phase: 'lint', env: dirty, staged: commitContent },
        { phase: 'product', env: Object.fromEntries(names.map(name => [name, null])), staged: null },
        ...(!trackerInCommit ? [{ phase: 'gate', env: dirty, staged: commitContent }] : []),
      ]);
      expect(readFileSync(tracker, 'utf8')).toBe(defaultContent);
      expect(git(dir, ['show', ':0:.beads/issues.jsonl'], clean)).toBe(defaultContent.trim());
      expect(git(dir, ['show', ':0:.beads/issues.jsonl'], alternateEnv)).toBe(commitContent.trim());
    }
  );
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

