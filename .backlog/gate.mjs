#!/usr/bin/env node
// The backlog gate: the tracker judged by .backlog/rules/check.mjs, the staged
// export against the export as committed at <base> (default HEAD), so under
// `block-new` only what this change introduced fails and older debt is printed.
//
//   gate.mjs [--base <rev>] [--json] [--worktree]
//
// The baseline config is the one committed at <base>, so a budget lowered in
// this change counts against it. A merge is judged against both parents
// (merge-gate.mjs says why): debt the other parent already carried is not new
// because HEAD lacked it.
//
// Exit 0 clean, 1 new violations, 2 cannot check (never a pass).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { read } from './adapter.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] });

// A rules file the check imports and cannot find crashes node with exit 1, which
// would read as "this change adds a problem". It is a missing input, said as one.
const RULES = ['check.mjs', 'time-format.mjs'];

// One judgement of the staged backlog against <base>: a check.mjs run whose
// stdout (with --json) is returned, or whose exit code is returned without it.
function judged(base, nowFile, json) {
  const dir = mkdtempSync(join(tmpdir(), 'lifemodel-gate-'));
  try {
    const put = (name, value) => {
      const p = join(dir, name);
      writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
      return p;
    };
    // A base that predates the installation carries no export and no config:
    // there was no backlog then, so the empty backlog is the honest baseline
    // (and today's config judges it). Anything this change adds is new.
    let baseline = null;
    let baselineConfig = null;
    try {
      baseline = JSON.stringify(read(['--at', base]));
    } catch {
      baseline = JSON.stringify({ generatedAt: new Date().toISOString(), source: `empty (no .beads/issues.jsonl at ${base})`, issues: [] });
    }
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
    return { status: res.status ?? 2, stdout: res.stdout || '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(argv) {
  const gone = RULES.filter((f) => !existsSync(join(HERE, 'rules', f)));
  if (gone.length) throw new Error(`missing .backlog/rules/${gone.join(', .backlog/rules/')}`);
  const b = argv.indexOf('--base');
  const base = b >= 0 ? argv[b + 1] : 'HEAD';
  const json = argv.includes('--json');
  const dir = mkdtempSync(join(tmpdir(), 'lifemodel-gate-'));
  try {
    // Staged (`:0`), never the working tree: `br` rewrites the export on almost
    // every command, so a working-tree read would judge backlog writes the
    // commit is not making. --worktree reads the working tree, for connect's
    // proof that the gate runs in a clone with nothing staged.
    const nowAt = argv.includes('--worktree') ? null : ':0';
    const now = join(dir, 'now.json');
    writeFileSync(now, JSON.stringify(read(nowAt === null ? [] : ['--at', nowAt])));
    const mergeHead = git('rev-parse', '--git-path', 'MERGE_HEAD').trim();
    const other = existsSync(mergeHead) ? readFileSync(mergeHead, 'utf8').split('\n')[0].trim() : null;
    if (other && !spawnSync('git', ['rev-parse', '-q', '--verify', `${other}^{commit}`]).status) {
      const vsHead = judged(base, now, true);
      const vsOther = judged(other, now, true);
      const mg = spawnSync(process.execPath, [join(HERE, 'merge-gate.mjs')], {
        input: JSON.stringify({ head: JSON.parse(vsHead.stdout), other: JSON.parse(vsOther.stdout) }),
        encoding: 'utf8',
      });
      if (json) process.stdout.write(mg.stdout || '');
      else if (mg.stdout) console.log(mg.stdout.trim());
      if (mg.status === 1)
        console.error('\nBACKLOG GATE: this merge adds a problem to the tracker (lines above, with their fix). Older problems do not block.');
      return mg.status ?? 2;
    }
    const r = judged(base, now, json);
    if (json) process.stdout.write(r.stdout);
    if (r.status === 1) {
      console.error('\nBACKLOG GATE: this change adds a problem to the tracker (FAIL lines above, with their fix).');
      console.error('Older problems are listed but do not block. Fix the new ones, then commit again.');
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
  console.error('This refuses the commit rather than passing it unchecked. Connect the clone: npm run connect');
  process.exitCode = 2;
}
