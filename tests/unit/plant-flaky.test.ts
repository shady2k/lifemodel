import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Planted, do not merge: one container keeps its temporary directory across the
// repetitions, so this passes in the full check and fails on the third repeat.
it('fails one run in several', () => {
  const counter = join(tmpdir(), 'plant-flaky-count');
  const run = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) + 1 : 1;
  writeFileSync(counter, String(run));
  expect(run).not.toBe(3);
});
