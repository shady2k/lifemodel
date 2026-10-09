/**
 * Child fixture for the setup integration guard (lifemode-q4x.4.2).
 *
 * The in-process guards are vacuous against a removal of the vitest setup
 * invocation: a test file that reaches the suite ALREADY has a scrubbed
 * environment (that is what the setup does), so "no GIT_* left" proves nothing
 * about how the environment got that way. This child starts DIRTY - the parent
 * injects the sentinel GIT_* into its environment, exactly what a hook hands
 * the suite - and then either
 *
 *   setup    - executes the REAL setup (tests/setup/scrub-git-env.ts, the
 *              module vitest.config.ts names) BEFORE any git runs, and must not
 *              let one git call of a test fixture reach the sentinel repository;
 *   noscrub  - runs the same fixture WITHOUT any scrub, to prove the assertions
 *              themselves go red when the setup is missing (the thing the old
 *              in-process guard could not show).
 *
 * Run through tsx:
 *
 *   tsx tests/fixtures/git-isolation-child.ts setup   <sentinel-repo> <worktree>
 *   tsx tests/fixtures/git-isolation-child.ts noscrub <sentinel-repo> <worktree>
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [mode, sentinelRepo, worktree] = process.argv.slice(2, 5);
if (!mode || !sentinelRepo) {
  console.error('usage: git-isolation-child <setup|noscrub> <sentinel-repo> [worktree]');
  process.exit(2);
}

const fail = (message: string): never => {
  console.error(`CHILD-FAIL ${message}`);
  process.exit(1);
};
const ok = (message: string): void => {
  console.log(`CHILD-OK ${message}`);
};

const repo = resolve(sentinelRepo);

function git(cwd: string, args: string[]): string {
  const run = spawnSync(
    'git',
    ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args],
    { cwd, encoding: 'utf8' }
  );
  if (run.status !== 0) fail(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

/** What a test fixture does: a repository of its own, a commit, a remote. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-isolation-child-'));
  git(dir, ['init', '-q']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'a fixture commit']);
  git(dir, ['remote', 'add', 'upstream', 'https://example.com/fixture.git']);
  return dir;
}

const head = git(repo, ['rev-parse', 'HEAD']);
const config = readFileSync(join(repo, '.git', 'config'), 'utf8');

if (mode === 'setup') {
  // The REAL setup file, exactly the module vitest.config.ts names as
  // setupFiles: its top-level statement scrubs process.env. A child that ran
  // git without this import would reach the sentinel below.
  await import('../setup/scrub-git-env.js');
}

const fixtureDir = fixture();

const headNow = git(repo, ['rev-parse', 'HEAD']);
const configNow = readFileSync(join(repo, '.git', 'config'), 'utf8');
const reached = headNow !== head || configNow !== config;

if (mode === 'setup') {
  if (reached) {
    fail(
      `the fixture reached the sentinel repository (head ${head.slice(0, 7)} -> ${headNow.slice(0, 7)})`
    );
  }
  ok('sentinel untouched');

  const fixtureConfig = readFileSync(join(fixtureDir, '.git', 'config'), 'utf8');
  if (!fixtureConfig.includes('[remote "upstream"]')) {
    fail('the fixture did not do its own work in its own repository');
  }
  ok('the fixture worked on its own repository');
} else {
  // The hazard is real and the guard can see it: WITHOUT the setup the same
  // fixture moves the sentinel. If it did not, this detection itself is broken.
  if (!reached) {
    fail('the hazard detection failed: the sentinel did not move without the scrub');
  }
  console.log('CHILD-REACHED-SENTINEL');
}

rmSync(fixtureDir, { recursive: true, force: true });
process.exit(0);
