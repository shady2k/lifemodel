import { describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkTree,
  hasVendorName,
  readList,
  scanTree,
} from '../../scripts/check-vendor-names.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const script = fileURLToPath(new URL('../../scripts/check-vendor-names.mjs', import.meta.url));
const listPath = join(repoRoot, 'scripts', 'vendor-names.json');

type AllowedPlace = { path: string; reason: string };
type NameEntry = { name: string; allowed: AllowedPlace[] };
type ExceptionEntry = { name: string; path: string; reason: string };

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'vendor-names-'));
  for (const dir of [
    'src',
    'loader/src',
    'web/app',
    'scripts',
    'tests',
    'docs',
    'deploy',
    'docker',
    '.github',
  ])
    mkdirSync(join(root, dir), { recursive: true });
  return root;
}

function writeFile(root: string, relative: string, lines: string[]): void {
  const target = join(root, relative);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, `${lines.join('\n')}\n`);
}

function writeList(
  root: string,
  names: NameEntry[],
  exceptions: ExceptionEntry[] = [],
  file = 'scripts/vendor-names.json'
): string {
  const target = join(root, file);
  writeFileSync(target, JSON.stringify({ names, exceptions }, null, 2) + '\n');
  return target;
}

const opencodeAllowed = (): AllowedPlace[] => [
  {
    path: 'loader/src/task-opencode.ts',
    reason: 'The OpenCode adapter configures this harness.',
  },
];

