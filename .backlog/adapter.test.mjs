// node --test .backlog/adapter.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize, readAt, record } from './adapter.mjs';

const N = (rows) => normalize(rows).issues;

const row = (comments, status = 'in_progress') => ({
  id: 'lifemodel-a',
  title: 'A',
  issue_type: 'task',
  status,
  created_at: '2026-10-07T10:00:00Z',
  updated_at: '2026-10-07T10:00:00Z',
  comments,
});

test('a work record comment is exported raw, with the tracker id, time and author', () => {
  // Damaged on purpose: the gate judges a record, so the adapter must not.
  const body = '[shady2k-time v1] claim\nitem: lifemodel-a\nspan: 1234abcd\n  trailing  \n';
  const [issue] = N([
    row([
      { id: 7, author: 'claude-worker', text: body, created_at: '2026-10-07T10:01:00Z' },
      { id: 8, author: 'dev', text: 'an ordinary note', created_at: '2026-10-07T10:02:00Z' },
    ]),
  ]);
  assert.deepEqual(issue.comments, [
    { id: '7', at: '2026-10-07T10:01:00Z', author: 'claude-worker', body },
  ]);
});

test('an issue with no work record carries an empty comment list', () => {
  const [issue] = N([row([{ id: 1, author: 'dev', text: 'note', created_at: 'x' }])]);
  assert.deepEqual(issue.comments, []);
  const [bare] = N([row(undefined)]);
  assert.deepEqual(bare.comments, []);
});

test('a tombstone is absent, not a state of work', () => {
  const issues = N([row([], 'tombstone'), row([], 'open')]);
  assert.equal(issues.length, 1);
});

test('a status the adapter does not map is an error, never a guess', () => {
  assert.throws(() => normalize([row([], 'wip')]), /does not map/);
});

test('a native submitted status takes its record from the latest submitted comment', () => {
  const [issue] = N([
    row(
      [
        { id: 1, author: 'c', text: 'submitted: old111 -- npm run typecheck', created_at: 't1' },
        { id: 2, author: 'c', text: 'implemented: nope -- not this kind', created_at: 't2' },
        { id: 3, author: 'c', text: 'submitted: abc123 -- npm run test', created_at: 't3' },
      ],
      'submitted',
    ),
  ]);
  assert.equal(issue.status, 'submitted');
  assert.deepEqual(issue.delivery, { revision: 'abc123', evidence: 'npm run test' });
  assert.equal(issue.integration, undefined);
});

test('a native implemented status takes its record from the latest implemented comment', () => {
  const [issue] = N([
    row([{ id: 1, author: 'c', text: 'implemented: def456 -- npm test', created_at: 't1' }], 'implemented'),
  ]);
  assert.equal(issue.status, 'implemented');
  assert.deepEqual(issue.integration, { revision: 'def456', evidence: 'npm test' });
});

test('a native status with no usable record still reaches the gate, with an empty record', () => {
  const [bare] = N([row([], 'implemented')]);
  assert.equal(bare.status, 'implemented');
  assert.deepEqual(bare.integration, { revision: '', evidence: '' });
});

test('in_progress is active whatever marker comments it carries', () => {
  const [issue] = N([
    row([{ id: 1, author: 'c', text: 'implemented: abc123 -- npm run typecheck', created_at: 't1' }]),
  ]);
  assert.equal(issue.status, 'active');
  assert.equal(issue.integration, undefined);
  assert.equal(issue.delivery, undefined);
});

test('parent-child gives parent and only blocks gives blockedBy', () => {
  const [issue] = N([
    {
      ...row([]),
      status: 'open',
      dependencies: [
        { type: 'parent-child', depends_on_id: 'lifemodel-p' },
        { type: 'blocks', depends_on_id: 'lifemodel-x' },
        { type: 'discovered-from', depends_on_id: 'lifemodel-y' },
        { type: 'related', depends_on_id: 'lifemodel-z' },
      ],
    },
  ]);
  assert.equal(issue.parent, 'lifemodel-p');
  assert.deepEqual(issue.blockedBy, ['lifemodel-x']);
});

test('record: the latest by the tracker clock, not the export order', () => {
  const r = record(
    [
      { id: 2, author: 'c', text: 'submitted: new999 -- b', created_at: '2026-10-07T10:00:00Z' },
      { id: 1, author: 'c', text: 'submitted: old111 -- a', created_at: '2026-10-07T09:00:00Z' },
    ],
    'submitted',
  );
  assert.deepEqual(r, { revision: 'new999', evidence: 'b' });
});

// readAt over a ref, as CI reads it: a recording is a whole state (sections) or,
// from mechanism 0.126.0, a reference to the store commit holding the state.
test('readAt reads both a whole-state recording and a reference recording', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-readat-'));
  const cwd = process.cwd();
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  const row = (id) => JSON.stringify({ id, title: id, status: 'open', issue_type: 'task' });
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.invalid');
    git('config', 'user.name', 'test');
    git('commit', '-q', '--allow-empty', '-m', 'code one');
    const one = git('rev-parse', 'HEAD');
    git('commit', '-q', '--allow-empty', '-m', 'code two');
    const two = git('rev-parse', 'HEAD');
    // The store: its state commit, then the recordings of both code commits.
    git('checkout', '-q', '--orphan', 'store');
    git('rm', '-rqf', '--ignore-unmatch', '.');
    mkdirSync(join(dir, '.beads'), { recursive: true });
    writeFileSync(join(dir, '.beads/issues.jsonl'), row('x-ref') + '\n');
    git('add', '.beads/issues.jsonl');
    git('commit', '-q', '-m', 'state');
    const state = git('rev-parse', 'HEAD');
    mkdirSync(join(dir, '.tracker-sync/recordings'), { recursive: true });
    writeFileSync(join(dir, `.tracker-sync/recordings/${one}.jsonl`), `=== .beads/issues.jsonl\n${row('x-whole')}\n`);
    writeFileSync(
      join(dir, `.tracker-sync/recordings/${two}.jsonl`),
      JSON.stringify({ format: 'tracker-sync-recording/1', store: state, digest: 'sha256:0' }) + '\n',
    );
    git('add', '.tracker-sync');
    git('commit', '-q', '-m', 'recordings');
    git('update-ref', 'refs/tracker/state', 'HEAD');
    process.chdir(dir);
    assert.deepEqual(readAt(one, { ref: 'refs/tracker/state' }).rows.map((r) => r.id), ['x-whole']);
    assert.deepEqual(readAt(two, { ref: 'refs/tracker/state' }).rows.map((r) => r.id), ['x-ref']);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
