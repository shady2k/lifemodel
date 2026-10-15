/** Fatal stops use the same bounded process coordinator as signal stops. */
import { execFile } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx');
const CHILD = join(process.cwd(), 'tests', 'fixtures', 'fatal-stop-child.ts');

interface ChildResult {
  code: number | null;
  killed: boolean;
  stdout: string;
  stderr: string;
}

function runChild(mode: string): Promise<ChildResult> {
  return new Promise((resolve) => {
    execFile(
      TSX,
      [CHILD, mode],
      { cwd: process.cwd(), timeout: 5_000 },
      (error, stdout, stderr) => {
        resolve({
          code:
            error && typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : 0,
          killed: (error as { killed?: boolean } | null)?.killed === true,
          stdout,
          stderr,
        });
      }
    );
  });
}

describe('fatal stop process boundary', () => {
  it('a clean fatal stop exits non-zero despite an open listener', async () => {
    const result = await runChild('clean');
    expect(result.killed).toBe(false);
    expect(result.stdout, result.stderr).toContain('LISTENING');
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain('Stop deadline reached');
  });

  it('a stalled fatal stop is abandoned at the deadline with the hard-exit error', async () => {
    const result = await runChild('stalled');
    expect(result.killed).toBe(false);
    expect(result.stdout, result.stderr).toContain('LISTENING');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Stop deadline reached: the process exits now, whatever is still pending'
    );
  });
});
