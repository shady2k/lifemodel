import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WALK = join('deploy', 'platform', 'logs-crash-walk.py');
const HARNESS = join('tests', 'fixtures', 'logs-crash-load-harness.py');

function run(fixture: object = {}) {
  const result = spawnSync('python3', [HARNESS, WALK, JSON.stringify(fixture)], {
    encoding: 'utf8',
  });
  expect(result.error).toBeUndefined();
  const line = result.stdout.split('\n').find((entry) => entry.startsWith('OBSERVED '));
  return {
    status: result.status,
    output: result.stdout,
    observed: line
      ? (JSON.parse(line.slice('OBSERVED '.length)) as {
          status: number;
          bound?: number;
          events: string[];
        })
      : undefined,
  };
}

describe('crash walk node load baseline', () => {
  it.each([
    { baseline: 3, cpus: 4, bound: 16 },
    { baseline: 9.4, cpus: 4, bound: 17.4 },
    { baseline: 20, cpus: 4, bound: 28 },
    { baseline: 1.5, cpus: 1, bound: 4 },
  ])('derives its default from baseline=$baseline and cpus=$cpus', (fixture) => {
    const result = run(fixture);
    expect(result.status).toBe(0);
    expect(result.observed?.bound).toBe(fixture.bound);
    const note = result.output
      .split('\n')
      .find((line) => line.startsWith('NOTE') && /baseline/i.test(line));
    expect(note).toBeDefined();
    expect(note).toContain(String(fixture.baseline));
    expect(note).toContain(String(fixture.cpus));
    expect(note).toContain(String(fixture.bound));
  });

  it.each(['24', '0.25', '1000000'])('accepts an explicit finite positive bound %s', (bound) => {
    const result = run({ args: ['--max-load', bound] });
    expect(result.status).toBe(0);
    expect(result.observed?.bound).toBe(Number(bound));
  });

  it.each(['0', '-1', 'nan', 'inf', '-inf'])('refuses invalid bound %s', (bound) => {
    expect(run({ args: ['--max-load=' + bound] }).status).toBe(2);
  });

  it('reads baseline and CPU count before constructing the watchdog or creating writers', () => {
    const result = run();
    expect(result.status).toBe(0);
    const events = result.observed?.events ?? [];
    for (const evidence of ['baseline', 'cpus']) {
      expect(events).toContain(evidence);
      expect(events.indexOf(evidence)).toBeLessThan(events.indexOf('monitor-created'));
      expect(events.indexOf(evidence)).toBeLessThan(events.indexOf('writers'));
    }
  });

  it.each([{ missing_load: true }, { baseline: -1 }, { cpus: null }, { cpus: 0 }])(
    'fails closed before watchdog and writers if node evidence is missing: %j',
    (fixture) => {
      const result = run({ ...fixture, args: ['--max-load', '24'] });
      expect(result.status).toBe(1);
      expect(result.output).toContain('TEST NOT VALID');
      expect(result.observed?.events).not.toContain('monitor-created');
      expect(result.observed?.events).not.toContain('writers');
    }
  );
});
