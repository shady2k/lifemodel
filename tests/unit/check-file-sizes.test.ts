import { describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyUpdate,
  bootstrapBaseline,
  checkTree,
  countLines,
  LIMIT,
  planUpdate,
  scanTree,
} from '../../scripts/check-file-sizes.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const script = fileURLToPath(new URL('../../scripts/check-file-sizes.mjs', import.meta.url));
const UPDATE_COMMAND = 'npm run check:file-sizes:update';

/** A tree with all four source roots and a scripts directory for the baseline. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'file-sizes-'));
  for (const dir of ['src', 'loader', 'web', 'tests', 'scripts']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  return root;
}

function writeLines(root: string, relative: string, count: number): void {
  const target = join(root, relative);
  mkdirSync(join(target, '..'), { recursive: true });
  const lines = Array.from({ length: count }, (_, index) => `line ${index + 1}`);
  writeFileSync(target, lines.join('\n') + (lines.length ? '\n' : ''));
}

function writeBaseline(root: string, files: Record<string, number>): string {
  const target = join(root, 'scripts', 'file-size-baseline.json');
  writeFileSync(target, JSON.stringify({ files }, null, 2) + '\n');
  return target;
}

function readBaselineFile(root: string): { files: Record<string, number> } {
  return JSON.parse(readFileSync(join(root, 'scripts', 'file-size-baseline.json'), 'utf8'));
}

describe('the file-size ratchet (lifemodel-5zoc)', () => {
  it('fails a new file over the 800-line limit and accepts one exactly at it', () => {
    const root = fixture();
    try {
      writeBaseline(root, {});
      writeLines(root, 'src/new-feature.ts', 801);
      const rejected = checkTree({
        root,
        baselinePath: join(root, 'scripts', 'file-size-baseline.json'),
      });
      expect(rejected.failures).toEqual([
        { path: 'src/new-feature.ts', count: 801, reason: 'new' },
      ]);

      rmSync(join(root, 'src', 'new-feature.ts'));
      writeLines(root, 'src/new-feature.ts', 800);
      expect(
        checkTree({ root, baselinePath: join(root, 'scripts', 'file-size-baseline.json') }).failures
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails a listed file that grew past its recorded count', () => {
    const root = fixture();
    try {
      const baselinePath = writeBaseline(root, { 'src/grown.ts': 900 });
      writeLines(root, 'src/grown.ts', 901);
      expect(checkTree({ root, baselinePath }).failures).toEqual([
        { path: 'src/grown.ts', count: 901, recorded: 900, reason: 'grown' },
      ]);
      writeLines(root, 'src/grown.ts', 900);
      expect(checkTree({ root, baselinePath }).failures).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails a listed file that shrank, and names the exact command that records it', () => {
    const root = fixture();
    try {
      const baselinePath = writeBaseline(root, { 'tests/shrunk.test.ts': 900 });
      writeLines(root, 'tests/shrunk.test.ts', 850);
      expect(checkTree({ root, baselinePath }).failures).toEqual([
        { path: 'tests/shrunk.test.ts', count: 850, recorded: 900, reason: 'shrunk' },
      ]);
      const run = runScript(root, []);
      expect(run.status).toBe(1);
      expect(run.output).toContain('tests/shrunk.test.ts');
      expect(run.output).toContain('850');
      expect(run.output).toContain(UPDATE_COMMAND);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails an entry that fell under the limit and an entry whose file is gone', () => {
    const root = fixture();
    try {
      const baselinePath = writeBaseline(root, {
        'src/now-small.ts': 900,
        'web/app/removed.ts': 1000,
      });
      writeLines(root, 'src/now-small.ts', 700);
      expect(checkTree({ root, baselinePath }).failures).toEqual([
        {
          path: 'src/now-small.ts',
          count: 700,
          recorded: 900,
          reason: 'within-limit',
        },
        { path: 'web/app/removed.ts', recorded: 1000, reason: 'missing' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes a tree that matches its baseline in every root', () => {
    const root = fixture();
    try {
      const baselinePath = writeBaseline(root, {
        'loader/src/http.ts': 900,
        'src/core/core-loop.ts': 3057,
        'tests/unit/big.test.ts': 1200,
        'web/loader/src/App.tsx': 900,
      });
      writeLines(root, 'loader/src/http.ts', 900);
      writeLines(root, 'src/core/core-loop.ts', 3057);
      writeLines(root, 'tests/unit/big.test.ts', 1200);
      writeLines(root, 'web/loader/src/App.tsx', 900);
      expect(checkTree({ root, baselinePath }).failures).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts logical lines, not a phantom line after the final newline', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('one\n')).toBe(1);
    expect(countLines('one\ntwo')).toBe(2);
    expect(countLines('one\ntwo\n')).toBe(2);
  });

  it('walks source and markup, sees source under coverage and data, and skips only real generated output', () => {
    const root = fixture();
    try {
      const baselinePath = writeBaseline(root, {});
      writeLines(root, 'tests/fixtures/data.json', 2000);
      writeLines(root, 'web/app/notes.md', 2000);
      writeLines(root, 'src/node_modules/vendored.ts', 2000);
      writeLines(root, 'loader/dist/generated.ts', 2000);
      writeLines(root, 'web/app/dist/generated.ts', 2000);
      writeLines(root, 'web/loader/dist/generated.ts', 2000);
      writeLines(root, 'coverage/report.html', 2000);
      writeLines(root, 'scripts/tool.mjs', 2000);
      // A source directory named coverage or data is source: the ratchet must
      // see it (lifemodel-5zoc review F2).
      writeLines(root, 'src/coverage/report.html', 2000);
      writeLines(root, 'src/data/state.ts', 2000);
      const counts = scanTree(root);
      expect([...counts.keys()]).toEqual(['src/coverage/report.html', 'src/data/state.ts']);
      expect(checkTree({ root, baselinePath }).failures).toEqual([
        { path: 'src/coverage/report.html', count: 2000, reason: 'new' },
        { path: 'src/data/state.ts', count: 2000, reason: 'new' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not fail on untracked generated output at the exact places the build writes it', () => {
    const root = fixture();
    try {
      const baselinePath = writeBaseline(root, {});
      // An owner's checkout holds these after a build; they are generated,
      // untracked, and over the limit, and the check must not judge them.
      writeLines(root, 'loader/dist/bundle.ts', 2000);
      writeLines(root, 'web/app/dist/bundle.ts', 2000);
      writeLines(root, 'web/loader/dist/bundle.ts', 2000);
      expect(scanTree(root).size).toBe(0);
      expect(checkTree({ root, baselinePath }).failures).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats a missing baseline, an unreadable baseline and a missing source tree as errors', () => {
    const root = fixture();
    try {
      const missingBaseline = join(root, 'scripts', 'file-size-baseline.json');
      expect(() => checkTree({ root, baselinePath: missingBaseline })).toThrow(/baseline/i);

      writeFileSync(missingBaseline, 'not json\n');
      expect(() => checkTree({ root, baselinePath: missingBaseline })).toThrow(/baseline/i);

      writeBaseline(root, {});
      rmSync(join(root, 'web'), { recursive: true });
      expect(() =>
        checkTree({ root, baselinePath: join(root, 'scripts', 'file-size-baseline.json') })
      ).toThrow(/web/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lowers counts and removes entries, and the check passes afterwards', () => {
    const root = fixture();
    try {
      const baselinePath = writeBaseline(root, {
        'src/lowered.ts': 900,
        'src/removed-by-limit.ts': 850,
        'src/removed-because-gone.ts': 1200,
      });
      writeLines(root, 'src/lowered.ts', 860);
      writeLines(root, 'src/removed-by-limit.ts', 800);
      const plan = planUpdate({ root, baselinePath });
      expect(plan.blocking).toEqual([]);
      expect(plan.changes).toEqual([
        { path: 'src/lowered.ts', count: 860, recorded: 900, reason: 'lowered' },
        { path: 'src/removed-because-gone.ts', recorded: 1200, reason: 'missing' },
        { path: 'src/removed-by-limit.ts', recorded: 850, reason: 'within-limit' },
      ]);
      applyUpdate({ root, baselinePath });
      expect(readBaselineFile(root)).toEqual({ files: { 'src/lowered.ts': 860 } });
      expect(checkTree({ root, baselinePath }).failures).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to raise a count or add a file, leaving the baseline untouched', () => {
    const root = fixture();
    try {
      const baselinePath = writeBaseline(root, { 'src/grown.ts': 900 });
      const before = readFileSync(baselinePath, 'utf8');
      writeLines(root, 'src/grown.ts', 901);
      expect(planUpdate({ root, baselinePath }).blocking).toEqual([
        { path: 'src/grown.ts', count: 901, recorded: 900, reason: 'grown' },
      ]);
      expect(() => applyUpdate({ root, baselinePath })).toThrow(/901/);
      expect(readFileSync(baselinePath, 'utf8')).toBe(before);

      writeLines(root, 'src/grown.ts', 900);
      writeLines(root, 'src/another-big.ts', 900);
      expect(planUpdate({ root, baselinePath }).blocking).toEqual([
        { path: 'src/another-big.ts', count: 900, reason: 'new' },
      ]);
      expect(() => applyUpdate({ root, baselinePath })).toThrow(/split|new/i);
      expect(readFileSync(baselinePath, 'utf8')).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes a sorted baseline with a trailing newline and bootstraps only once', () => {
    const root = fixture();
    try {
      const baselinePath = join(root, 'scripts', 'file-size-baseline.json');
      writeLines(root, 'tests/z.test.ts', 1000);
      writeLines(root, 'src/a.ts', 900);
      writeLines(root, 'src/b.ts', 800);
      bootstrapBaseline({ root, baselinePath });
      expect(readFileSync(baselinePath, 'utf8')).toBe(
        '{\n  "files": {\n    "src/a.ts": 900,\n    "tests/z.test.ts": 1000\n  }\n}\n'
      );
      expect(() => bootstrapBaseline({ root, baselinePath })).toThrow(/already exists/i);
      expect(readFileSync(baselinePath, 'utf8')).toContain('"src/a.ts": 900');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs as a command: wall of output on failure, then update, then a pass', () => {
    const root = fixture();
    try {
      writeBaseline(root, { 'src/shrinks.ts': 900 });
      writeLines(root, 'src/shrinks.ts', 850);
      writeLines(root, 'src/new-file.ts', 900);
      const failed = runScript(root, []);
      expect(failed.status).toBe(1);
      expect(failed.output).toContain('src/new-file.ts');
      expect(failed.output).toContain('900');
      expect(failed.output).toContain(String(LIMIT));
      expect(failed.output).toContain(UPDATE_COMMAND);

      const refused = runScript(root, ['--update']);
      expect(refused.status).toBe(1);
      expect(refused.output).toContain('src/new-file.ts');
      expect(readBaselineFile(root)).toEqual({ files: { 'src/shrinks.ts': 900 } });

      rmSync(join(root, 'src', 'new-file.ts'));
      const updated = runScript(root, ['--update']);
      expect(updated.status).toBe(0);
      expect(readBaselineFile(root)).toEqual({ files: { 'src/shrinks.ts': 850 } });
      expect(runScript(root, []).status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes on this repository as it stands', () => {
    expect(
      checkTree({ root: repoRoot, baselinePath: join(repoRoot, 'scripts', 'file-size-baseline.json') })
        .failures
    ).toEqual([]);
  });
});

/** Run the committed script from a fixture tree that holds a copy of it. */
function runScript(root: string, args: string[]): { status: number | null; output: string } {
  const copy = join(root, 'scripts', 'check-file-sizes.mjs');
  cpSync(script, copy);
  const result = spawnSync(process.execPath, [copy, ...args], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
