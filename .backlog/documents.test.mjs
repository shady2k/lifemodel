// documents.mjs: the charter's outcomes and the vision's ids, as the backlog
// rules read them, from text the shape this repository writes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOutcomes, parseVision } from './documents.mjs';

const charter = `# m — x

## Outcomes

Each outcome is one feature.

- O1: **The logs are kept on the machine and searched in the
  loader** (lifemodel-a). More text.
  *Check:* something.
  Serves: J5, J1, P2
- O2: **One id end to end** (lifemodel-b).
  - a nested list item: not an outcome;

  Serves: J1
- O3: Plain title. With more.

## Out

- O9: **not an outcome, outside the section**
  Serves: P1
`;

test('outcomes carry their whole bold title and their Serves ids', () => {
  assert.deepEqual(parseOutcomes(charter), [
    { id: 'O1', title: 'The logs are kept on the machine and searched in the loader', serves: ['J5', 'J1', 'P2'] },
    { id: 'O2', title: 'One id end to end', serves: ['J1'] },
    { id: 'O3', title: 'Plain title.', serves: [] },
  ]);
});

test('a charter without an Outcomes section declares none', () => {
  assert.deepEqual(parseOutcomes('# m\n\n## Out\n\n- O1: **x**\n'), []);
});

test('the vision gives journeys and principles one per line, ids in front', () => {
  const v = parseVision(`# Vision

## Key journeys

Agreed.

- J1: The owner talks.
- J2: lifemodel decides.

## Principles

- P1: Safety comes from rollback.
- not an item

## Roadmap

- R1: not read
`);
  assert.deepEqual(v, {
    journeys: [{ id: 'J1', title: 'The owner talks.' }, { id: 'J2', title: 'lifemodel decides.' }],
    principles: [{ id: 'P1', title: 'Safety comes from rollback.' }],
  });
});

test('a vision with neither section keeps no record', () => {
  assert.equal(parseVision('# Vision\n\n## Direction\n\ntext\n'), null);
});
