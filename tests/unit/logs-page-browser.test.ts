import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { gotoWithRetry } from '../../deploy/platform/logs-page-browser.mjs';

interface Run {
  result?: {
    violations?: unknown[];
    text?: string;
    reason?: string;
    empty?: boolean;
    records?: number;
  };
  events: [string, unknown][];
  error?: string;
}

function harness(mode: string): Run {
  const result = spawnSync('node', ['tests/fixtures/logs-page-browser-harness.mjs', mode], {
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Run;
}

describe('the axe-only browser context', () => {
  it('copies the authenticated URL, language, theme and browser state without injecting the ordinary page', () => {
    const run = harness('axe');
    const options = run.events.find(([event]) => event === 'context')?.[1];
    expect(options).toEqual({
      ignoreHTTPSErrors: true,
      locale: 'ru-RU',
      colorScheme: 'dark',
      viewport: { width: 1280, height: 900 },
      bypassCSP: true,
      storageState: { cookies: [{ name: 'session', value: 'fixture' }], origins: [] },
    });
    expect(run.events).toContainEqual([
      'session',
      {
        origin: 'https://boot-example.local',
        values: { language: 'ru' },
      },
    ]);
    expect(run.events).toContainEqual(['goto', 'https://boot-example.local/logs']);
    expect(run.events.findIndex(([event]) => event === 'settled')).toBeLessThan(
      run.events.findIndex(([event]) => event === 'inject')
    );
    expect(run.result?.violations).toHaveLength(1);
    expect(run.events.at(-1)).toEqual(['close']);
  });

  it('closes the bypass context even when the scanner throws', () => {
    const run = harness('axe-error');
    expect(run.error).toBe('axe failed');
    expect(run.events.at(-1)).toEqual(['close']);
  });
});

describe('the stopped store is judged from its own answer and rendered status', () => {
  it.each(['store', 'store-ru'])(
    'waits for %s and reports the reason actually seen, not a title',
    (mode) => {
      const run = harness(mode);
      expect(run.error).toBeUndefined();
      expect(run.events[0]?.[0]).toBe('wait-response');
      expect(run.result?.reason).toBe('connection_refused');
      expect(run.result?.text).toContain(
        mode === 'store-ru' ? 'соединение отклонено' : 'the connection was refused'
      );
      expect(run.result?.empty).toBe(false);
      expect(run.result?.records).toBe(0);
    }
  );

  it('retries a navigation the stopping store aborts, then judges what it saw', () => {
    const run = harness('store-aborted');
    expect(run.error).toBeUndefined();
    const gotos = run.events.filter(([event]) => event === 'goto');
    expect(gotos).toHaveLength(2);
    expect(run.result?.reason).toBe('connection_refused');
  });

  it('navigates without waiting for the polling page to go idle', () => {
    const run = harness('store');
    const goto = run.events.filter(([event]) => event === 'goto').at(-1);
    expect(goto?.[2]).toBe('domcontentloaded');
  });

  it('does not accept a successful empty API answer as unavailable', () => {
    expect(harness('store-ok').error).toContain('unavailable');
  });

  it('does not accept a status without its reason', () => {
    expect(harness('store-missing-reason').error).toBe('render timeout');
  });

  it('exposes a wrongly drawn empty answer or remaining records', () => {
    expect(harness('store-empty').result?.empty).toBe(true);
    expect(harness('store-records').result?.records).toBe(1);
  });
});

describe('a navigation a stopping store or chat aborts', () => {
  it('is retried a bounded number of times, then reports the last abort', async () => {
    let attempts = 0;
    const page = {
      goto: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('net::ERR_ABORTED');
      },
    };
    await expect(gotoWithRetry(page, 'https://boot/logs', {}, 3, 0)).resolves.toBe(3);
    expect(attempts).toBe(3);

    let failing = 0;
    await expect(
      gotoWithRetry(
        {
          goto: async () => {
            failing += 1;
            throw new Error('net::ERR_ABORTED');
          },
        },
        'https://boot/logs',
        {},
        2,
        0
      )
    ).rejects.toThrow('ERR_ABORTED');
    expect(failing).toBe(2);
  });
});
