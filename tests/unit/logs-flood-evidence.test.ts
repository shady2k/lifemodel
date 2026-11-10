/** Own-pod evictor evidence survives today's partition and successful Job GC. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WALK = join('deploy', 'platform', 'logs-volume-flood-walk.py');
const HARNESS = join('tests', 'fixtures', 'logs-flood-evidence-harness.py');
const day = '20261110';
const job = (name = 'evict-1', overrides = {}) => ({
  metadata: {
    name,
    uid: name + '-uid',
    creationTimestamp: '2026-11-10T12:00:01Z',
    ownerReferences: [{ kind: 'CronJob', name: 'logs-evictor', uid: 'cron-uid' }],
    ...overrides,
  },
});
const pod = (name = 'evict-1-pod', jobName = 'evict-1', ownerUid = jobName + '-uid') => ({
  metadata: {
    name,
    uid: name + '-uid',
    labels: { 'job-name': jobName },
    ownerReferences: [{ kind: 'Job', name: jobName, uid: ownerUid }],
  },
});
const line = (time = '2026-11-10T12:00:02Z') =>
  time +
  ' ' +
  JSON.stringify({
    msg: 'the oldest log day was removed',
    day,
    freedBytes: 4096,
    reason: 'below_threshold',
  });
interface Frame {
  recreate?: boolean;
  jobs?: ReturnType<typeof job>[];
  pods?: ReturnType<typeof pod>[];
  logs?: Record<string, string>;
  days: string[];
}
interface Outcome {
  verified: { day: string; freedBytes: number }[];
  events: { kind: string; name: string }[];
  calls: string[][];
}
const seen = (logs: Record<string, string> = {}): Frame => ({
  jobs: [job()],
  pods: [pod()],
  days: [day],
  logs,
});
const removed = (): Frame => ({ jobs: [job()], pods: [pod()], days: [] });
function harness(frames: Frame[], extra: Record<string, unknown> = {}): Outcome {
  const run = spawnSync('python3', [HARNESS, WALK], {
    input: JSON.stringify({ frames, ...extra }),
    encoding: 'utf8',
  });
  expect(run.error).toBeUndefined();
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout.trim()) as Outcome;
}

describe('flood displacement needs independent pod and filesystem evidence', () => {
  it('proves a today-only drop even when the store lost its own evictor record', () => {
    // No loader exists in the fixture: that same day held the loader-readable line.
    const outcome = harness([seen({ 'evict-1-pod': line() }), removed()]);
    expect(outcome.verified).toEqual([expect.objectContaining({ day, freedBytes: 4096 })]);
    expect(
      outcome.calls.some((call) => call.includes('logs') && call.includes('evict-1-pod'))
    ).toBe(true);
  });

  it('caches a captured drop across successful Job history GC and today recreation', () => {
    const outcome = harness([
      seen({ 'evict-1-pod': line() }),
      removed(),
      { jobs: [job('evict-2')], pods: [pod('evict-2-pod', 'evict-2')], days: [day] },
    ]);
    expect(outcome.verified).toHaveLength(1);
  });

  it('recognizes today directory replacement between polls without observing an absent name', () => {
    const outcome = harness([seen({ 'evict-1-pod': line() }), { ...seen(), recreate: true }]);
    expect(outcome.verified).toHaveLength(1);
  });

  it('retries an active Job whose pod log was not readable on the first poll', () => {
    const outcome = harness([
      seen(),
      { ...removed(), logs: { 'evict-1-pod': line() } },
      { jobs: [], pods: [], days: [] },
    ]);
    expect(outcome.verified).toHaveLength(1);
  });

  it('deduplicates the same pod log reread before Job GC', () => {
    const outcome = harness([
      seen({ 'evict-1-pod': line() + '\n' + line() }),
      { ...removed(), logs: { 'evict-1-pod': line() } },
    ]);
    expect(outcome.verified).toHaveLength(1);
  });

  it.each([
    ['missing pod logs', [seen(), removed()]],
    ['directory still present', [seen({ 'evict-1-pod': line() }), seen()]],
    ['directory never observed', [{ ...removed(), logs: { 'evict-1-pod': line() } }]],
    ['a pre-window line', [seen({ 'evict-1-pod': line('2026-11-10T11:59:59Z') }), removed()]],
    [
      'a pre-window Job',
      [
        {
          ...seen({ 'evict-1-pod': line() }),
          jobs: [
            job('evict-1', {
              creationTimestamp: '2026-11-10T11:59:00Z',
            }),
          ],
        },
        removed(),
      ],
    ],
    [
      'another CronJob',
      [
        {
          ...seen({ 'evict-1-pod': line() }),
          jobs: [
            job('evict-1', {
              ownerReferences: [{ kind: 'CronJob', name: 'other', uid: 'other-uid' }],
            }),
          ],
        },
        removed(),
      ],
    ],
    [
      'a pod owned by a different Job UID',
      [
        { ...seen({ 'evict-1-pod': line() }), pods: [pod('evict-1-pod', 'evict-1', 'other-uid')] },
        removed(),
      ],
    ],
  ] satisfies [string, Frame[]][])('does not prove a drop with %s', (_name, frames) => {
    expect(harness(frames).verified).toEqual([]);
  });
});

describe('the actual flood case captures independent eviction evidence', () => {
  it('accepts evictor-first today-only displacement without loader logs or a moved oldest row', () => {
    const outcome = harness([], { integration: true });
    expect(
      outcome.events.some((event) => event.kind === 'note' && event.name.includes('evictor-first'))
    ).toBe(true);
    expect(outcome.events.some((event) => event.kind === 'invalid')).toBe(false);
    expect(outcome.events.some((event) => event.kind === 'fail')).toBe(false);
  });

  it.each([{ missingLog: true }, { keepDirectory: true }])(
    'does not credit incomplete live flood evidence: %j',
    (input) => {
      const outcome = harness([], { integration: true, ...input });
      expect(
        outcome.events.some(
          (event) => event.kind === 'invalid' && event.name.includes('no verified evictor drop')
        )
      ).toBe(true);
      expect(
        outcome.events.some(
          (event) => event.kind === 'note' && event.name.includes('evictor-first')
        )
      ).toBe(false);
    }
  );
});
