// node --test .backlog/merge-gate.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { newInBoth } from './merge-gate.mjs';

const report = (id, violations) => ({ results: [{ id, severity: 'error', violations }] });
const v = (id, isNew, note = '') => ({ id, isNew, note, ref: '' });

test('an error new against both parents is new in the merge', () => {
  const head = report('area-label', [v('lifemodel-a', true), v('lifemodel-b', true)]);
  const other = report('area-label', [v('lifemodel-b', true)]);
  assert.deepEqual(newInBoth(head, other), [{ rule: 'area-label', id: 'lifemodel-b', note: '' }]);
});

test('debt the other parent already carried is not new', () => {
  const head = report('area-label', [v('lifemodel-a', true)]);
  const other = report('area-label', [v('lifemodel-a', false)]);
  assert.deepEqual(newInBoth(head, other), []);
});

test('an error that is new only against the other parent is not reported', () => {
  const head = report('area-label', []);
  const other = report('area-label', [v('lifemodel-a', true)]);
  assert.deepEqual(newInBoth(head, other), []);
});

test('warnings are never merge-new', () => {
  const head = { results: [{ id: 'bulk-clusters', severity: 'warning', violations: [v('lifemodel-a', true)] }] };
  assert.deepEqual(newInBoth(head, head), []);
});
