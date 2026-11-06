#!/usr/bin/env node
/**
 * File-size ratchet (lifemodel-5zoc).
 *
 * A file that is already over the limit may shrink, but it may not grow, and no
 * new file may start over it. The baseline lists every counted file over the
 * limit with its current line count. The check fails when a listed file's count
 * differs in either direction, when a listed file is gone, when a listed file
 * is no longer over the limit, or when a new file is over it. Every one of
 * those needs a person: the baseline is committed, and CI cannot write to a
 * branch. `--update` only lowers counts and removes entries, so the list can
 * only shrink.
 *
 * No dependencies, no clock, no network: the same tree and baseline always
 * produce the same failures, sorted by path.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIMIT = 800;
export const UPDATE_COMMAND = 'npm run check:file-sizes:update';
const BASELINE_NAME = 'file-size-baseline.json';

/** The trees this ratchet holds: product, loader, web applications, tests. */
export const SOURCE_ROOTS = ['src', 'loader', 'web', 'tests'];

/**
 * Counted: source and test code, and the web applications' markup and styles.
 * Data, configuration and prose (.json, .yaml, .md, images) are not counted:
 * their length is not a signal about a file growing past what one file holds,
 * and the baseline itself is such a file.
 */
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.html',
]);

/**
 * Generated output, skipped only at the exact places this repository writes
 * it, and installed dependencies:
 * - node_modules, wherever it appears: installed dependencies, vendored and
 *   not this repository's source. Vite's cache is node_modules/.vite, so it
 *   is inside this directory too.
 * - dist/ and coverage/ at the tree root: `tsc` (package.json "build") writes
 *   dist/, and Vitest's coverage run writes coverage/ (vitest.config.ts).
 * - loader/dist/: `tsc -p loader/tsconfig.json` (package.json "build:loader").
 * - web/app/dist/ and web/loader/dist/: the two Vite builds (package.json
 *   "build:app" and "build:loader-ui", both outDir "dist" from their config).
 *
 * A directory with one of these names anywhere else is source and is counted:
 * `src/coverage/report.html` and `src/data/state.ts` are files a change adds.
 */
const GENERATED_DIRECTORIES = new Set([
  'dist',
  'coverage',
  'loader/dist',
  'web/app/dist',
  'web/loader/dist',
]);

export function countLines(text) {
  if (text === '') return 0;
  const newlines = text.split('\n').length - 1;
  return text.endsWith('\n') ? newlines : newlines + 1;
}

function isSourcePath(relative) {
  return (
    typeof relative === 'string' &&
    relative !== '' &&
    !relative.startsWith('/') &&
    !relative.includes('\\') &&
    !relative.split('/').includes('..') &&
    !relative.split('/').includes('.') &&
    SOURCE_ROOTS.some((root) => relative.startsWith(`${root}/`)) &&
    SOURCE_EXTENSIONS.has(path.posix.extname(relative))
  );
}

/**
 * Every counted file under the four source roots, as a Map sorted by path.
 * A missing source root is an error: a tree that silently lost a directory
 * would silently lose its ratchet.
 */
export function scanTree(root) {
  const counts = new Map();
  function walk(directory, relativeDirectory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      // A symlink is neither a directory nor a file here: it is not a file this tree owns.
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || GENERATED_DIRECTORIES.has(relative)) continue;
        walk(path.join(directory, entry.name), relative);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        counts.set(relative, countLines(readFileSync(path.join(directory, entry.name), 'utf8')));
      }
    }
  }
  for (const relative of SOURCE_ROOTS) {
    const directory = path.join(root, relative);
    let stat;
    try {
      stat = statSync(directory);
    } catch (error) {
      throw new Error(`The source tree ${relative}/ is missing at ${directory}: ${error.message}`);
    }
    if (!stat.isDirectory()) throw new Error(`The source tree ${relative}/ is not a directory`);
    walk(directory, relative);
  }
  return new Map([...counts].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

/** The committed baseline's `files` map. Missing or unreadable is an error, never a pass. */
export function readBaseline(baselinePath) {
  let text;
  try {
    text = readFileSync(baselinePath, 'utf8');
  } catch (error) {
    throw new Error(
      `The file-size baseline at ${baselinePath} cannot be read: ${error.message}. ` +
        'It is a required input; a missing baseline is never a pass.'
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `The file-size baseline at ${baselinePath} is not valid JSON: ${error.message}`
    );
  }
  const files = parsed?.files;
  if (files === null || typeof files !== 'object' || Array.isArray(files)) {
    throw new Error(
      `The file-size baseline at ${baselinePath} must be an object with a "files" map of path to line count`
    );
  }
  for (const [relative, count] of Object.entries(files)) {
    if (!isSourcePath(relative)) {
      throw new Error(
        `The file-size baseline at ${baselinePath} names ${relative}, which is not a counted source path`
      );
    }
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(
        `The file-size baseline at ${baselinePath} records ${relative} as ${String(count)} lines; a line count is a positive integer`
      );
    }
  }
  return files;
}

