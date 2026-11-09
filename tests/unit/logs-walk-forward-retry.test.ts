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
  readonly keptLog: boolean;
  readonly death: string | null;
  readonly log: readonly string[];
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

  it('sends every store request target with its leading slash', () => {
    const result = run('store-paths');
    expect(result.status).toBe(0);
    const targets = value<string[]>(result, 'TARGETS ');
    for (const target of targets) expect(target.startsWith('/'), target).toBe(true);
    expect(value<Record<string, string>>(result, 'RESULTS ')).toEqual({
      flags: 'ok',
      metrics: 'ok',
      query: 'ok',
      count: 'ok',
      insert: 'ok',
      detach: 'ok',
      partitionList: 'ok',
    });
    // The seam's five operations, each on its own absolute path (ADR-016 §3).
    expect(targets).toContain('/flags');
    expect(targets).toContain('/metrics');
    expect(targets.some((target) => target.startsWith('/select/logsql/query'))).toBe(true);
    expect(targets.some((target) => target.startsWith('/insert/jsonline'))).toBe(true);
    expect(targets.some((target) => target.startsWith('/internal/partition/detach'))).toBe(true);
    expect(targets.some((target) => target.startsWith('/internal/partition/list'))).toBe(true);
  });

  it("keeps the walk's error when even the new forward does not answer", () => {
    const result = run('forward-never-replaced');
    expect(result.status).toBe(0);
    expect(value<string[]>(result, 'READS ')).toEqual(['7d']);
    const error = result.lines.find((entry) => entry.startsWith('ERROR ')) ?? '';
    expect(error).toContain('store_unreachable');
    // The renewal retries its start three times, each on its own port, after the
    // forward the client held was closed.
    const forwards = value<Forward[]>(result, 'FORWARDS ');
    expect(forwards).toHaveLength(4);
    expect(forwards[0].closed).toBe(true);
    expect(forwards[0].keptLog).toBe(false);
    for (let index = 1; index < forwards.length; index++) {
      expect(forwards[index].keptLog).toBe(true);
      expect(forwards[index].port).not.toBe(forwards[index - 1].port);
    }
    // What the failed starts said travels with the error, so the walk's FAIL
    // line carries kubectl's own words.
    expect(error).toContain('the process exited with code 1');
    expect(error).toContain('kubectl: error: lost connection to pod');
  });

  it('tries the start again when a transient failure keeps the forward down', () => {
    const result = run('forward-retried');
    expect(result.status).toBe(0);
    expect(value<{ opened: boolean; flags: string }>(result, 'OPEN ')).toEqual({
      opened: true,
      flags: '14d',
    });
    const forwards = value<Forward[]>(result, 'FORWARDS ');
    expect(forwards).toHaveLength(3);
    expect(forwards[0].death).toBe('the process exited with code 1');
    expect(forwards[1].death).toBe('nothing accepted 127.0.0.1:41777 within 1 s');
    // The failed starts' logs are kept, the one that answered is closed as usual.
    expect(forwards[0].keptLog).toBe(true);
    expect(forwards[1].keptLog).toBe(true);
    expect(forwards[2].requests).toBe(1);
  });

  it('names each failed start and its own last lines in the detail', () => {
    const result = run('forward-death-detail');
    expect(value<boolean>(result, 'OPEN ')).toBe(false);
    const detail = value<string>(result, 'DETAIL ');
    expect(detail).toContain('3 start(s)');
    expect(detail).toContain('1) the process exited with code 1');
    expect(detail).toContain('3) the process exited with code 1');
    expect(detail).toContain('kubectl: error: lost connection to pod');
    const forwards = value<Forward[]>(result, 'FORWARDS ');
    expect(forwards).toHaveLength(3);
    for (const forward of forwards) expect(forward.keptLog).toBe(true);
  });

  it('gives up after three tries 15 s apart', () => {
    const result = run('forward-defaults');
    expect(value<{ attempts: number; interval: number }>(result, 'DEFAULTS ')).toEqual({
      attempts: 3,
      interval: 15,
    });
  });

  it('says whether the process exited and keeps the log of a forward that never came up', () => {
    const result = run('portforward-death');
    const death = value<{
      ready: boolean;
      death: string;
      lines: string[];
      kept: boolean;
      gone: boolean;
    }>(result, 'DEATH ');
    expect(death.ready).toBe(false);
    expect(death.death).toBe('the process exited with code 1');
    expect(death.lines.join('\n')).toContain('pod is not running');
    // Kept while it is evidence; removed by the next close that does not ask for it.
    expect(death.kept).toBe(true);
    expect(death.gone).toBe(true);
  });
});
