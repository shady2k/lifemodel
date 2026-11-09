/** The walks' store client holds a port-forward that the store's own pod
 * replacement kills: retention and the partition key both roll the store, and a
 * forward is bound to the pod it resolved when it started. The client replaces
 * the forward on a connection failure and retries once, so the request reaches a
 * fresh forward on a fresh port; a second failure is the walk's error as today.
 * Held against fake forwards in
 * `tests/fixtures/logs-walk-store-forward-harness.py`: the first answers, then
 * its listener closes, and only a new forward can answer again.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HARNESS = join('tests', 'fixtures', 'logs-walk-store-forward-harness.py');
const SUPPORT = join('deploy', 'platform', 'logs_walk_support.py');

interface Forward {
  readonly port: number;
  readonly requests: number;
  readonly stopped: boolean;
  readonly closed: boolean;
}

interface Run {
  readonly status: number | null;
  readonly lines: readonly string[];
}

function run(mode: string): Run {
  const result = spawnSync('python3', [HARNESS, mode, SUPPORT], { encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  return { status: result.status, lines: result.stdout.split('\n') };
}

function value<T>(result: Run, prefix: string): T {
  const line = result.lines.find((entry) => entry.startsWith(prefix));
  expect(line, prefix).toBeDefined();
  return JSON.parse((line ?? '').slice(prefix.length)) as T;
}

describe("the store client survives the store's pod being replaced", () => {
  it('renews the forward and answers the retry through the new port', () => {
    const result = run('forward-replaced');
    expect(result.status).toBe(0);
    expect(value<string[]>(result, 'READS ')).toEqual(['7d', '14d']);
    const forwards = value<Forward[]>(result, 'FORWARDS ');
    expect(forwards).toHaveLength(2);
    expect(forwards[0].stopped).toBe(true);
    expect(forwards[0].closed).toBe(true);
    expect(forwards[1].requests).toBe(1);
    expect(forwards[1].port).not.toBe(forwards[0].port);
  });

  it("keeps the walk's error when even the new forward does not answer", () => {
    const result = run('forward-never-replaced');
    expect(result.status).toBe(0);
    expect(value<string[]>(result, 'READS ')).toEqual(['7d']);
    const error = result.lines.find((entry) => entry.startsWith('ERROR ')) ?? '';
    expect(error).toContain('store_unreachable');
    const forwards = value<Forward[]>(result, 'FORWARDS ');
    expect(forwards).toHaveLength(2);
    expect(forwards[1].port).not.toBe(forwards[0].port);
  });
});