describe('the vendor-name check (lifemodel-1be4)', () => {
  it('fails a planted opencode in generic task code, naming file, line, name and allowed places', () => {
    const root = fixture();
    try {
      writeFile(root, 'src/core/task-runner.ts', ['const harness = "opencode";']);
      const list = writeList(root, [
        { name: 'opencode', allowed: opencodeAllowed() },
      ]);
      const result = checkTree({ root, listPath: list });
      expect(result.violations).toEqual([
        {
          path: 'src/core/task-runner.ts',
          line: 1,
          name: 'opencode',
          allowed: ['loader/src/task-opencode.ts'],
        },
      ]);
      expect(result.stale).toEqual([]);

      const run = runScript(root, []);
      expect(run.status).toBe(1);
      expect(run.output).toContain('src/core/task-runner.ts:1');
      expect(run.output).toContain('opencode');
      expect(run.output).toContain('loader/src/task-opencode.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails a planted ghcr.io in generic loader code', () => {
    const root = fixture();
    try {
      writeFile(root, 'loader/src/image-pull.ts', [
        'export const registry =',
        "  'https://ghcr.io';",
      ]);
      const list = writeList(root, [
        {
          name: 'ghcr.io',
          allowed: [
            {
              path: 'loader/src/workbench-source.ts',
              reason: 'The workbench pull source is where a registry default is set.',
            },
          ],
        },
      ]);
      const result = checkTree({ root, listPath: list });
      expect(result.violations).toEqual([
        {
          path: 'loader/src/image-pull.ts',
          line: 2,
          name: 'ghcr.io',
          allowed: ['loader/src/workbench-source.ts'],
        },
      ]);
      const run = runScript(root, []);
      expect(run.status).toBe(1);
      expect(run.output).toContain('loader/src/image-pull.ts:2');
      expect(run.output).toContain('ghcr.io');
      expect(run.output).toContain('loader/src/workbench-source.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts the adapter and the default setting, and rejects them for another name', () => {
    const root = fixture();
    try {
      writeFile(root, 'loader/src/task-opencode.ts', ['OPENCODE_CONFIG = "x";']);
      writeFile(root, 'loader/src/workbench-source.ts', ["registry: 'https://ghcr.io',"]);
      const list = writeList(root, [
        { name: 'opencode', allowed: opencodeAllowed() },
        {
          name: 'ghcr.io',
          allowed: [
            {
              path: 'loader/src/workbench-source.ts',
              reason: 'The workbench pull source is where a registry default is set.',
            },
          ],
        },
      ]);
      expect(checkTree({ root, listPath: list })).toMatchObject({ violations: [], stale: [] });

      writeFile(root, 'loader/src/task-opencode.ts', ["registry: 'https://ghcr.io',"]);
      expect(checkTree({ root, listPath: list }).violations).toEqual([
        {
          path: 'loader/src/task-opencode.ts',
          line: 1,
          name: 'ghcr.io',
          allowed: ['loader/src/workbench-source.ts'],
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a reviewed exception and fails it as stale when the name leaves the file', () => {
    const root = fixture();
    try {
      writeFile(root, 'src/llm/provider.ts', ['/** OpenRouter generation ids. */']);
      const list = writeList(
        root,
        [{ name: 'openrouter', allowed: [] }],
        [
          {
            name: 'openrouter',
            path: 'src/llm/provider.ts',
            reason: 'A doc comment describes the generation id field.',
          },
        ]
      );
      expect(checkTree({ root, listPath: list })).toMatchObject({ violations: [], stale: [] });

      writeFile(root, 'src/llm/provider.ts', ['/** Provider generation ids. */']);
      const stale = checkTree({ root, listPath: list });
      expect(stale.violations).toEqual([]);
      expect(stale.stale).toEqual([{ name: 'openrouter', path: 'src/llm/provider.ts' }]);
      const run = runScript(root, []);
      expect(run.status).toBe(1);
      expect(run.output).toContain('src/llm/provider.ts');
      expect(run.output).toContain('remove its entry');
      expect(run.output).toContain('scripts/vendor-names.json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('matches case-insensitively, only as a whole token, and includes comments', () => {
    const root = fixture();
    try {
      writeFile(root, 'src/names.ts', [
        '// xopencode does not name the vendor',
        '// opencodex does not name the vendor',
        '// OpenCode does name the vendor, in a comment',
        '// see openrouter.ai for the ranking',
        "import provider from '@openrouter/ai-sdk-provider';",
      ]);
      const list = writeList(root, [
        { name: 'opencode', allowed: opencodeAllowed() },
        { name: 'openrouter', allowed: [] },
      ]);
      expect(checkTree({ root, listPath: list }).violations).toEqual([
        {
          path: 'src/names.ts',
          line: 3,
          name: 'opencode',
          allowed: ['loader/src/task-opencode.ts'],
        },
        {
          path: 'src/names.ts',
          line: 4,
          name: 'openrouter',
          allowed: [],
        },
        {
          path: 'src/names.ts',
          line: 5,
          name: 'openrouter',
          allowed: [],
        },
      ]);
      expect(hasVendorName('xopencode', 'opencode')).toBe(false);
      expect(hasVendorName('opencodex', 'opencode')).toBe(false);
      expect(hasVendorName('_opencode_', 'opencode')).toBe(false);
      expect(hasVendorName('OpenCode', 'opencode')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sorts violations by path, line and name regardless of file creation order', () => {
    const root = fixture();
    try {
      writeFile(root, 'web/app/z.ts', ['ghcr.io']);
      writeFile(root, 'src/b.ts', ['openrouter']);
      writeFile(root, 'src/a.ts', ['openrouter', 'opencode']);
      const list = writeList(root, [
        { name: 'opencode', allowed: [] },
        { name: 'openrouter', allowed: [] },
        { name: 'ghcr.io', allowed: [] },
      ]);
      expect(checkTree({ root, listPath: list }).violations.map((v) => `${v.path}:${v.line}:${v.name}`)).toEqual([
        'src/a.ts:1:openrouter',
        'src/a.ts:2:opencode',
        'src/b.ts:1:openrouter',
        'web/app/z.ts:1:ghcr.io',
      ]);
      const first = runScript(root, []);
      const second = runScript(root, []);
      expect(first.status).toBe(1);
      expect(first.output).toBe(second.output);
      expect(first.output.indexOf('src/a.ts:1')).toBeLessThan(first.output.indexOf('src/b.ts:1'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scans source and JSON under src, loader and web only, skipping generated and non-source files', () => {
    const root = fixture();
    try {
      for (const relative of [
        'src/a.ts',
        'src/b.json',
        'web/app/c.mjs',
        'loader/src/d.tsx',
        'src/node_modules/vendored.ts',
        'src/dist/generated.ts',
        'src/coverage/report.html',
        'src/.vite/cache.ts',
        'src/notes.md',
        'src/data.yaml',
        'tests/fixture.ts',
        'docs/guide.md',
        'deploy/module.nix',
        'scripts/tool.mjs',
        'docker/Dockerfile',
        '.github/workflow.yml',
      ])
        writeFile(root, relative, ['opencode']);
      const list = writeList(root, [{ name: 'opencode', allowed: [] }]);
      const scanned = scanTree(root);
      expect(scanned).toEqual([
        'loader/src/d.tsx',
        'src/a.ts',
        'src/b.json',
        'web/app/c.mjs',
      ]);
      expect(checkTree({ root, listPath: list }).violations.map((v) => v.path)).toEqual(scanned);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats a missing, malformed or contradictory list as an input error, never a pass', () => {
    const root = fixture();
    try {
      const missing = runScript(root, []);
      expect(missing.status).toBe(2);
      expect(missing.output).toMatch(/required input/);

      const list = join(root, 'scripts', 'vendor-names.json');
      writeFileSync(list, 'not json\n');
      expect(runScript(root, []).status).toBe(2);

      writeList(root, [{ name: 'opencode', allowed: [] }], [
        { name: 'openrouter', path: 'src/a.ts', reason: 'undeclared name' },
      ]);
      expect(runScript(root, []).status).toBe(2);

      writeList(root, [{ name: 'opencode', allowed: [] }], [
        { name: 'opencode', path: 'tests/a.ts', reason: 'outside the scanned roots' },
      ]);
      expect(runScript(root, []).status).toBe(2);

      writeList(root, [
        { name: 'opencode', allowed: [] },
        { name: 'opencode', allowed: [] },
      ]);
      expect(runScript(root, []).status).toBe(2);

      writeFileSync(list, JSON.stringify({ names: [], exceptions: [] }));
      expect(() => readList(list)).toThrow(/names/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('pins the required vendor names and their allowed places in the committed list', () => {
    const list = readList(listPath);
    const names = list.names.map((entry) => entry.name).sort();
    expect(names).toEqual(['docker.io', 'ghcr.io', 'opencode', 'openrouter', 'prime-agent', 'quay.io']);
    const allowed = (name: string): string[] =>
      list.names
        .find((entry) => entry.name === name)
        ?.allowed.map((place) => place.path)
        .sort() ?? [];
    expect(allowed('opencode')).toEqual([
      'loader/src/task-opencode.ts',
      'src/ports/task-harness-registry.json',
    ]);
    expect(allowed('prime-agent')).toEqual([
      'loader/src/task-prime-agent.ts',
      'src/ports/task-harness-registry.json',
    ]);
    for (const registry of ['docker.io', 'ghcr.io', 'quay.io'])
      expect(allowed(registry)).toEqual(['loader/src/workbench-source.ts']);
    expect(allowed('openrouter')).toEqual([]);
  });

  it('passes on this repository as it stands', () => {
    expect(checkTree({ root: repoRoot, listPath })).toMatchObject({
      violations: [],
      stale: [],
    });
  });
});

/** Run the committed script from a fixture tree that holds a copy of it. */
function runScript(root: string, args: string[]): { status: number | null; output: string } {
  const copy = join(root, 'scripts', 'check-vendor-names.mjs');
  cpSync(script, copy);
  const result = spawnSync(process.execPath, [copy, ...args], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
