#!/usr/bin/env node
// Commit messages -> the input of .backlog/rules/check-commits.mjs, then the check.
//
// THE CONVENTION: a commit names its task(s) in parentheses, as in
// `Fix the thing (lifemodel-7ld)` or `(lifemodel-a, lifemodel-b.2)`. What is
// read is every `lifemodel-…` id inside parentheses in the HEADER PARAGRAPH —
// the lines up to the first blank one — because a subject that wraps carries
// its ids onto its second line. Ids in the body are references, not links, and
// are not read. Lines starting with `#` are git's own template and are dropped.
//
// A REVERT keeps the reverted subject in quotes, ids included, so it links to
// the same tasks with no rule of its own. A MERGE with no id of its own is
// linked by the commits it brings in — those between its first parent and
// itself — and each of those is checked on its own anyway; a merge that brings
// in nothing and names nothing is refused like any other unlinked commit.
//
// WHICH COMMITS: those committed at or after `commitLinksFrom` in config.json,
// the moment this check was switched on (the setup's landing). Older ones were
// made under no rule; they are listed as such and fail nothing.
//
// WHICH TASKS: every issue of the tracker, closed ones included. Locally that
// is the export `br` keeps current (`br where`), so a task filed a minute ago
// resolves; in CI it is the newest export the checked history reaches.
//
//   commits.mjs --message-file <file>   the pending message (commit-msg hook)
//   commits.mjs --range <base>..<head>  every commit the range introduces
//   commits.mjs --introduced <tip> --by <ref> [--before <sha>]
//                                       every commit a push of <ref> brings that
//                                       no other remote ref reaches; none is a pass,
//                                       said out loud (pre-push hook, CI)
//     [--export-at <rev>]               tasks from the export at <rev>
//     [--json]
//
// Exit 0 linked, 1 a commit without a valid link, 2 cannot check (never a pass).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalize, readExport, parseJsonl } from './adapter.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ID = /\blifemodel-[a-z0-9]+(?:\.\d+)*\b/g;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });

