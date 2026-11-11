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
    deleted_jobs: string[];
  };
}
const posts = (result: { calls: unknown[][] }) =>
  result.calls.filter((call) => call[0] === 'http' && call[1] === 'POST');
const prompts = (result: { calls: unknown[][] }) =>
  posts(result).map((call) => (call[3] as { text: string }).text);
const podDeletes = (result: { calls: unknown[][] }) =>
  result.calls.filter(
    (call) =>
      call[0] === 'run' && call[2] === 'delete' && call[3] === 'pod'
  );

describe('real task writer handshake', () => {
  it('submits an owner message and proves a new pod and first collected container line', () => {
    const outcome = run();
    expect(outcome.result?.slice(0, 3)).toEqual(['task-pod-1', 'task', 'run-test-a1']);
    expect(typeof outcome.result?.[3]).toBe('number');
    const post = posts(outcome)[0];
    expect(post?.[2]).toBe('/api/messages');
    const text = (post?.[3] as { text: string }).text;
    expect(text).toContain('/proc/1/fd/1');
    expect(text).toContain('walk-task-writer');
    expect(text).toContain('run-test-a1');
    expect(text).toContain('20480');
    expect(
      outcome.calls.some(
        (call) =>
          call[0] === 'http' && call[1] === 'GET' && String(call[2]).startsWith('/api/transcript')
      )
    ).toBe(true);
    expect(outcome.calls.filter((call) => call[0] === 'close')).toHaveLength(1);
    expect(outcome.output).toContain('chat accepted -> pod Running');
    expect(outcome.output).not.toContain('PRIVATE');
  });

  it('retries the request and succeeds on the second attempt', () => {
    const outcome = run({ post_statuses: [403, 202] });
    expect(outcome.result?.slice(0, 3)).toEqual(['task-pod-2', 'task', 'run-test-a2']);
    expect(posts(outcome)).toHaveLength(2);
    const texts = prompts(outcome);
    expect(texts[0]).toContain('must run as a task, not be answered in chat');
    expect(texts[0]).toContain('run-test-a1');
    expect(texts[1]).toContain('Do not answer this message in chat');
    expect(texts[1]).toContain('run-test-a2');
    expect(texts[1]).toContain('/proc/1/fd/1');
    expect(outcome.output).toContain('attempt=2');
    expect(outcome.output).not.toContain('PRIVATE');
  });

  it('accepts a late earlier attempt while a later attempt is still watched', () => {
    const outcome = run({ marker_after_attempt: { 1: 200, 2: 999 } });
    expect(outcome.result?.slice(0, 3)).toEqual(['task-pod-1', 'task', 'run-test-a1']);
    expect(outcome.deleted_jobs).toEqual(['task-job-2']);
    expect(outcome.output).toContain('pod Running -> first marker');
    expect(outcome.output).toContain('abandoned task Job leaves no pod');
    expect(podDeletes(outcome)).toEqual([]);
    expect(outcome.output).not.toContain('PRIVATE');
  });

  it('accepts the first collected marker and stops the other attempt\'s Job', () => {
    const outcome = run({ marker_after_attempt: { 1: 200 } });
    expect(outcome.result?.slice(0, 3)).toEqual(['task-pod-2', 'task', 'run-test-a2']);
    expect(outcome.deleted_jobs).toEqual(['task-job-1']);
    expect(outcome.output).toContain('chat accepted -> pod Running');
    expect(podDeletes(outcome)).toEqual([]);
  });

  it('asks three times, reports each attempt, and stays not valid when none starts a task', () => {
    const outcome = run({ post_statuses: [403, 403, 403] });
    expect(outcome.result).toBeNull();
    expect(posts(outcome)).toHaveLength(3);
    const texts = prompts(outcome);
    for (const [index, prompt] of texts.entries()) {
      expect(prompt).toContain('must run as a task, not be answered in chat');
      expect(prompt).toContain('/proc/1/fd/1');
      expect(prompt).toContain(`run-test-a${index + 1}`);
    }
    expect(texts[2]).toContain('This is the last request');
    for (const attempt of [1, 2, 3]) expect(outcome.output).toContain(`attempt ${attempt}`);
    expect(outcome.output).toContain('not_valid');
    expect(outcome.output).not.toContain('PRIVATE');
  });

  it('stops every abandoned attempt by its Job, never a pod', () => {
    const outcome = run({ no_marker: true });
    expect(outcome.result).toBeNull();
    expect(outcome.deleted_jobs).toEqual(['task-job-1', 'task-job-2', 'task-job-3']);
    expect(podDeletes(outcome)).toEqual([]);
    expect(outcome.output).toContain('not_valid');
    expect(outcome.output).toContain('first_collected_marker=False');
    expect(outcome.output).not.toContain('PRIVATE');
  });

  it('reports a refused marker page with its HTTP status, never as an empty answer', () => {
    const outcome = run({ refuse: 503 });
    expect(outcome.result).toBeNull();
    expect(outcome.output).toContain('refused=HTTP 503');
    expect(outcome.output).toContain('not_valid');
    expect(podDeletes(outcome)).toEqual([]);
    expect(outcome.output).not.toContain('PRIVATE');
  });

  it.each([{ no_pod: true }, { post_status: 403 }, { no_forward: true }])(
    'invalidates a missing launch/collection instead of fabricating a task: %j',
    (fixture) => {
      const outcome = run(fixture);
      expect(outcome.result).toBeNull();
      expect(outcome.output).toContain('not_valid');
      expect(outcome.output).not.toContain('PRIVATE');
      expect(outcome.calls.filter((call) => call[0] === 'close')).toHaveLength(1);
      expect(podDeletes(outcome)).toEqual([]);
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
    const outcome = run({ record });
    expect(outcome.result).toBeNull();
    expect(outcome.output).toContain('not_valid');
    expect(podDeletes(outcome)).toEqual([]);
  });
});
