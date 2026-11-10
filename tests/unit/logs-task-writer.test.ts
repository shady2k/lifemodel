import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let directory = '';
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'task-writer-'));
});
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});
function run(fixture: object = {}) {
  const path = join(directory, 'fixture.json');
  writeFileSync(path, JSON.stringify(fixture));
  const result = spawnSync('python3', ['tests/fixtures/logs-task-writer-harness.py', path], {
    encoding: 'utf8',
  });
  const line = result.stdout.split('\n').find((value) => value.startsWith('SUMMARY '));
  expect(line, result.stderr).toBeDefined();
  return JSON.parse(line!.slice(8)) as {
    result: [string, string] | null;
    calls: unknown[][];
    output: string;
  };
}
describe('real task writer handshake', () => {
  it('submits an owner message and proves a new pod and first collected container line', () => {
    const result = run();
    expect(result.result).toEqual(['task-new-pod', 'task']);
    const post = result.calls.find((call) => call[0] === 'http' && call[1] === 'POST');
    expect(post?.[2]).toBe('/api/messages');
    const text = (post?.[3] as { text: string }).text;
    expect(text).toContain('/proc/1/fd/1');
    expect(text).toContain('walk-task-writer');
    expect(text).toContain('run-test');
    expect(text).toContain('20480');
    expect(
      result.calls.some(
        (call) =>
          call[0] === 'http' && call[1] === 'GET' && String(call[2]).startsWith('/api/transcript')
      )
    ).toBe(true);
    expect(result.calls.filter((call) => call[0] === 'close')).toHaveLength(1);
    expect(result.output).not.toContain('PRIVATE');
  });
  it.each([{ no_pod: true }, { no_marker: true }, { post_status: 403 }, { no_forward: true }])(
    'invalidates a missing launch/collection instead of fabricating a task: %j',
    (fixture) => {
      const result = run(fixture);
      expect(result.result).toBeNull();
      expect(result.output).toContain('not_valid');
      expect(result.output).not.toContain('PRIVATE');
      expect(result.calls.filter((call) => call[0] === 'close')).toHaveLength(1);
    }
  );
  it.each([
    { module: 'forged-module' },
    { untrusted: false },
    { pod: 'task-old' },
    { namespace: 'lifemodel' },
    { message: 'a task named run-test was created' },
    { message: 'walk-task-writer run-test seq=10 ' },
  ])('rejects a mismatched collected marker: %j', (record) => {
    const result = run({ record });
    expect(result.result).toBeNull();
    expect(result.output).toContain('not_valid');
  });
});
