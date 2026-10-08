/**
 * Tests for the CI path classifier (scripts/ci-product-paths.sh).
 *
 * The classifier answers whether a change owes the product checks. CI feeds it
 * the changed paths of a pull request or a push and skips ci-product on
 * "product=false", so a wrong answer either lets a broken tree through or
 * charges the checks for a change that cannot break anything. These tests run
 * the script itself, with the scenario lists of lifemodel-cup and the nested,
 * hook and script paths around them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/ci-product-paths.sh', import.meta.url));

interface Classification {
  /** Every line the script printed, in order. */
  lines: string[];
  /** Its last line: "product=true" or "product=false". */
  verdict: string;
  /** The paths it reported reading. */
  read: string[];
}

/** Reads the classifier's printed lines, whichever command produced them. */
function parse(stdout: string): Classification {
  const lines = stdout.split('\n').filter((line) => line !== '');
  return {
    lines,
    verdict: lines[lines.length - 1] ?? '',
    read: lines
      .filter((line) => line.startsWith('changed: '))
      .map((line) => line.slice('changed: '.length)),
  };
}

function classify(input: string): Classification {
  return parse(execFileSync('sh', [script], { input, encoding: 'utf8' }));
}

/** The input CI feeds it: git's path list, one path per line. */
function paths(...files: string[]): string {
  return files.map((file) => `${file}\n`).join('');
}

describe('scripts/ci-product-paths.sh', () => {
  const notProduct: Array<[string, string[]]> = [
    ['a document under docs/', ['docs/x.md']],
    ['markdown at the repository root', ['README.md']],
    ['the tracker export and a root document', ['.beads/issues.jsonl', 'AGENTS.md']],
    ['several documents', ['docs/architecture.md', 'AGENTS.md']],
    ['a document nested deeper', ['docs/features/x/design.md']],
    ['a file of the backlog gate', ['.backlog/rules/check.mjs']],
    ['a git hook', ['.githooks/pre-push']],
    ['the script that connects a clone', ['scripts/connect-clone.sh']],
    ['the tracker store itself', ['.beads/config.yaml']],
  ];

  const product: Array<[string, string[]]> = [
    ['source code', ['src/a.ts']],
    ['a document and a manifest', ['docs/x.md', 'package.json']],
    ['markdown inside the product', ['src/runtime/builtin-skills/s/SKILL.md']],
    ['the workflow that runs the checks', ['.github/workflows/ci.yml']],
    ['the classifier itself', ['scripts/ci-product-paths.sh']],
    ['the lockfile', ['package-lock.json']],
    ['a test', ['tests/x.test.ts']],
    ['a document beside the code it describes', ['src/x.md']],
    ['a product path among documents', ['README.md', 'docs/x.md', 'src/a.ts']],
  ];

  it.each(notProduct)('%s: no product checks', (_name, files) => {
    expect(classify(paths(...files)).verdict).toBe('product=false');
  });

  it.each(product)('%s: product checks owed', (_name, files) => {
    expect(classify(paths(...files)).verdict).toBe('product=true');
  });

  it('answers product for an empty diff: nothing changed is no evidence of safety', () => {
    const result = classify('');
    expect(result.verdict).toBe('product=true');
    expect(result.read).toEqual([]);
  });

  it('treats an empty line as no path rather than as a path', () => {
    expect(classify(paths('', 'src/a.ts')).read).toEqual(['src/a.ts']);
  });

  it('reads a last line without a trailing newline', () => {
    expect(classify('src/a.ts').verdict).toBe('product=true');
  });

  it('lists every path it read, before the verdict', () => {
    const result = classify(paths('.beads/issues.jsonl', 'AGENTS.md'));
    expect(result.read).toEqual(['.beads/issues.jsonl', 'AGENTS.md']);
    expect(result.lines).toEqual([
      'changed: .beads/issues.jsonl',
      'changed: AGENTS.md',
      'product=false',
    ]);
  });

  it('answers once, on its last line', () => {
    const result = classify(paths('src/a.ts', 'docs/x.md'));
    expect(result.lines.filter((line) => line.startsWith('product='))).toEqual(['product=true']);
    expect(result.verdict).toBe(result.lines[result.lines.length - 1]);
  });

  it('answers the same for the same paths in any order, twice', () => {
    const once = classify(paths('src/a.ts', 'docs/x.md'));
    const again = classify(paths('docs/x.md', 'src/a.ts'));
    expect(once.verdict).toBe('product=true');
    expect(again.verdict).toBe(once.verdict);
    expect(classify(paths('src/a.ts')).lines).toEqual(classify(paths('src/a.ts')).lines);
  });
});

