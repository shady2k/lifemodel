// landed.mjs: the main line's commits that name tasks, as the gate's
// merged-but-open rule reads them. A scratch repository, never this one.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landedAt, landedFor } from './landed.mjs';

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'landed-test-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 'test');
  const commit = (msg) => {
    git('commit', '-q', '--allow-empty', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, commit };
}

test('lists main-line commits by the ids their header names, and skips the rest', () => {
  const { dir, commit } = scratch();
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const a = commit('Do a thing (lifemodel-aaa)');
    commit('A commit with no link');
    const c = commit('Two things (lifemodel-bbb.1, lifemodel-ccc)\n\nBody names (lifemodel-zzz), not a link');
    const byId = (l) => [...l].sort((x, y) => x.id.localeCompare(y.id));
    assert.deepEqual(byId(landedAt('HEAD')), byId([
      { id: c, taskIds: ['lifemodel-bbb.1', 'lifemodel-ccc'] },
      { id: a, taskIds: ['lifemodel-aaa'] },
    ]));
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a branch's own commits are not landed until main reaches them", () => {
  const { dir, git, commit } = scratch();
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const base = commit('Base (lifemodel-aaa)');
    git('checkout', '-q', '-b', 'feature');
    const work = commit('Work in progress (lifemodel-bbb)');
    // Commits made within one second have no stable log order: compare as sets.
    const ids = (l) => l.map((c) => c.id).sort();
    assert.deepEqual(ids(landedFor(work, base)), [base]);
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', 'Merge feature', 'feature');
    const main = git('rev-parse', 'HEAD');
    assert.deepEqual(ids(landedFor(main, main)), [work, base].sort());
    // A state recorded on the branch tip, judged against the main that merged it.
    assert.deepEqual(ids(landedFor(work, main)), [work, base].sort());
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
