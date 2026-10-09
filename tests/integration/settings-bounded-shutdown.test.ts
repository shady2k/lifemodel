/**
 * The settings close is bounded, in a REAL process (lifemodel-q4x.4, review
 * finding 1).
 *
 * The finding: `stopAndLeave` awaited the settings server's close BEFORE the
 * one stop deadline was armed. A request that never finished - fastify's
 * requestTimeout is 0; a POST with a Content-Length and half a body is enough -
 * stalled that await, so the deadline never started and the loader killed
 * lifemodel instead of letting it drain.
 *
 * The child fixture holds such a socket open, then stops the way src/index.ts
 * does now (the deadline ARMED first, then the bounded close):
 *
 * - a settings save (the restart, exit code 75) - the child leaves at once;
 * - a signal like the loader's stop (SIGTERM, exit 0) - the test sends it once
 *   the child reports its committed stop.
 *
 * Both leave on their own, inside the deadline - the codes are the assertion.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx');
const CHILD = join(process.cwd(), 'tests', 'fixtures', 'settings-partial-request-child.ts');

interface ChildResult {
  code: number | null;
  signal: string | null;
  stderr: string;
}

/**
 * Run the child. When a marker line appears on its stderr (its default is the
 * moment the half-sent request has been held open), the optional signal is
 * sent. The child is killed after `timeoutMs` if it leaves on its own before
 * then (it never should).
 */
function runChild(
  mode: string,
  options: { signal?: NodeJS.Signals; on?: string; timeoutMs?: number } = {}
): Promise<ChildResult> {
  const { signal, on, timeoutMs } = options;
  return new Promise((resolve) => {
    let stderr = '';
    let signaled = false;
    const child = spawn(TSX, [CHILD, mode], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (signal && !signaled && on !== undefined && stderr.includes(on)) {
        signaled = true;
        child.kill(signal);
      }
    });
    const killTimer = setTimeout(
      () => {
        child.kill('SIGKILL');
      },
      timeoutMs ?? 10_000
    );
    child.on('close', (code, signalName) => {
      clearTimeout(killTimer);
      resolve({ code, signal: signalName, stderr });
    });
  });
}

describe('the settings close inside the stop deadline', { timeout: 30_000 }, () => {
  it('a settings save cannot be stalled by a half-sent request: it exits with the restart code', async () => {
    const result = await runChild('restart');

    expect(result.signal).toBeNull(); // it left on its own, not killed
    expect(result.stderr).toContain('HOLD-OPEN');
    expect(result.stderr).toContain('CLOSED-BOUNDED');
    expect(result.code).toBe(75);
    expect(result.stderr).not.toContain('Stop deadline reached');
  });

  it('a signal cannot be stalled either: the process leaves 0, drained', async () => {
    const result = await runChild('sigterm', { signal: 'SIGTERM', on: 'HOLD-OPEN' });

    expect(result.signal).toBeNull();
    expect(result.stderr).toContain('HOLD-OPEN');
    expect(result.stderr).toContain('CLOSED-BOUNDED');
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('Stop deadline reached');
  });
});
