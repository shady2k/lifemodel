/**
 * The hard exit in a REAL process (lifemodel-ctc.1.2, review round 1 finding 1).
 *
 * The injected-exit tests keep Vitest alive while they wait, so they cannot
 * show that the production process really leaves. This one spawns a child with
 * NO other referenced handle (tests/fixtures/stop-deadline-child.ts) and
 * checks what the process itself does:
 * - a never-resolving shutdown step: exit code 1 and the one error line at the
 *   deadline (an UNREF'D timer let the child leave with code 0 at once, before
 *   the deadline: measured);
 * - a clean, timely shutdown: the timer is disarmed, the process lives PAST
 *   the deadline on a referenced handle, exits 0 and never fires.
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx');
const CHILD = join(process.cwd(), 'tests', 'fixtures', 'stop-deadline-child.ts');

interface ChildResult {
  code: number | null;
  killed: boolean;
  stdout: string;
  stderr: string;
}

/** Run the child to completion (or kill it after `timeoutMs`). */
function runChild(mode: string, timeoutMs = 10_000): Promise<ChildResult> {
  return new Promise((resolve) => {
    execFile(
      TSX,
      [CHILD, mode],
      { cwd: process.cwd(), timeout: timeoutMs },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : 0;
        resolve({
          code,
          killed: (error as { killed?: boolean } | null)?.killed === true,
          stdout,
          stderr,
        });
      }
    );
  });
}

describe('the stop deadline in a real process (lifemodel-ctc.1.2)', { timeout: 30_000 }, () => {
  it('a never-resolving shutdown step: the process exits 1 at the deadline, naming it', async () => {
    const result = await runChild('hung');

    expect(result.killed).toBe(false); // it left on its own, not by the timeout
    expect(result.stderr).toContain('ARMED-HUNG');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Stop deadline reached: the process exits now, whatever is still pending'
    );
    expect(result.stderr).toContain('"step":"intake_stop"');
  });

  it('a clean, timely shutdown: the timer is disarmed, the process exits 0 and it never fires', async () => {
    const result = await runChild('clean');

    expect(result.killed).toBe(false);
    expect(result.stderr).toContain('DISARMED');
    // it lived PAST the deadline (the referenced handle), so a timer that was
    // not disarmed would have fired inside that window
    expect(result.stderr).toContain('NO-FIRE');
    expect(result.stderr).not.toContain('HARD-EXIT');
    expect(result.code).toBe(0);
  });
});
