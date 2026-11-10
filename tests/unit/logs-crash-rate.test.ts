import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

type Sample = {
  metric: string;
  component: string;
  received: number | null;
  per_writer: Record<string, number | null>;
  status: string;
};

function run(fixture: object = {}) {
  const result = spawnSync(
    'python3',
    [
      'tests/fixtures/logs-crash-rate-harness.py',
      'deploy/platform/logs-crash-walk.py',
      JSON.stringify(fixture),
    ],
    { encoding: 'utf8' }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const line = result.stdout.split('\n').find((entry) => entry.startsWith('OBSERVED '));
  expect(line, result.stdout).toBeDefined();
  return {
    output: result.stdout.slice(0, result.stdout.indexOf('OBSERVED ')),
    observed: JSON.parse(line!.slice('OBSERVED '.length)) as {
      configured_source: string;
      before: Sample;
      current: Sample;
      rate: number | null;
    },
  };
}

describe('crash walk source-rate diagnostics', () => {
  it('wires source diagnostics into the real fill loop before the memory gate', () => {
    const { output } = run({ mode: 'fill-loop' });
    expect(output).toContain('vector_component_received_events_total');
    expect(output).toMatch(/exporter.*HTTP 200/i);
    expect(output).toContain('1000');
    expect(output).toContain('1300');
    expect(output).toMatch(/source rate [1-9]\d*(?:\.\d+)? lines\/s/);
    expect(output.indexOf('source rate')).toBeLessThan(
      output.indexOf('collector memory unavailable')
    );
  });

  it('measures the configured Kubernetes source while the blocked sink counter stays unchanged', () => {
    const { observed, output } = run({
      before: { source: 1000, sink: 700 },
      current: { source: 1300, sink: 700 },
      elapsed: 10,
    });
    expect(observed.before).toMatchObject({
      metric: 'vector_component_received_events_total',
      component: observed.configured_source,
      received: 1000,
      per_writer: { 'walk-crash-writer': 1000 },
      status: 'HTTP 200',
    });
    expect(observed.current.received).toBe(1300);
    expect(observed.current.per_writer).toEqual({ 'walk-crash-writer': 1300 });
    expect(observed.rate).toBe(30);
    expect(output).toContain('vector_component_received_events_total');
    expect(output).toContain(observed.configured_source);
    expect(output).toMatch(/exporter.*HTTP 200/i);
    expect(output).toContain('1000');
    expect(output).toContain('1300');
    expect(output).toMatch(/source rate 30(?:\.0+)? lines\/s/);
  });

  it.each([
    { before: { source: 1000 }, current: {} },
    { before: {}, current: { source: 1300 } },
  ])('reports unavailable rather than zero for a missing source counter: %j', (fixture) => {
    const { observed, output } = run(fixture);
    expect(observed.rate).toBeNull();
    expect([observed.before.received, observed.current.received]).toContain(null);
    expect([
      observed.before.per_writer['walk-crash-writer'],
      observed.current.per_writer['walk-crash-writer'],
    ]).toContain(null);
    expect(output).toMatch(/exporter.*HTTP 200/i);
    expect(output).toMatch(/source rate unavailable/i);
    expect(output).not.toMatch(/source rate 0(?:\.0+)? lines\/s/);
  });

  it.each([
    { before: { source: 1000 }, current: { error: 'GET /metrics answered 503' } },
    { before: { error: 'nothing answered port 9598' }, current: { source: 1300 } },
  ])('retains the exporter failure instead of fabricating a zero sample: %j', (fixture) => {
    const { observed, output } = run(fixture);
    expect(observed.rate).toBeNull();
    expect(output).toContain(fixture.before.error ?? fixture.current.error);
    expect(output).toMatch(/source rate unavailable/i);
    expect(output).not.toMatch(/source rate 0(?:\.0+)? lines\/s/);
  });

  it('distinguishes a measured zero delta from an unavailable measurement', () => {
    const { observed, output } = run({
      before: { source: 0 },
      current: { source: 0 },
    });
    expect(observed.rate).toBe(0);
    expect(output).toMatch(/source rate 0(?:\.0+)? lines\/s/);
    expect(output).not.toMatch(/source rate unavailable/i);
  });

  it('does not turn a source restart counter reset into a negative or zero rate', () => {
    const { observed, output } = run({
      before: { source: 1000 },
      current: { source: 20 },
    });
    expect(observed.rate).toBeNull();
    expect(output).toMatch(/source rate unavailable/i);
    expect(output).toMatch(/reset/i);
  });
});
