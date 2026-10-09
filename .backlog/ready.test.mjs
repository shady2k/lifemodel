// node --test .backlog/ready.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalize } from './adapter.mjs';
import { readyLeaves } from './ready.mjs';

const dep = (id, type) => ({ depends_on_id: id, type });
const row = (id, type, status, deps = [], comments = []) => ({
  id, title: id, issue_type: type, status, dependencies: deps, comments,
});
const at = (text, n) => ({ id: n, author: 'c', text, created_at: `2026-10-09T0${n}:00:00Z` });

// Feature F: stage S1 (task A, implemented at r1), stage S2 (task B, blocked by A).
// Feature G: stage T1 (task C, blocked by A).
const backlog = (s1Comments, s1Status = 'open') =>
  normalize([
    row('F', 'epic', 'open'),
    row('S1', 'epic', s1Status, [dep('F', 'parent-child')], s1Comments),
    row('A', 'task', 'implemented', [dep('S1', 'parent-child')], [at('implemented: r1 -- npm test', 1)]),
    row('S2', 'epic', 'open', [dep('F', 'parent-child')]),
    row('B', 'task', 'open', [dep('S2', 'parent-child'), dep('A', 'blocks')]),
    row('G', 'epic', 'open'),
    row('T1', 'epic', 'open', [dep('G', 'parent-child')]),
    row('C', 'task', 'open', [dep('T1', 'parent-child'), dep('A', 'blocks')]),
  ]).issues;
const ids = (issues, merged) => readyLeaves(issues, { merged }).map((i) => i.id).sort();

test('an accepted, still-open stage releases a later stage of the same feature once its revision is in the checkout', () => {
  const issues = backlog([at('accepted: r9 -- npm run check exit 0; walk', 2)]);
  assert.deepEqual(issues.find((i) => i.id === 'S1').acceptance, { revision: 'r9', evidence: 'npm run check exit 0; walk' });
  assert.deepEqual(ids(issues, (rev) => rev === 'r9'), ['B']);
});

test('not while the accepted revision is not in the checkout', () => {
  assert.deepEqual(ids(backlog([at('accepted: r9 -- npm run check exit 0', 2)]), () => false), []);
});

test('not before the stage is accepted, however far the work is merged', () => {
  assert.deepEqual(ids(backlog([]), () => true), []);
});

test('never across features: another feature waits for closure', () => {
  const issues = backlog([at('accepted: r9 -- npm run check exit 0', 2)]);
  assert.ok(!ids(issues, () => true).includes('C'));
});

test('a closed prerequisite releases everywhere', () => {
  const issues = normalize([
    row('G', 'epic', 'open'),
    row('T1', 'epic', 'open', [dep('G', 'parent-child')]),
    row('A', 'task', 'closed'),
    row('C', 'task', 'open', [dep('T1', 'parent-child'), dep('A', 'blocks')]),
  ]).issues;
  assert.deepEqual(ids(issues, () => false), ['C']);
});
