import { expect, it } from 'vitest';
import { restartWithSettingsReady } from './helpers/restart-with-settings-ready.js';

it.each([1, 3])('requires fresh settings and vault readiness after baseline %i', async (vaultBefore) => {
  const logs = [
    ...Array.from({ length: vaultBefore }, (_, i) => `"msg":"Agent Vault is up: run ${i + 1}"`),
    'settings interface is up',
  ];
  const order: string[] = [];
  const waits: Array<{ pattern: RegExp; count: number }> = [];
  const listeners = new Set<() => void>();
  const matching = (pattern: RegExp) => logs.filter((line) => pattern.test(line));
  const append = (line: string) => {
    logs.push(line);
    for (const listener of [...listeners]) listener();
  };

  let finished = false;
  const ready = restartWithSettingsReady({
    logCount(pattern) {
      order.push('baseline');
      return matching(pattern).length;
    },
    restart() {
      order.push('restart');
    },
    refreshPort() {
      order.push('port');
    },
    waitForLogLines(pattern, count) {
      waits.push({ pattern, count });
      return new Promise<string[]>((resolve) => {
        const check = () => {
          const lines = matching(pattern);
          if (lines.length >= count) {
            listeners.delete(check);
            resolve(lines);
          }
        };
        listeners.add(check);
        check();
      });
    },
  }).then(() => {
    finished = true;
  });

  expect(waits[0]?.count).toBe(vaultBefore + 1);
  expect(order).toEqual(['baseline', 'baseline', 'restart', 'port']);
  expect(finished).toBe(false);

  // Replay contains old settings readiness and only new vault readiness.
  append('"msg":"Agent Vault is up: second run"');
  await Promise.resolve();
  await Promise.resolve();
  expect(waits).toHaveLength(2);
  expect(waits[1]?.pattern.source).toBe('settings interface is up');
  expect(waits[1]?.count).toBe(2);
  expect(finished).toBe(false);

  // The actual fixture orchestration can now finish, without HTTP retries.
  append('settings interface is up');
  await ready;
  expect(finished).toBe(true);
  expect(listeners.size).toBe(0);
});
