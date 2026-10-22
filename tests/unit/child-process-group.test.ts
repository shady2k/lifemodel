import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { reapProcessGroupOnExit, stopProcessGroup } from '../helpers/child-process-group.js';

/** The inner process a wrapper runs: alive until it is signalled. */
const INNER = 'setInterval(() => {}, 1_000)';

/** A wrapper like `tsx`: it starts the inner process and stays alive itself. */
const WRAPPER = `
const { spawn } = require('node:child_process');
const inner = spawn(process.execPath, ['-e', process.env.INNER_SCRIPT], { stdio: 'ignore' });
process.stdout.write(inner.pid + '\\n');
setInterval(() => {}, 1_000);
`;

/** The state character of a process (`Z` once it exited and waits to be reaped). */
function processState(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    return stat.slice(end + 2, end + 3);
  } catch {
    return undefined;
  }
}

/** A process exists and can still run work: a zombie that waits for reaping cannot. */
function running(pid: number): boolean {
  const state = processState(pid);
  return state !== undefined && state !== 'Z' && state !== 'X';
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function startWrapper(reapOnExit: boolean): Promise<{ child: ChildProcess; inner: number }> {
  const child = spawn(process.execPath, ['-e', WRAPPER], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, INNER_SCRIPT: INNER },
  });
  if (reapOnExit) reapProcessGroupOnExit(child);
  const inner = await new Promise<number>((resolve, reject) => {
    child.once('exit', () => reject(new Error('Wrapper exited before naming its inner process')));
    child.stdout?.once('data', (chunk: Buffer) => {
      const pid = Number(/\d+/.exec(chunk.toString())?.[0]);
      if (!pid) reject(new Error('Wrapper named no inner process'));
      else resolve(pid);
    });
  });
  return { child, inner };
}

describe('a detached test child and its process group (lifemodel-653.7.10)', () => {
  it('stops an inner process that outlived its killed wrapper', async () => {
    const { child, inner } = await startWrapper(false);
    try {
      // Only the wrapper dies, as a per-process OOM kill would take it.
      process.kill(child.pid!, 'SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));

      await waitFor(() => running(inner), 'the inner process to be seen running');
      // The wrapper's exit is not the group's end.
      expect(running(inner)).toBe(true);

      await stopProcessGroup(child);

      await waitFor(() => !running(inner), 'the inner process to be gone');
      expect(running(inner)).toBe(false);
    } finally {
      await stopProcessGroup(child);
    }
  });

  it('reaps the group when the wrapper exits on its own', async () => {
    const { child, inner } = await startWrapper(true);
    try {
      expect(running(inner)).toBe(true);
      process.kill(child.pid!, 'SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));

      await waitFor(() => !running(inner), 'the inner process to be reaped with the group');
      expect(running(inner)).toBe(false);
    } finally {
      await stopProcessGroup(child);
    }
  });
});
