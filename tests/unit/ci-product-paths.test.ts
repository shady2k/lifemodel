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

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../scripts/ci-product-paths.sh', import.meta.url)
);

interface Classification {
  /** Every line the script printed, in order. */
  lines: string[];
  /** Its last line: "product=true" or "product=false". */
  verdict: string;
  /** The paths it reported reading. */
  read: string[];
}

function classify(input: string): Classification {
  const stdout = execFileSync('sh', [script], { input, encoding: 'utf8' });
  const lines = stdout.split('\n').filter((line) => line !== '');
  return {
    lines,
    verdict: lines[lines.length - 1],
    read: lines
      .filter((line) => line.startsWith('changed: '))
      .map((line) => line.slice('changed: '.length)),
  };
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
    expect(result.lines.filter((line) => line.startsWith('product='))).toEqual([
      'product=true',
    ]);
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
