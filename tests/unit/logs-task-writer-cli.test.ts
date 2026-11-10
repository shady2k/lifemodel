import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function run(mode: string) {
  return spawnSync(
    'python3',
    [
      'tests/fixtures/logs-task-writer-cli-harness.py',
      mode,
      'deploy/platform/logs-task-writer-step.py',
    ],
    { encoding: 'utf8' }
  );
}

describe('the browser task writer CLI result contract', () => {
  it('emits the exact task identity only after successful launch', () => {
    const result = run('success');
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines.at(-1)).toBe(
      'TASK_WRITER_RESULT ' +
        JSON.stringify({
          pod: 'task-owned-123',
          module: 'task',
          run_id: 'browser-proof',
        })
          .replaceAll(':', ': ')
          .replaceAll(',', ', ')
    );
    expect(result.stdout + result.stderr).not.toContain('NEVER_PRINT_CREDENTIAL');
  });
  for (const mode of ['denied', 'unsafe']) {
    it(`emits no success marker for ${mode}`, () => {
      const result = run(mode);
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('TASK_WRITER_RESULT');
      expect(result.stdout + result.stderr).not.toContain('NEVER_PRINT_CREDENTIAL');
    });
  }
});
