import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const platform = resolve('deploy/platform');
const walks = readdirSync(platform).filter((name) => /^logs-.*-walk\.py$/.test(name));
let directory = '';
let copiedPlatform = '';

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'logs-walk-entrypoints-'));
  copiedPlatform = join(directory, 'platform');
  cpSync(platform, copiedPlatform, { recursive: true });
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

const parserContract = String.raw`
import ast
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
tree = ast.parse(path.read_text())
support = ast.parse((path.parent / 'logs_walk_support.py').read_text())
common = next(node for node in support.body
              if isinstance(node, ast.FunctionDef) and node.name == 'common_arguments')

def arguments(root):
    result = set()
    for node in ast.walk(root):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == 'set_defaults'):
            result.update(kw.arg for kw in node.keywords if kw.arg)
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == 'add_argument'):
            continue
        names = [arg.value for arg in node.args
                 if isinstance(arg, ast.Constant) and isinstance(arg.value, str)]
        explicit = next((kw.value.value for kw in node.keywords
                         if kw.arg == 'dest' and isinstance(kw.value, ast.Constant)), None)
        if explicit:
            result.add(explicit)
        elif names:
            name = next((name for name in names if name.startswith('--')), names[0])
            result.add(name.lstrip('-').replace('-', '_'))
    return result

reads = {node.attr for node in ast.walk(tree)
         if isinstance(node, ast.Attribute) and isinstance(node.ctx, ast.Load)
         and isinstance(node.value, ast.Name) and node.value.id == 'options'}
defined = arguments(tree)
if any(isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
       and node.func.id == 'common_arguments' for node in ast.walk(tree)):
    defined |= arguments(common)
errors = sorted(reads - defined)
print(json.dumps(errors))
`;

describe('standalone Python log walk entrypoints', () => {
  it.each(walks)('%s prints help from an isolated copied deployment', (name) => {
    const result = spawnSync('python3', ['-I', join(copiedPlatform, name), '--help'], {
      cwd: directory,
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--help');
  });

  it.each(walks)('%s defines every options attribute it reads', (name) => {
    const result = spawnSync('python3', ['-I', '-c', parserContract, join(platform, name)], {
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });
});