/** CI's two commands around the classifier: the change's paths, and the verdict. */
const changedPaths = fileURLToPath(new URL('../../scripts/ci-changed-paths.sh', import.meta.url));
const verdictOf = fileURLToPath(new URL('../../scripts/ci-verdict.sh', import.meta.url));

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function put(root: string, file: string, content = 'export const a = 1;\n'): void {
  mkdirSync(join(root, dirname(file)), { recursive: true });
  writeFileSync(join(root, file), content);
}

/** `git mv` writes into an existing directory only. */
function mkdir(root: string, ...dirs: string[]): void {
  for (const dir of dirs) {
    mkdirSync(join(root, dir), { recursive: true });
  }
}

/** A throwaway repository; two commits are enough for one change's range. */
function makeRepo(): { dir: string; commit: (message: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'lifemodel-ci-paths-'));
  mkdirSync(join(dir, 'empty-hooks'));
  git(dir, 'init', '--quiet');
  // The machine's global hooks path is this repository's .githooks, which
  // refuses a commit without a task link: point the throwaway repository at an
  // empty hooks directory instead.
  git(dir, 'config', 'core.hooksPath', join(dir, 'empty-hooks'));
  git(dir, 'config', 'user.email', 'ci-paths-test@example.com');
  git(dir, 'config', 'user.name', 'ci paths test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return {
    dir,
    commit(message: string): string {
      git(dir, 'add', '--all');
      git(dir, 'commit', '--quiet', '--message', message);
      return git(dir, 'rev-parse', 'HEAD').trim();
    },
  };
}

/**
 * The change CI actually reads: the same script the `changes` job calls, run
 * in the repository that made the change, for the same range form.
 */
function classifyRange(dir: string, range: string): Classification {
  return parse(execFileSync('sh', [changedPaths, range], { cwd: dir, encoding: 'utf8' }));
}

