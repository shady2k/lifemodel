import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function run(mode: string) {
  const answer = spawnSync('node', ['tests/fixtures/logs-page-contrast-settle.mjs', mode], { encoding: 'utf8' });
  expect(answer.status, answer.stderr).toBe(0);
  return JSON.parse(answer.stdout);
}

describe('settled logs contrast measurement', () => {
  it('waits for loading and the enabled opacity transition, then measures hover', () => {
    const answer = run('transition');
    expect(answer.error).toBeUndefined();
    expect(answer.events.slice(0, 4).map((event: { ready: boolean }) => event.ready)).toEqual([false, false, false, true]);
    expect(answer.hovered).toBe(true);
    expect(answer.samples).toHaveLength(3);
    expect(answer.samples.every((sample: { ratio: number }) => sample.ratio >= 4.5)).toBe(true);
  });
  it('exempts only a control left disabled after loading finishes', () => {
    const answer = run('disabled');
    expect(answer.error).toBeUndefined();
    expect(answer.hovered).toBe(false);
    expect(answer.samples.at(-1)).toMatchObject({ disabled: true, exempt: 'inactive control (WCAG 1.4.3)' });
    expect(answer.samples.slice(0, -1).every((sample: { ratio: number }) => sample.ratio >= 4.5)).toBe(true);
  });
  it.each(['enabled-opacity', 'enabled-filter'])('rejects and diagnoses unsupported rendering on an enabled control: %s', (mode) => {
    const answer = run(mode);
    expect(answer.error).toContain('Show logs');
    expect(answer.error).toContain('enabled=true');
    expect(answer.error).toContain(mode === 'enabled-opacity' ? '"opacity":"0.8"' : 'brightness(0.9)');
  });
});
