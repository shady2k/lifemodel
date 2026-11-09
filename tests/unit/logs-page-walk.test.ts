/** WALK-LOGS-PAGE (ADR-016 §4, §5; PRA-001): the browser walk cannot run on
 * this box (playwright-core and its browsers belong to the caller), so these
 * checks hold its contract: both engines, both languages, a screenshot per
 * state, the API read before the screen, and the password never printed.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const WALK = 'deploy/platform/logs-page-walk.mjs';

function source(): string {
  return readFileSync(WALK, 'utf8');
}

describe('the browser walk', () => {
  it('parses as an ES module', () => {
    const result = spawnSync('node', ['--check', WALK], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('names its walk, its row and the practice it serves', () => {
    const header = source().split('\n').slice(0, 60).join('\n');
    expect(header).toContain('WALK-LOGS-PAGE');
    expect(header).toMatch(/ADR-016/);
    expect(header).toContain('PRA-001');
    expect(header).toMatch(/Chromium/);
    expect(header).toMatch(/Firefox/);
  });

  it('walks both engines in both languages', () => {
    const text = source();
    expect(text).toContain('chromium');
    expect(text).toContain('firefox');
    expect(text).toContain("locale: 'en-US'");
    expect(text).toContain("locale: 'ru-RU'");
    expect(text).toContain('colorScheme');
  });

  it('takes a screenshot of every state it asserts', () => {
    const text = source();
    for (const state of [
      'page',
      'retention',
      'level-filter',
      'conversation-filter',
      'text-filter',
      'second-page',
      'first-page-again',
    ]) {
      expect(text).toContain(`shot('${state}')`);
    }
  });

  it('reads the API before judging the screen', () => {
    const text = source();
    expect(text).toContain('/api/logs?from=');
    expect(text).toContain('/api/logs/settings');
    // The level question is settled from the core's own records first.
    expect(text).toContain('module=core');
  });

  it('treats an older core image as a NOTE, never as a page defect', () => {
    const text = source();
    const section = text.slice(text.indexOf('module=core'), text.indexOf('The conversation filter'));
    expect(section).toContain('unknown');
    expect(section).toMatch(/note\(/);
    expect(section).not.toMatch(/check\(coreLevels/);
  });

  it('awaits every page helper, so a locator is never read off its promise', () => {
    const lines = source().split('\n');
    for (const name of ['api', 'fillFilter', 'submit', 'recordItems', 'countLine', 'messageTexts']) {
      for (const [index, line] of lines.entries()) {
        if (!line.includes(`${name}(`)) continue;
        if (new RegExp(`^\\s*(async )?function ${name}\\(`).test(line)) continue;
        expect(line, `line ${index + 1}: ${line.trim()}`).toContain(`await ${name}(`);
      }
    }
    // `await recordItems(page).count()` reads the count off the promise.
    expect(source()).not.toMatch(/recordItems\(page\)\.cou?nt/);
  });

  it('prints a RESTORE line and exits on the failure count', () => {
    const text = source();
    expect(text).toMatch(/finally\s*\{/);
    expect(text).toContain('RESTORE');
    expect(text).toContain('process.exit(failures ? 1 : 0)');
  });

  it('never prints the password and takes it from a file', () => {
    const text = source();
    expect(text).toContain('readFileSync(pwFile');
    expect(text).not.toMatch(/console\.log\([^)]*secret/);
  });
});
