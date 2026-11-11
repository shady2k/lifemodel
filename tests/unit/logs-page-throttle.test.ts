import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function run(mode: string) {
  const result = spawnSync('node', ['tests/fixtures/logs-page-throttle-harness.mjs', mode], {
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe('page throttling evidence', () => {
  it.each(['positive', 'explicit-namespace'])(
    'uses a complete positive pair with matching identity: %s',
    (mode) => {
      expect(run(mode).window).toMatchObject({ pod: 'real-pod', discarded: 240 });
    }
  );
  it.each([
    'unknown-row',
    'zero',
    'negative',
    'fraction',
    'unsafe',
    'wrong-pod',
    'wrong-namespace',
    'partial',
    'unaligned',
    'long-window',
    'missing',
    'unavailable',
  ])('rejects non-evidence: %s', (mode) => {
    expect(run(mode)).toEqual({ window: null });
  });
  it('waits for an exact positive row even if the overall status remains unknown', () => {
    expect(run('poll-arrives')).toMatchObject({
      window: { discarded: 240 },
      reason: null,
      reads: 3,
      pauses: [2, 2],
    });
  });
  it.each(['poll-timeout', 'poll-unavailable', 'poll-throw'])(
    'stops within the read bound with a public reason: %s',
    (mode) => {
      expect(run(mode)).toEqual({
        window: null,
        reason: mode === 'poll-timeout' ? 'no_exact_positive_window' : 'logs_unavailable',
        reads: 4,
        pauses: [2, 2, 1],
      });
    }
  );
});

describe('the exact visible discarded row', () => {
  it.each([
    ['en', 1, '1 event discarded'],
    ['en', 240, '240 events discarded'],
    ['ru', 1, '1 событие отброшено'],
    ['ru', 2, '2 события отброшено'],
    ['ru', 5, '5 событий отброшено'],
    ['ru', 21, '21 событие отброшено'],
  ] as const)('matches the component wording in %s for %i', (locale, count, discarded) => {
    const result = run(`text-${locale}-${String(count)}`);
    expect(result.text).toBe(
      `lifemodel-motor/real-pod · ${result.start} – ${result.end} · ${discarded}`
    );
  });
});

it('passes the remaining read budget and refuses a result that arrives beyond it', () => {
  expect(run('poll-late')).toEqual({
    window: null,
    reason: 'poll_deadline_exceeded',
    reads: 1,
    pauses: [],
    remaining: [5],
  });
});