const byPath = (left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

export function checkTree({ root, baselinePath }) {
  const baseline = readBaseline(baselinePath);
  const counts = scanTree(root);
  const failures = [];
  for (const [relative, recorded] of Object.entries(baseline)) {
    const count = counts.get(relative);
    if (count === undefined) failures.push({ path: relative, recorded, reason: 'missing' });
    else if (count > recorded) failures.push({ path: relative, count, recorded, reason: 'grown' });
    else if (count <= LIMIT) failures.push({ path: relative, count, recorded, reason: 'within-limit' });
    else if (count < recorded) failures.push({ path: relative, count, recorded, reason: 'shrunk' });
  }
  for (const [relative, count] of counts) {
    if (!Object.hasOwn(baseline, relative) && count > LIMIT) {
      failures.push({ path: relative, count, reason: 'new' });
    }
  }
  failures.sort(byPath);
  return { checked: counts.size, failures };
}

function formatFailure(failure) {
  switch (failure.reason) {
    case 'new':
      return `${failure.path}: ${failure.count} lines, over the ${LIMIT}-line limit; a new file may not start above it and the baseline only shrinks. Split it.`;
    case 'grown':
      return `${failure.path}: ${failure.count} lines, above its recorded ${failure.recorded} (limit ${LIMIT}); split it or take it back under ${failure.recorded}.`;
    case 'shrunk':
      return `${failure.path}: ${failure.count} lines, below its recorded ${failure.recorded}; record the smaller size with \`${UPDATE_COMMAND}\`.`;
    case 'within-limit':
      return `${failure.path}: ${failure.count} lines, at or under the ${LIMIT}-line limit but still listed in the baseline; remove its entry with \`${UPDATE_COMMAND}\`.`;
    case 'missing':
      return `${failure.path}: recorded at ${failure.recorded} lines but the file is gone; remove its entry with \`${UPDATE_COMMAND}\`.`;
    default:
      throw new Error(`Unknown file-size failure reason ${String(failure.reason)}`);
  }
}

function formatBlocking(blocking) {
  return blocking
    .map((failure) =>
      failure.reason === 'new'
        ? `${failure.path}: ${failure.count} lines, over the ${LIMIT}-line limit; the update never adds a file, so split it.`
        : `${failure.path}: ${failure.count} lines, above its recorded ${failure.recorded} (limit ${LIMIT}); the update only lowers counts, so split it or take it back under ${failure.recorded}.`
    )
    .join('\n');
}

/** What `--update` would do. `blocking` is never cleared by an update: it only shrinks. */
export function planUpdate({ root, baselinePath }) {
  const baseline = readBaseline(baselinePath);
  const counts = scanTree(root);
  const blocking = [];
  for (const [relative, recorded] of Object.entries(baseline)) {
    const count = counts.get(relative);
    if (count !== undefined && count > recorded) {
      blocking.push({ path: relative, count, recorded, reason: 'grown' });
    }
  }
  for (const [relative, count] of counts) {
    if (!Object.hasOwn(baseline, relative) && count > LIMIT) {
      blocking.push({ path: relative, count, reason: 'new' });
    }
  }
  blocking.sort(byPath);
  const next = {};
  const changes = [];
  for (const relative of Object.keys(baseline).sort()) {
    const recorded = baseline[relative];
    const count = counts.get(relative);
    if (count === undefined) {
      changes.push({ path: relative, recorded, reason: 'missing' });
    } else if (count <= LIMIT) {
      changes.push({ path: relative, recorded, reason: 'within-limit' });
    } else if (count < recorded) {
      next[relative] = count;
      changes.push({ path: relative, count, recorded, reason: 'lowered' });
    } else {
      next[relative] = recorded;
    }
  }
  return { blocking, changes, next };
}

function serializeBaseline(files) {
  const sorted = {};
  for (const relative of Object.keys(files).sort()) sorted[relative] = files[relative];
  return `${JSON.stringify({ files: sorted }, null, 2)}\n`;
}

export function applyUpdate({ root, baselinePath }) {
  const plan = planUpdate({ root, baselinePath });
  if (plan.blocking.length) {
    throw new Error(
      `Cannot update the file-size baseline; it only lowers counts and removes entries:\n${formatBlocking(plan.blocking)}`
    );
  }
  if (plan.changes.length) writeFileSync(baselinePath, serializeBaseline(plan.next));
  return plan;
}

/**
 * One-time creation of the baseline from the current tree. It refuses to run
 * over an existing baseline: after this, only `--update` may change the list,
 * and only downward.
 */
export function bootstrapBaseline({ root, baselinePath }) {
  if (existsSync(baselinePath)) {
    throw new Error(
      `The file-size baseline at ${baselinePath} already exists; use \`${UPDATE_COMMAND}\` to lower counts and remove entries.`
    );
  }
  const files = {};
  for (const [relative, count] of scanTree(root)) if (count > LIMIT) files[relative] = count;
  writeFileSync(baselinePath, serializeBaseline(files));
  return { files };
}

function formatChange(change) {
  switch (change.reason) {
    case 'lowered':
      return `lowered ${change.path}: ${change.recorded} -> ${change.count} lines`;
    case 'within-limit':
      return `removed ${change.path}: now at or under the ${LIMIT}-line limit`;
    case 'missing':
      return `removed ${change.path}: the file is gone`;
    default:
      throw new Error(`Unknown file-size change reason ${String(change.reason)}`);
  }
}

export function run(args, options = {}) {
  const scriptPath = fileURLToPath(import.meta.url);
  const root = options.root ?? path.resolve(path.dirname(scriptPath), '..');
  const baselinePath = options.baselinePath ?? path.join(path.dirname(scriptPath), BASELINE_NAME);
  try {
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
      console.log(
        'Usage: node scripts/check-file-sizes.mjs [--update|--bootstrap]\n' +
          `  no option   fail when any counted file grew past its recorded size or the ${LIMIT}-line limit\n` +
          '  --update    lower counts and remove entries in the baseline (never raise or add)\n' +
          '  --bootstrap create the baseline once, from the current tree'
      );
      return 0;
    }
    if (args.length > 1 || (args.length === 1 && !['--update', '--bootstrap'].includes(args[0]))) {
      console.error('Usage: node scripts/check-file-sizes.mjs [--update|--bootstrap]');
      return 2;
    }
    const mode = args[0] ?? 'check';
    if (mode === '--bootstrap') {
      const { files } = bootstrapBaseline({ root, baselinePath });
      console.log(`Created ${baselinePath} with ${Object.keys(files).length} entries.`);
      return 0;
    }
    if (mode === '--update') {
      const plan = planUpdate({ root, baselinePath });
      if (plan.blocking.length) {
        console.error(
          `File-size baseline not updated; it only lowers counts and removes entries:\n${formatBlocking(plan.blocking)}`
        );
        return 1;
      }
      if (!plan.changes.length) {
        console.log('File-size baseline is up to date.');
        return 0;
      }
      applyUpdate({ root, baselinePath });
      for (const change of plan.changes) console.log(formatChange(change));
      return 0;
    }
    const { checked, failures } = checkTree({ root, baselinePath });
    if (!failures.length) {
      console.log(`File-size ratchet: ${checked} files checked, none over the ${LIMIT}-line limit.`);
      return 0;
    }
    console.error(
      `${failures.length} file-size failure${failures.length === 1 ? '' : 's'} (limit ${LIMIT} lines):\n` +
        failures.map((failure) => `  ${formatFailure(failure)}`).join('\n')
    );
    return 1;
  } catch (error) {
    console.error(error.message);
    return 2;
  }
}

function invokedDirectly() {
  try {
    return (
      process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = run(process.argv.slice(2));
