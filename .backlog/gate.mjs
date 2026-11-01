#!/usr/bin/env node
// The backlog gate: the tracker judged by .backlog/rules/check.mjs against a
// baseline, so under `block-new` only what is new fails and older debt is printed.
//
// The tracker lives outside the code branches (adapter.mjs says how it is read):
// "now" is the store as it is now, and the baseline is the state the store
// recorded under the base revision's own name, or the newest recording among its
// ancestors. A history with no recording at all is the empty backlog, said so:
// everything is new against it, honestly.
//
//   gate.mjs [--base <rev>] [--offline] [--json]   now vs the recording at or before <rev> (HEAD);
//                                                  --offline: no sync first (the commit hook)
//   gate.mjs --head <rev> --base <rev> --ref <ref> CI: the recording of <rev> vs the base's,
//            [--head-or-before]                    both read from <ref>'s tree; --head-or-before
//                                                  takes the newest recording at or before <rev>
//                                                  (a merge GitHub made, which nobody recorded)
//
// The baseline config is the one committed at <base>, so a budget lowered in
// this change counts against it. A merge in progress is judged against both
// parents (merge-gate.mjs says why): debt the other parent already carried is
// not new because HEAD lacked it.
//
// Exit 0 clean, 1 new violations, 2 cannot check (never a pass).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize, readAt, readNow } from './adapter.mjs';
import { landedFor, mainLine } from './landed.mjs';
import { documentsAt } from './documents.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] });

// A rules file the check imports and cannot find crashes node with exit 1, which
// would read as "this change adds a problem". It is a missing input, said as one.
const RULES = ['check.mjs', 'time-format.mjs', 'regular-file.mjs', 'argv.mjs'];
// documents.mjs sits beside this file and is imported, so a missing one fails the import loudly.

// Each judged state carries the main line's commits as they stood where it was
// recorded (landed.mjs): `main` is the base CI judges against, or this clone's
// main line locally, so a branch's own commits never count as landed.
function withLanded(state, at, main, documentsRev = at) {
  state.landed = landedFor(at, main);
  // The outcomes and vision the rules read, from the same revision (the working
  // tree when documentsRev is null): a baseline is judged by its own charter.
  Object.assign(state, documentsAt(documentsRev));
  return state;
}

function baselineOf(base, ref, main) {
  const r = readAt(base, { ref, orBefore: true });
  if (r) return withLanded(normalize(r.rows, r.source), r.at, main, base);
  return { generatedAt: new Date().toISOString(), source: `empty (no recording at or before ${base})`, issues: [] };
}

// One judgement of the backlog now against <base>: a check.mjs run whose
// stdout (with --json) is returned, or whose exit code is returned without it.
function judged(base, ref, nowFile, json, main) {
  const dir = mkdtempSync(join(tmpdir(), 'lifemodel-gate-'));
  try {
    const put = (name, value) => {
      const p = join(dir, name);
      writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
      return p;
    };
    const baseline = baselineOf(base, ref, main);
    if (!json) console.log(`baseline: ${baseline.source}`);
    let baselineConfig = null;
    try {
      baselineConfig = git('show', `${base}:.backlog/config.json`);
    } catch {
      /* the base predates the installation */
    }
    const args = [
      join(HERE, 'rules', 'check.mjs'),
      '--config', join(HERE, 'config.json'),
      '--baseline', put('base.json', baseline),
      ...(baselineConfig ? ['--baseline-config', put('base-config.json', baselineConfig)] : []),
      ...(json ? ['--json'] : []),
      nowFile,
    ];
    const res = spawnSync(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
    if (!json && res.stdout) process.stdout.write(res.stdout);
    return { status: res.status ?? 2, stdout: res.stdout || '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(argv) {
  const gone = RULES.filter((f) => !existsSync(join(HERE, 'rules', f)));
  if (gone.length) throw new Error(`missing .backlog/rules/${gone.join(', .backlog/rules/')}`);
  const val = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const known = new Set(['--base', '--head', '--ref', '--json', '--head-or-before', '--offline']);
  for (let i = 0; i < argv.length; i++) {
    if (!known.has(argv[i])) throw new Error(`unknown argument ${argv[i]}`);
    if (['--base', '--head', '--ref'].includes(argv[i])) i++;
  }
  const base = val('--base') || 'HEAD';
  const head = val('--head');
  const ref = val('--ref');
  const json = argv.includes('--json');
  if (head && !ref) throw new Error('--head reads a recording, so it needs --ref <ref> (CI: refs/tracker/state)');
  const dir = mkdtempSync(join(tmpdir(), 'lifemodel-gate-'));
  try {
    let now;
    const main = head ? git('rev-parse', '--verify', `${base}^{commit}`).trim() : mainLine().sha;
    if (head) {
      const r = readAt(head, { ref, orBefore: argv.includes('--head-or-before') });
      if (!r) throw new Error(`no recording at or before ${head}`);
      now = withLanded(normalize(r.rows, r.source), r.at, main);
    } else {
      const r = readNow({ offline: argv.includes('--offline') });
      now = withLanded(normalize(r.rows, r.source), git('rev-parse', 'HEAD').trim(), main, null);
    }
    if (!json) console.log(`judged:   ${now.source}`);
    const nowFile = join(dir, 'now.json');
    writeFileSync(nowFile, JSON.stringify(now));
    const mergeHead = head ? null : git('rev-parse', '--git-path', 'MERGE_HEAD').trim();
    const other = mergeHead && existsSync(mergeHead) ? readFileSync(mergeHead, 'utf8').split('\n')[0].trim() : null;
    if (other && !spawnSync('git', ['rev-parse', '-q', '--verify', `${other}^{commit}`]).status) {
      const vsHead = judged(base, ref, nowFile, true, main);
      const vsOther = judged(other, ref, nowFile, true, main);
      const mg = spawnSync(process.execPath, [join(HERE, 'merge-gate.mjs')], {
        input: JSON.stringify({ head: JSON.parse(vsHead.stdout), other: JSON.parse(vsOther.stdout) }),
        encoding: 'utf8',
      });
      if (json) process.stdout.write(mg.stdout || '');
      else if (mg.stdout) console.log(mg.stdout.trim());
      if (mg.status === 1)
        console.error('\nBACKLOG GATE: the tracker has a problem that neither parent of this merge had (lines above, with their fix). Older problems do not block.');
      return mg.status ?? 2;
    }
    const r = judged(base, ref, nowFile, json, main); // judged() already printed the report
    if (r.status === 1) {
      console.error('\nBACKLOG GATE: the tracker has a problem that its state at the base did not have (FAIL lines above, with their fix).');
      console.error('Older problems are listed but do not block. Fix the new ones in the tracker, then commit again.');
    }
    return r.status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`backlog gate could not run: ${e.message.split('\n')[0]}`);
  console.error('This refuses rather than passing unchecked. Connect the clone: npm run connect');
  process.exitCode = 2;
}
