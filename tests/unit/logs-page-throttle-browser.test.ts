import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

interface Run {
  result?: { reason?: string; reads?: number; elapsed?: number; range?: unknown; window?: { discarded: number }; contrast?: { ordinary: { selector: string; ratio: number }[]; scan: { selector: string; ratio: number }[] } };
  events: [string, ...unknown[]][];
  error?: string;
}
function run(mode: string): Run {
  const result = spawnSync('node', ['tests/fixtures/logs-page-throttle-browser-harness.mjs', mode], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Run;
}

describe('preparing real task throttle evidence', () => {
  it('does not read the store without a verified task pod', () => {
    const result = run('prepare-missing').result;
    expect(result?.reason).toContain('no verified pod');
    expect(result?.reads).toBe(0);
  });
  it('holds the range fixed and stops polling when no exact window arrives', () => {
    const result = run('prepare-timeout');
    expect(result.result).toMatchObject({ reason: 'no_exact_positive_window', elapsed: 180000 });
    expect(result.result?.reads).toBeGreaterThan(1);
    expect(new Set(result.events.map((event) => JSON.stringify(event[1]))).size).toBe(1);
    const budgets = result.events.map((event) => event[2] as number);
    expect(budgets[0]).toBe(180000);
    expect(budgets.at(-1)).toBe(0);
    expect(budgets.every((budget, index) => index === 0 || budget < budgets[index - 1]!)).toBe(true);
  });
  it('returns the task and range with the first exact discarded window', () => {
    expect(run('prepare-positive').result).toMatchObject({ reads: 1, window: { discarded: 240 } });
  });
});

describe('drawing throttle evidence from the page response', () => {
  it.each(['draw', 'draw-ru'])('subscribes before submitting and verifies the matching range and visible row: %s', (mode) => {
    const result = run(mode);
    expect(result.error).toBeUndefined();
    expect(result.result?.window?.discarded).toBe(240);
    const index = (event: string) => result.events.findIndex((entry) => entry[1] === event);
    expect(index('wait-response')).toBeLessThan(index('click'));
    expect(index('visible')).toBeLessThan(index('scroll'));
  });
  it.each(['draw-wrong-pod', 'draw-wrong-text', 'draw-outside', 'draw-later-window'])('rejects unrelated or unreadable evidence: %s', (mode) => {
    expect(run(mode).error).toBeDefined();
  });
});

describe('proving the same filtered state in the axe context', () => {
  it('restores and verifies the row before injecting axe', () => {
    const result = run('prove');
    expect(result.error).toBeUndefined();
    const index = (name: string, event: string) => result.events.findIndex((entry) => entry[0] === name && entry[1] === event);
    expect(index('ordinary', 'hover')).toBeLessThan(index('ordinary', 'screenshot'));
    expect(index('ordinary', 'hover')).toBeLessThan(index('scan', 'goto'));
    expect(index('scan', 'visible')).toBeLessThan(index('scan', 'inject'));
    expect(result.events.at(-1)).toEqual(['close']);
  });
  it.each(['prove-different', 'prove-violation', 'prove-low-contrast', 'prove-incomplete'])('rejects changed evidence or unproved contrast and closes the scan context: %s', (mode) => {
    const result = run(mode);
    expect(result.error).toBeDefined();
    expect(result.events.at(-1)).toEqual(['close']);
  });
  it.each(['prove', 'prove-dark', 'prove-no-contrast'])('proves rendered contrast in both contexts even without an axe pass: %s', (mode) => {
    const result = run(mode);
    expect(result.error).toBeUndefined();
    for (const samples of [result.result?.contrast?.ordinary, result.result?.contrast?.scan]) {
      expect(samples).toHaveLength(3);
      expect(samples?.every((sample) => sample.ratio >= 4.5)).toBe(true);
    }
  });
  it('names the hovered button and measured ratio when ordinary-page contrast fails', () => {
    const result = run('prove-low-contrast');
    expect(result.error).toContain('Show logs');
    expect(result.error).toContain('"ratio":');
    expect(result.error).toContain('"ordinary":');
  });
  it('fails explicitly without axe rather than accepting the ordinary screenshot', () => {
    expect(run('prove-no-axe').error).toContain('NOT VALID');
  });
});
