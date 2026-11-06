/**
 * Tests for the repeat selector (scripts/ci-repeat-test-paths.sh).
 *
 * The selector reads one change's paths on stdin NUL-delimited, exactly as
 * `git diff -z --name-only` prints them, and prints the test files the repeat
 * mode runs NUL-delimited: added or changed files under tests/ that still
 * exist. A helper, a fixture or a deleted test repeats nothing. CI runs the
 * repeat mode only when this list is non-empty, so a wrong answer either
 * repeats files that did not change or leaves a new test unrepeated. It reads
 * nothing but its stdin and the working tree, and the same input always
 * prints the same, sorted list. NUL delimiters keep every byte of a name:
 * a space, a tab or a quote needs no quoting and cannot split a path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/ci-repeat-test-paths.sh', import.meta.url));

interface Selection {
  /** The exit status of the selector. */
  status: number | null;
  /** The paths it printed, NUL-delimited, as CI passes them to the launcher. */
  files: string[];
  /** What it said on stderr, where an empty selection is explained. */
  note: string;
}

describe('scripts/ci-repeat-test-paths.sh', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lifemodel-repeat-paths-'));
    // The tree a change left behind: the files that exist after it applied.
    for (const file of [
      'tests/unit/added.test.ts',
      'tests/integration/changed.test.ts',
      'tests/integration/deep/nested.test.ts',
      'tests/unit/helpers/stores.ts',
      'tests/fixtures/payload.json',
      'tests/unit/notes.md',
      'src/outside.test.ts',
    ]) {
      mkdirSync(join(dir, dirname(file)), { recursive: true });
      writeFileSync(join(dir, file), 'export const a = 1;\n');
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function select(input: string, args: string[] = []): Selection {
    const result = spawnSync('bash', [script, ...args], { cwd: dir, input, encoding: 'utf8' });
    return {
      status: result.status,
      files: result.stdout.split('\u0000').filter((file) => file !== ''),
      note: result.stderr,
    };
  }

  /** The input CI feeds it: git's NUL-delimited path list. */
  function paths(...files: string[]): string {
    return files.map((file) => `${file}\u0000`).join('');
  }

  it('prints an added test file', () => {
    expect(select(paths('tests/unit/added.test.ts')).files).toEqual(['tests/unit/added.test.ts']);
  });

  it('prints a changed test file', () => {
    expect(select(paths('tests/integration/changed.test.ts')).files).toEqual([
      'tests/integration/changed.test.ts',
    ]);
  });

  it('prints a test file nested at any depth', () => {
    expect(select(paths('tests/integration/deep/nested.test.ts')).files).toEqual([
      'tests/integration/deep/nested.test.ts',
    ]);
  });

  it('repeats nothing for a deleted test file: there is no file to repeat', () => {
    const result = select(paths('tests/unit/deleted.test.ts'));
    expect(result.status).toBe(0);
    expect(result.files).toEqual([]);
    expect(result.note).toMatch(/no added or changed test file/);
  });

  it('repeats nothing for a helper change', () => {
    const result = select(paths('tests/unit/helpers/stores.ts'));
    expect(result.files).toEqual([]);
    expect(result.note).toMatch(/no added or changed test file/);
  });

  it('repeats nothing for a fixture change', () => {
    const result = select(paths('tests/fixtures/payload.json'));
    expect(result.files).toEqual([]);
    expect(result.note).toMatch(/no added or changed test file/);
  });

  it('repeats nothing for a file under tests/ that is not a test file', () => {
    expect(select(paths('tests/unit/notes.md')).files).toEqual([]);
  });

  it('repeats nothing for a test file outside tests/', () => {
    // A test file the suite discovers elsewhere is the whole suite's business,
    // not this selector's: its pattern is tests/**/*.test.ts.
    expect(select(paths('src/outside.test.ts')).files).toEqual([]);
  });

  it('prints the test files among other changed paths, sorted and once each', () => {
    const result = select(
      paths(
        'tests/unit/added.test.ts',
        'docs/x.md',
        'tests/integration/changed.test.ts',
        'tests/unit/added.test.ts',
        'tests/integration/deep/nested.test.ts',
        'src/a.ts'
      )
    );
    expect(result.files).toEqual([
      'tests/integration/changed.test.ts',
      'tests/integration/deep/nested.test.ts',
      'tests/unit/added.test.ts',
    ]);
  });

  it('prints nothing and says so when there is no input at all', () => {
    const result = select('');
    expect(result.status).toBe(0);
    expect(result.files).toEqual([]);
    expect(result.note).toMatch(/no added or changed test file/);
  });

  it('answers the same for the same paths in any order, twice', () => {
    const once = select(paths('tests/unit/added.test.ts', 'tests/integration/changed.test.ts'));
    const again = select(paths('tests/integration/changed.test.ts', 'tests/unit/added.test.ts'));
    expect(once.files).toEqual(again.files);
    expect(select(paths('tests/unit/added.test.ts')).files).toEqual(
      select(paths('tests/unit/added.test.ts')).files
    );
  });

  it('treats an empty path as no path rather than as a path', () => {
    expect(select(paths('', 'tests/unit/added.test.ts', '')).files).toEqual([
      'tests/unit/added.test.ts',
    ]);
  });

  it('reads a last path without a trailing NUL', () => {
    expect(select('tests/unit/added.test.ts').files).toEqual(['tests/unit/added.test.ts']);
  });

  it('keeps a space, a tab and a quote in a test file name byte for byte', () => {
    for (const file of [
      'tests/unit/with space.test.ts',
      'tests/unit/tab\tname.test.ts',
      "tests/unit/quote'name.test.ts",
    ]) {
      mkdirSync(join(dir, dirname(file)), { recursive: true });
      writeFileSync(join(dir, file), 'export const a = 1;\n');
    }
    expect(
      select(
        paths(
          'tests/unit/with space.test.ts',
          'tests/unit/tab\tname.test.ts',
          "tests/unit/quote'name.test.ts"
        )
      ).files
    ).toEqual([
      "tests/unit/quote'name.test.ts",
      'tests/unit/tab\tname.test.ts',
      'tests/unit/with space.test.ts',
    ]);
  });

  it('refuses arguments: the change is read from stdin alone', () => {
    const result = select('', ['tests/unit/added.test.ts']);
    expect(result.status).toBe(2);
    expect(result.files).toEqual([]);
    expect(result.note).toMatch(/stdin/);
  });
});
