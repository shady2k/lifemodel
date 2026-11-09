/** Every stage-2 walk must parse clean: a name it uses and never imports or
 * defines is a crash at the line that uses it, and the VM's bound and evict runs
 * died at their first `Volume` use with `NameError` (ADR-016 stage 2). The check
 * is an `ast`/`symtable` pass in `tests/fixtures/logs-walk-names-check.py`, so it
 * needs nothing the test boundary does not already have.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CHECK = join('tests', 'fixtures', 'logs-walk-names-check.py');
const PLATFORM = join('deploy', 'platform');

interface Run {
  readonly status: number | null;
  readonly lines: readonly string[];
}

function check(...paths: readonly string[]): Run {
  const result = spawnSync('python3', [CHECK, ...paths], { encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  return {
    status: result.status,
    lines: result.stdout.split('\n').filter((line) => line.length > 0),
  };
}

const walks = readdirSync(PLATFORM)
  .filter((name) => /^logs-.*-walk\.py$/.test(name))
  .sort();

let directory = '';

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'logs-walk-names-'));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('the walk name check', () => {
  it('reports a name that is used but never imported or defined', () => {
    const path = join(directory, 'undefined.py');
    writeFileSync(path, 'import os\n\n\ndef main():\n    return Volume(os.sep)\n');
    const run = check(path);
    expect(run.status).toBe(1);
    expect(run.lines.join('\n')).toContain("name 'Volume' is used but never imported or defined");
  });

  it('accepts a name the module imports, defines or a nested scope binds', () => {
    const path = join(directory, 'defined.py');
    writeFileSync(
      path,
      'import os\n\nTOP = 1\n\n\ndef outer():\n    local = TOP\n\n    def inner():\n'
        + '        return local + len(os.sep)\n\n    return inner\n',
    );
    expect(check(path).status).toBe(0);
  });
});

describe('every logs walk resolves every name it uses', () => {
  it('finds the walks', () => {
    expect(walks.length).toBeGreaterThanOrEqual(6);
    expect(walks).toContain('logs-bound-walk.py');
  });

  it('has no undefined name in any walk or in the shared support module', () => {
    const modules = walks.map((name) => join(PLATFORM, name));
    modules.push(join(PLATFORM, 'logs_walk_support.py'));
    const run = check(...modules);
    expect(run.lines).toEqual([]);
    expect(run.status).toBe(0);
  });
});
