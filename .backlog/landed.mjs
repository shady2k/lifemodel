// The main line's commits for the gate's `merged-but-open` rule (model.md, "The
// landed commits"): every commit reachable from the main line, with the ids its
// header names, read by the same parser the commit-link check uses
// (commits.mjs linkedIds), so one convention feeds both. A local read of
// history, never a network call.
//
// The main line is this clone's view of the remote's main branch
// (refs/remotes/origin/main), or the local main where there is no remote copy.
// It is never HEAD: a branch's own commits name its active leaf before they
// land, and that is work in progress, not work already delivered.
import { execFileSync, spawnSync } from 'node:child_process';
import { linkedIds } from './commits.mjs';

const MAIN = ['refs/remotes/origin/main', 'refs/heads/main'];

export function mainLine() {
  for (const ref of MAIN) {
    const r = spawnSync('git', ['rev-parse', '-q', '--verify', `${ref}^{commit}`], { encoding: 'utf8' });
    if (r.status === 0) return { ref, sha: r.stdout.trim() };
  }
  throw new Error(`no main line here: neither ${MAIN.join(' nor ')} names a commit (fetch the remote's main)`);
}

// [{ id, taskIds }] for each commit reachable from `rev` whose header names an id.
// A merge with no id of its own adds nothing: the commits it brings in are on
// the list themselves.
export function landedAt(rev) {
  const out = execFileSync('git', ['log', '--format=%H%x00%B%x1e', rev], {
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const landed = [];
  for (const entry of out.split('\x1e')) {
    const at = entry.indexOf('\0');
    if (at < 0) continue;
    const id = entry.slice(0, at).trim();
    const taskIds = linkedIds(entry.slice(at + 1));
    if (id && taskIds.length) landed.push({ id, taskIds });
  }
  return landed;
}

// The landed list for a tracker state recorded at revision `at`, judged against
// the main line `main`: the commits both reach (their merge base). A state
// recorded on a branch therefore never counts that branch's own commits as
// landed, and a state recorded after a merge into main counts what it brought.
// CI passes the base it judges against as `main` (the PR's base, or main before
// the push); a local run takes this clone's main line.
export function landedFor(at, main) {
  const r = spawnSync('git', ['merge-base', at, main], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`no merge base of ${at.slice(0, 12)} and the main line ${main.slice(0, 12)}`);
  return landedAt(r.stdout.trim());
}
