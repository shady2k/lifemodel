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
    result: [string, string, string, number | null] | null;
    calls: unknown[][];
    output: string;
  };
}
describe('real task writer handshake', () => {
  it('submits an owner message and proves a new pod and first collected container line', () => {
    const result = run();
    expect(result.result?.slice(0, 3)).toEqual(['task-pod-1', 'task', 'run-test-a1']);
    expect(typeof result.result?.[3]).toBe('number');
    const post = result.calls.find((call) => call[0] === 'http' && call[1] === 'POST');
    expect(post?.[2]).toBe('/api/messages');
    const text = (post?.[3] as { text: string }).text;
    expect(text).toContain('/proc/1/fd/1');
    expect(text).toContain('walk-task-writer');
    expect(text).toContain('run-test-a1');
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
  it('retries the request and succeeds on the second attempt', () => {
    const result = run({ post_statuses: [403, 202] });
    expect(result.result?.slice(0, 3)).toEqual(['task-pod-2', 'task', 'run-test-a2']);
    const posts = result.calls.filter((call) => call[0] === 'http' && call[1] === 'POST');
    expect(posts).toHaveLength(2);
    const prompts = posts.map((call) => (call[3] as { text: string }).text);
    expect(prompts[0]).toContain('must run as a task, not be answered in chat');
    expect(prompts[0]).toContain('run-test-a1');
    expect(prompts[1]).toContain('Do not answer this message in chat');
    expect(prompts[1]).toContain('run-test-a2');
    expect(prompts[1]).toContain('/proc/1/fd/1');
    expect(result.output).toContain('attempt 2');
    expect(result.output).not.toContain('PRIVATE');
  });

  it('asks three times, reports each attempt, and stays not valid when none starts a task', () => {
    const result = run({ post_statuses: [403, 403, 403] });
    expect(result.result).toBeNull();
    const posts = result.calls.filter((call) => call[0] === 'http' && call[1] === 'POST');
    expect(posts).toHaveLength(3);
    const prompts = posts.map((call) => (call[3] as { text: string }).text);
    for (const [index, prompt] of prompts.entries()) {
      expect(prompt).toContain('must run as a task, not be answered in chat');
      expect(prompt).toContain('/proc/1/fd/1');
      expect(prompt).toContain(`run-test-a${index + 1}`);
    }
    expect(prompts[2]).toContain('This is the last request');
    for (const attempt of [1, 2, 3]) expect(result.output).toContain(`attempt ${attempt}`);
    expect(result.output).toContain('not_valid');
    expect(result.output).not.toContain('PRIVATE');
  });


  it('stops an abandoned attempt and gives the next attempt its own run id', () => {
    const result = run({ late_marker: true });
    expect(result.result?.slice(0, 3)).toEqual(['task-pod-2', 'task', 'run-test-a2']);
    const deletes = result.calls.filter(
      (call) => call[0] === 'run' && call[3] === 'delete' && call[4] === 'pod'
    );
    expect(deletes.map((call) => call[5])).toContain('task-pod-1');
    expect(result.output).toContain('stopped abandoned task pod task-pod-1');
    expect(result.output).not.toContain('PRIVATE');
  });

  it('reports a refused marker page with its HTTP status, never as an empty answer', () => {
    const result = run({ refuse: 503 });
    expect(result.result).toBeNull();
    expect(result.output).toContain('refused=HTTP 503');
    expect(result.output).toContain('not_valid');
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
