/**
 * The command runner over REAL children (the round-2 review's N2).
 *
 * The doubles elsewhere in the suite settle a command's promise when the
 * loader's cancellation reaches it - a modelling shortcut that equated
 * rejection with death. The real runner must not: a child that ignores
 * SIGTERM outlives the abort, and the promise keeps the command's ownership
 * until the child is REAPED (close). These tests run real processes, always
 * bounded, and reap what they start.
 */
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createNodeRunner } from '../../loader/src/exec.js';

describe('the node command runner over real children', () => {
  it('keeps a cancelled command owned until its child is reaped: the promise stays unsettled while a SIGTERM-ignoring child is alive, and rejects once it is killed', async () => {
    const runner = createNodeRunner();
    const controller = new AbortController();
    const readyMarker = join(tmpdir(), `q4xlf2-ready-${String(Date.now())}.flag`);
    // A real child that ignores SIGTERM and stays alive, and says when it is
    // past its handler setup by writing a file.
    const pending = runner.run(
      'node',
      [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(readyMarker)}, 'ready'); process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000);`,
      ],
      { timeoutMs: 60_000, signal: controller.signal }
    );
    let settled = false;
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    // The child is alive and has its SIGTERM handler installed.
    await vi.waitFor(() => {
      expect(existsSync(readyMarker)).toBe(true);
    });
    controller.abort();
    // The abort must NOT settle the command: the child is still alive, and
    // the ownership has not ended.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    // The escalation reaches it: the runner rejects with the cancellation,
    // and the rejection is the reap's own moment.
    await expect(pending).rejects.toThrow(/was cancelled/);
    expect(settled).toBe(true);
    rmSync(readyMarker, { force: true });
  }, 20_000);

  it('a command that exits by itself still resolves with its result, and a spawn that never happened rejects with its error', async () => {
    const runner = createNodeRunner();
    await expect(
      runner.run('node', ['-e', "console.log('fine')"], { timeoutMs: 15_000 })
    ).resolves.toMatchObject({ code: 0, stdout: 'fine\n' });
    await expect(runner.run('no-such-binary-q4xlf2', [])).rejects.toThrow(/no-such-binary-q4xlf2/);
  });
});