// The ids a message links to, by the convention above.
export function linkedIds(message) {
  const lines = message.split('\n').filter((l) => !l.startsWith('#'));
  while (lines.length && !lines[0].trim()) lines.shift();
  const end = lines.findIndex((l) => !l.trim());
  const header = (end < 0 ? lines : lines.slice(0, end)).join('\n');
  const ids = [];
  for (const group of header.match(/\([^()]*\)/g) || []) {
    for (const id of group.match(ID) || []) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

// What a merge with no id of its own links to: the links of the commits it
// brings in (`base..tip`, the merge itself excluded), counting only those made
// under the rule. null when it brings some in and every one predates it — such
// a merge is history arriving, and it is reported with the other old commits.
function incoming(base, tip, from, self) {
  const ids = [];
  let underRule = 0;
  const list = git('rev-list', '--format=%H%x00%ct', `${base}..${tip}`)
    .split('\n')
    .filter((l) => l && !l.startsWith('commit '));
  let brought = 0;
  for (const line of list) {
    const [c, ct] = line.split('\0');
    if (c === self) continue;
    brought++;
    if (Number(ct) * 1000 < from) continue;
    underRule++;
    for (const id of linkedIds(git('log', '-1', '--format=%B', c)))
      if (!ids.includes(id)) ids.push(id);
  }
  // A merge that brings in nothing has nothing to borrow a link from.
  return underRule || !brought ? ids : null;
}

// What a push of `ref` at `tip` introduces: the commits of `tip` that no ref
// the remote already held reaches — its branches and tags, the pushed ref
// itself excepted, and that ref's old tip when the push has one. Never a merge
// base with main: a tag or a new branch on a commit the remote already holds
// introduces nothing, and the check says so and passes.
function introducedBy(tip, ref, before) {
  const branch = ref.match(/^refs\/heads\/(.+)$/);
  const pushed = new Set([ref, ...(branch ? [`refs/remotes/origin/${branch[1]}`] : [])]);
  const held = git('for-each-ref', '--format=%(refname)', 'refs/remotes', 'refs/tags')
    .split('\n')
    .filter((r) => r && !pushed.has(r));
  const input = [tip, ...(before ? [before] : []).concat(held).map((r) => `^${r}`)].join('\n');
  return execFileSync('git', ['rev-list', '--reverse', '--format=%H %P%x00%ct', '--stdin'], {
    input: `${input}\n`,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function tasks(exportAt) {
  let rows;
  if (exportAt) rows = readExport(exportAt);
  else {
    // The pending message is checked against br's own export, which holds a
    // task filed a minute ago that no commit carries yet. Without br there is
    // no such export, and the tree's copy would refuse that task as unknown
    // for a reason nobody could see, so a missing br is an error, not a
    // fallback.
    const where = spawnSync('br', ['where', '--json'], { encoding: 'utf8' });
    if (where.error)
      throw new Error(`br could not be run (${where.error.code}); run npm run connect, which names what is missing`);
    if (where.status !== 0)
      throw new Error(`br where failed: ${(where.stderr || '').trim() || `exit ${where.status}`}; run npm run connect`);
    rows = parseJsonl(readFileSync(JSON.parse(where.stdout).jsonl_path, 'utf8'));
  }
  if (!rows.length)
    throw new Error('the export holds no task; run npm run connect to import the backlog');
  return normalize(rows).issues.map((i) => ({ id: i.id, type: i.type, parent: i.parent }));
}

function main() {
  const argv = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opt.json = true;
    else if (['--message-file', '--range', '--introduced', '--by', '--before', '--export-at'].includes(a) && argv[i + 1])
      opt[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    else {
      console.error(`commits.mjs: unknown or incomplete argument ${a}`);
      return 2;
    }
  }
  const mode = ['messageFile', 'range', 'introduced'].filter((k) => opt[k]);
  if (mode.length !== 1) {
    console.error('commits.mjs: give exactly one of --message-file <file>, --range <base>..<head> or --introduced <tip> --by <ref>');
    return 2;
  }
  if (!!opt.introduced !== !!opt.by || (opt.before && !opt.introduced)) {
    console.error('commits.mjs: --introduced <tip> takes --by <ref> and at most --before <sha>');
    return 2;
  }

  let config;
  try {
    config = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
  } catch (e) {
    console.error(`commits.mjs: config.json could not be read (${e.code || e.message}); run npm run connect, which names what is missing`);
    return 2;
  }
  const from = Date.parse(config.commitLinksFrom);
  if (!Number.isFinite(from)) {
    console.error('commits.mjs: config.json has no readable commitLinksFrom');
    return 2;
  }

  const commits = [];
  const before = [];
  if (opt.messageFile) {
    const message = readFileSync(opt.messageFile, 'utf8');
    const mergeHead = git('rev-parse', '--git-path', 'MERGE_HEAD').trim();
    let taskIds = linkedIds(message);
    let old = false;
    if (!taskIds.length && existsSync(mergeHead)) {
      // The merge is not a commit yet, so what it brings in is HEAD..MERGE_HEAD.
      const head = readFileSync(mergeHead, 'utf8').split('\n')[0].trim();
      const ids = incoming('HEAD', head, from, null);
      if (ids === null) old = true;
      else taskIds = ids;
    }
    if (old) before.push('pending merge');
    else commits.push({ id: 'pending message', taskIds });
  } else {
    let listed;
    if (opt.range) {
      if (!/^[^.\s]+\.\.[^.\s]+$/.test(opt.range)) {
        console.error(`commits.mjs: --range wants <base>..<head>, got ${opt.range}`);
        return 2;
      }
      listed = git('rev-list', '--reverse', '--format=%H %P%x00%ct', opt.range);
    } else {
      // A tip or a --before git cannot read is a broken input, not an empty push.
      for (const rev of [opt.introduced, opt.before].filter(Boolean)) {
        if (spawnSync('git', ['rev-parse', '-q', '--verify', `${rev}^{commit}`]).status !== 0) {
          console.error(`commits.mjs: ${rev} is not a commit git can read`);
          return 2;
        }
      }
      listed = introducedBy(opt.introduced, opt.by, opt.before);
    }
    const list = listed.split('\n').filter((l) => l && !l.startsWith('commit '));
    if (!list.length && opt.introduced) {
      console.log(`${opt.by} introduces no commits: nothing to check`);
      return 0;
    }
    if (!list.length) {
      console.error(`commits.mjs: the range ${opt.range} introduces no commit, so there is nothing it could have checked`);
      return 2;
    }
    for (const line of list) {
      const [shas, ct] = line.split('\0');
      const [sha, ...parents] = shas.trim().split(' ');
      if (Number(ct) * 1000 < from) {
        before.push(sha);
        continue;
      }
      let taskIds = linkedIds(git('log', '-1', '--format=%B', sha));
      if (!taskIds.length && parents.length > 1) {
        const ids = incoming(parents[0], sha, from, sha);
        if (ids === null) {
          before.push(sha);
          continue;
        }
        taskIds = ids;
      }
      commits.push({ id: sha, taskIds });
    }
    if (!opt.exportAt) opt.exportAt = opt.introduced || opt.range.split('..')[1];
  }

  if (before.length) {
    console.log(
      `${before.length} commit(s) predate commitLinksFrom (${config.commitLinksFrom}), or are merges bringing in only such commits, and are not checked`,
    );
  }
  if (!commits.length) {
    console.log('no commit in the range was made under the rule; nothing to check');
    return 0;
  }

  let issues;
  try {
    issues = tasks(opt.exportAt);
  } catch (e) {
    console.error(`commits.mjs: the tracker could not be read: ${e.message}`);
    console.error('This refuses the commit rather than passing it unchecked. Connect the clone: npm run connect');
    return 2;
  }
  const run = spawnSync(process.execPath, [join(HERE, 'rules', 'check-commits.mjs'), '-'], {
    input: JSON.stringify({ issues, commits }),
    encoding: 'utf8',
  });
  const out = run.stdout || '';
  if (opt.json) process.stdout.write(out);
  else {
    let report;
    try {
      report = JSON.parse(out);
    } catch {
      process.stdout.write(out);
    }
    if (report?.violations) {
      for (const v of report.violations) {
        const subject =
          v.id === 'pending message'
            ? v.id
            : `${v.id.slice(0, 10)} ${git('log', '-1', '--format=%s', v.id).trim()}`;
        console.log(`  ${subject}: ${v.task ? `${v.task} — ` : ''}${v.reason}`);
      }
      console.log(`${report.checked} commit(s) checked, ${report.violations.length} link problem(s)`);
      if (report.violations.length) {
        console.log(
          'Name a leaf task, "(lifemodel-…)" in parentheses in the subject. No task for it? File one through the to-backlog skill — a stage or an epic is not a task.',
        );
      }
    } else if (report?.error) console.log(report.error);
  }
  process.stderr.write(run.stderr || '');
  return run.status ?? 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