describe('scripts/ci-changed-paths.sh: the paths CI reads', () => {
  let repo: { dir: string; commit: (message: string) => string };

  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    rmSync(repo.dir, { recursive: true, force: true });
  });

  it('counts a move of product code into the documents as product', () => {
    put(repo.dir, 'src/a.ts');
    const before = repo.commit('add product code');
    mkdir(repo.dir, 'docs');
    git(repo.dir, 'mv', 'src/a.ts', 'docs/a.ts');
    const after = repo.commit('move the code into the documents');

    const result = classifyRange(repo.dir, `${before}..${after}`);
    // Both sides of the move: the destination is a document, the source is a
    // deletion in product code that can break what imports it.
    expect([...result.read].sort()).toEqual(['docs/a.ts', 'src/a.ts']);
    expect(result.verdict).toBe('product=true');
  });

  it('reads a pull request range, merge base to head, the same way', () => {
    put(repo.dir, 'src/a.ts');
    const base = repo.commit('base');
    put(repo.dir, 'src/meanwhile.ts');
    const elsewhere = repo.commit('main moves on');
    git(repo.dir, 'reset', '--hard', base);
    mkdir(repo.dir, 'docs');
    git(repo.dir, 'mv', 'src/a.ts', 'docs/a.ts');
    const head = repo.commit('move the code into the documents');

    const mergeBase = git(repo.dir, 'merge-base', elsewhere, head).trim();
    expect(mergeBase).toBe(base);
    const result = classifyRange(repo.dir, `${mergeBase}...${head}`);
    expect([...result.read].sort()).toEqual(['docs/a.ts', 'src/a.ts']);
    expect(result.verdict).toBe('product=true');
  });

  it('counts a move of documents into the product as product', () => {
    put(repo.dir, 'docs/a.md', '# a\n');
    const before = repo.commit('add a document');
    mkdir(repo.dir, 'src');
    git(repo.dir, 'mv', 'docs/a.md', 'src/a.md');
    const after = repo.commit('move the document into the product');

    expect(classifyRange(repo.dir, `${before}..${after}`).verdict).toBe('product=true');
  });

  it('still answers no for a move inside the documents', () => {
    put(repo.dir, 'docs/a.md', '# a\n');
    const before = repo.commit('add a document');
    git(repo.dir, 'mv', 'docs/a.md', 'docs/b.md');
    const after = repo.commit('move the document');

    expect(classifyRange(repo.dir, `${before}..${after}`).verdict).toBe('product=false');
  });

  it('counts a rewritten path as product, not as a rename it follows', () => {
    put(repo.dir, 'src/a.ts');
    const before = repo.commit('add product code');
    git(repo.dir, 'rm', '--quiet', 'src/a.ts');
    put(repo.dir, 'docs/a.ts', 'export const a = 2;\n');
    const after = repo.commit('replace it with a document');

    expect(classifyRange(repo.dir, `${before}..${after}`).verdict).toBe('product=true');
  });

  it('fails on a range it cannot read instead of answering', () => {
    put(repo.dir, 'src/a.ts');
    repo.commit('add product code');

    expect(() => classifyRange(repo.dir, 'not-a-range..HEAD')).toThrow();
  });

  it('refuses to be called without exactly one range', () => {
    expect(() => execFileSync('sh', [changedPaths], { cwd: repo.dir })).toThrow();
  });
});

describe('scripts/ci-verdict.sh: the answer, or a clear failure', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lifemodel-ci-verdict-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(content: string): string {
    const file = join(dir, 'classification.txt');
    writeFileSync(file, content);
    return execFileSync('sh', [verdictOf, file], { encoding: 'utf8' });
  }

  function failure(content: string): string {
    const file = join(dir, 'classification.txt');
    writeFileSync(file, content);
    try {
      execFileSync('sh', [verdictOf, file], { encoding: 'utf8' });
    } catch (error) {
      return String((error as { stderr?: string }).stderr ?? error);
    }
    throw new Error(`the verdict script accepted ${JSON.stringify(content)}`);
  }

  it('prints the verdict of a classification, and nothing else', () => {
    expect(run('changed: src/a.ts\nproduct=true\n')).toBe('product=true\n');
    expect(run('changed: docs/x.md\nproduct=false\n')).toBe('product=false\n');
  });

  it('fails when the classifier printed nothing', () => {
    expect(failure('')).toMatch(/printed nothing/);
  });

  it('fails when nothing it printed is a verdict', () => {
    expect(failure('changed: src/a.ts\n')).toMatch(/no verdict/);
    expect(failure('changed: docs/x.md\ntrue\n')).toMatch(/no verdict/);
  });

  it('fails when a verdict is not the last line', () => {
    expect(failure('product=true\nchanged: src/a.ts\n')).toMatch(/last line/);
  });

  it('fails when the last line is not exactly a verdict', () => {
    expect(failure('changed: src/a.ts\nproduct=TRUE\n')).toMatch(/last line/);
    expect(failure('changed: src/a.ts\nproduct= yes\n')).toMatch(/last line/);
  });

  it('fails when more than one verdict was printed', () => {
    expect(failure('product=true\nproduct=false\n')).toMatch(/2 verdict lines/);
    expect(failure('product=true\nchanged: src/a.ts\nproduct=true\n')).toMatch(/2 verdict lines/);
  });

  it('fails when there is no classification file to read', () => {
    expect(() =>
      execFileSync('sh', [verdictOf, join(dir, 'absent.txt')], { encoding: 'utf8' })
    ).toThrow();
  });

  it('refuses to be called without exactly one file', () => {
    expect(() => execFileSync('sh', [verdictOf], { encoding: 'utf8' })).toThrow();
  });
});
