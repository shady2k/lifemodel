import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function run(mode: string) {
  const result = spawnSync('node', ['tests/fixtures/logs-page-task-harness.mjs', mode], {
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe('page task record preparation', () => {
  it('uses only a stored task record with its real module and untrusted flag', () => {
    expect(run('existing')).toEqual({ module: 'task', message: 'existing', launches: 0 });
  });
  it('runs the core-chat pre-step then re-reads real API evidence', () => {
    expect(run('launch')).toEqual({
      module: 'task',
      message: 'walk-task-writer run-1 seq=1',
      launches: 1,
    });
  });
  it.each(['failed', 'missing', 'forged', 'wrong-module', 'wrong-pod'])(
    'cannot fabricate a record after %s evidence',
    (mode) => {
      expect(run(mode)).toEqual({ record: null });
    }
  );
});
