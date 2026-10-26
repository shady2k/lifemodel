#!/usr/bin/env node
// br (beads_rust) -> the normalized backlog the shipped rules read (.backlog/rules/,
// model.md of shady2k-skills). The rules know no tracker; everything br-specific is here.
//
// The tracker lives outside the code branches (lifemodel-hsyc): one store per
// machine, a worktree of this repository detached at refs/tracker/state, which
// no branch contains, kept in step with the remote by .backlog/sync/tracker-sync.mjs.
// No code revision carries a tracker record, so the state "at a revision" is
// what the store recorded under that revision's own name when it was cut or
// landed (.tracker-sync/recordings/<sha>.jsonl), never the revision's tree.
//
//   adapter.mjs                        the store as it is now, after a sync with the
//                                      remote; unreachable: this machine's store, said so
//   adapter.mjs --offline              the store as it is now, no sync
//   adapter.mjs --at <rev>             the store's recording of <rev>; refused where none
//   adapter.mjs --at-or-before <rev>   the newest recording among <rev> and its ancestors
//                                      (a baseline, or a merge GitHub made, which no
//                                      clone recorded); the source line names which one
//   adapter.mjs --ref <git ref>        read the store from that ref's tree instead of this
//                                      machine's store worktree (CI: refs/tracker/state)
//   adapter.mjs --jsonl <file>         any beads-format JSONL export
//
// Exit 2, with the reason, when the tracker cannot be read: an unreadable
// backlog is never an empty one, and a revision with no recording is not the
// empty backlog either.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { landedFor, mainLine } from './landed.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MECHANISM = join(HERE, 'sync', 'tracker-sync.mjs');
const EXPORT = '.beads/issues.jsonl';
const RECORDINGS = '.tracker-sync/recordings';

const TYPES = new Set(['epic', 'task', 'bug', 'chore']);
// `submitted` and `implemented` are br statuses of this project (.backlog/br-policy.yaml,
// installed as the store's .beads/policy.yaml), and the transition that sets one
// carries its revision and evidence as a comment:
// `submitted: <rev> -- <evidence>` (docs/backlog-integration.md). A stage's
// acceptance is a comment on the stage of the same shape,
// `accepted: <accepted revision> -- <evidence>`: an accepted stage stays open
// until it lands, and its accepted revision releases the later stages of the
// same feature (model.md, Execution mapping).
const STATUS = {
  open: 'open',
  blocked: 'open', // a derived view; the edges say what blocks it
  in_progress: 'active',
  submitted: 'submitted',
  implemented: 'implemented',
  deferred: 'deferred',
  closed: 'closed',
};
const MARKER = /^(submitted|implemented|accepted):\s*(.*)$/s;
const RECORD = /^(\S+)\s+--\s+(\S[\s\S]*)$/;
const WORK_RECORD = '[shady2k-time';

export function workRecords(comments) {
  return (comments || [])
    .filter((c) => typeof c.text === 'string' && c.text.startsWith(WORK_RECORD))
    .map((c) => ({ id: String(c.id), at: c.created_at, author: c.author, body: c.text }));
}

// The record of the latest `<kind>:` comment, or an empty one where there is
// none or it lacks a half: the gate's *-without-evidence check reports that.
export function record(comments, kind) {
  let last = null;
  // Oldest first by the tracker's own clock, then its id, whatever order the
  // export happens to write them in: "latest" must not depend on that.
  const ordered = [...(comments || [])].sort(
    (a, b) => String(a.created_at).localeCompare(String(b.created_at)) || (a.id ?? 0) - (b.id ?? 0),
  );
  for (const c of ordered) {
    const m = MARKER.exec((c.text || '').trim());
    if (m && m[1] === kind) last = m[2];
  }
  const r = last === null ? null : RECORD.exec(last.trim());
  return { revision: r ? r[1] : '', evidence: r ? r[2].trim() : '' };
}

export function normalize(rows, source) {
  // A tombstone is br's deleted issue: gone from the tracker, not a state of work.
  const issues = rows
    .filter((r) => (r._type || 'issue') === 'issue' && r.status !== 'tombstone')
    .map((r) => {
      const status = STATUS[r.status];
      if (!status) throw new Error(`${r.id} has the status "${r.status}", which this adapter does not map`);
      let parent = null;
      const blockedBy = [];
      for (const d of r.dependencies || []) {
        if (d.type === 'parent-child') parent = d.depends_on_id;
        // Only `blocks` gates work. `discovered-from`, `related` and the rest are
        // provenance and never reach the rules as a dependency.
        else if (d.type === 'blocks') blockedBy.push(d.depends_on_id);
      }
      const body = [r.description || ''];
      // Beads keeps acceptance criteria in their own field; the rules look for the heading.
      if (r.acceptance_criteria) body.push(`## Acceptance Criteria\n${r.acceptance_criteria}`);
      const out = {
        id: r.id,
        title: r.title || '',
        type: TYPES.has(r.issue_type) ? r.issue_type : 'other',
        status,
        labels: r.labels || [],
        parent,
        blockedBy,
        body: body.join('\n\n'),
        updatedAt: r.updated_at,
        createdAt: r.created_at,
        holder: r.assignee || null,
        comments: workRecords(r.comments),
      };
      if (status === 'submitted') out.delivery = record(r.comments, 'submitted');
      if (status === 'implemented') out.integration = record(r.comments, 'implemented');
      if (out.type === 'epic') {
        const accepted = record(r.comments, 'accepted');
        if (accepted.revision) out.acceptance = accepted;
      }
      return out;
    });
  return { generatedAt: new Date().toISOString(), source, issues };
}

export function parseJsonl(text) {
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// The mechanism writes a state as sections, one per state file of the recipe:
// `=== <path>\n<content>`. The tracker's items are the export's section.
export function exportSection(text, what) {
  const re = /^=== (.*)\n/gm;
  const marks = [];
  let m;
  while ((m = re.exec(text))) marks.push([m[1], m.index, m.index + m[0].length]);
  const i = marks.findIndex(([p]) => p === EXPORT);
  if (i < 0) throw new Error(`${what} carries no ${EXPORT} section`);
  return text.slice(marks[i][2], i + 1 < marks.length ? marks[i + 1][1] : text.length);
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });

// This machine's store, where the mechanism keeps it: named after the MAIN
// checkout (the parent of the common git directory), so every worktree of the
// machine reaches the one store (tracker-sync.mjs, machineDir).
export function storeDir() {
  const common = resolve(git(['rev-parse', '--git-common-dir']).trim());
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  const store = join(base, basename(dirname(common)), 'tracker');
  if (!existsSync(join(store, EXPORT))) throw new Error(`this machine has no tracker store at ${store}; run npm run connect`);
  return store;
}

// A place a store can be read from: this machine's store worktree, or a ref's
// tree (CI fetches refs/tracker/state; it has no store of its own).
function placeOf(ref) {
  const show = (cwd, spec) => {
    const r = spawnSync('git', ['show', spec], { cwd, encoding: 'utf8', maxBuffer: 1 << 30 });
    return r.status === 0 ? r.stdout : null;
  };
  if (ref) return { name: ref, read: (p) => show(undefined, `${ref}:${p}`), at: (oid, p) => show(undefined, `${oid}:${p}`) };
  const store = storeDir();
  return {
    name: store,
    read: (p) => (existsSync(join(store, p)) ? readFileSync(join(store, p), 'utf8') : null),
    at: (oid, p) => show(store, `${oid}:${p}`),
  };
}

// A recording is either a whole state (sections, the format before mechanism
// 0.126.0) or a reference to the store commit that holds it
// (`tracker-sync-recording/1`, JSON naming `store`). Both read to the items.
const RECORDING_FORMAT = 'tracker-sync-recording/1';
function rowsOfRecording(place, text, sha) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    let d = null;
    try {
      d = JSON.parse(trimmed);
    } catch {
      /* not a reference: read as sections below, which says what is wrong */
    }
    if (d && d.format === RECORDING_FORMAT && typeof d.store === 'string') {
      const items = place.at(d.store, EXPORT);
      if (items === null)
        throw new Error(`the recording of ${sha} names store commit ${d.store.slice(0, 12)}, which ${place.name} does not hold (fetch the tracker ref's history)`);
      return parseJsonl(items);
    }
  }
  return parseJsonl(exportSection(text, `the recording of ${sha}`));
}

function commitOf(rev) {
  const r = spawnSync('git', ['rev-parse', '-q', '--verify', `${rev}^{commit}`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${rev} is not a commit git can read here`);
  return r.stdout.trim();
}

const recordingOf = (place, sha) => place.read(`${RECORDINGS}/${sha}.jsonl`);

// The state the store recorded for <rev>. With orBefore, the newest recording
// among <rev> and its ancestors, or null where the history has none at all.
export function readAt(rev, { ref, orBefore = false } = {}) {
  const place = placeOf(ref);
  const sha = commitOf(rev);
  const own = recordingOf(place, sha);
  if (own !== null) return { rows: rowsOfRecording(place, own, sha), source: `store ${place.name} @ ${sha}`, at: sha };
  if (!orBefore)
    throw new Error(
      `the store (${place.name}) never recorded ${sha.slice(0, 12)}, so its tracker state is unknown and is not guessed from a later one. ` +
        'A commit made in a connected clone is recorded by its post-commit hook and again before its push; run npm run connect there',
    );
  // Newest first by commit date: for a merge GitHub made, its own branch's tip
  // comes before the older main it merged into.
  const ancestors = git(['rev-list', '--date-order', '--max-count=2000', sha]).split('\n').filter(Boolean);
  for (const a of ancestors) {
    const text = recordingOf(place, a);
    if (text !== null)
      return {
        rows: rowsOfRecording(place, text, a),
        source: `store ${place.name} @ ${a} (newest recording at or before ${sha.slice(0, 12)})`,
        at: a,
      };
  }
  return null;
}

export function readNow({ ref, offline = false } = {}) {
  if (ref) {
    const text = placeOf(ref).read(EXPORT);
    if (text === null) throw new Error(`${ref} carries no ${EXPORT}`);
    return { rows: parseJsonl(text), source: `store ${ref} (now)` };
  }
  const store = storeDir();
  if (!offline) {
    // The export command syncs with the remote first, so the state is every
    // machine's; exit 4 is "the remote is unreachable", and then this machine's
    // store is read and said to be this machine's only.
    const r = spawnSync(process.execPath, [MECHANISM, 'export'], { encoding: 'utf8', maxBuffer: 1 << 30 });
    if (r.status === 0) return { rows: parseJsonl(exportSection(r.stdout, 'the store export')), source: `store ${store} (now, synced)` };
    if (r.status !== 4) throw new Error(`the store export failed (exit ${r.status}): ${(r.stderr || '').trim().split('\n')[0]}`);
    process.stderr.write("backlog adapter: the remote is unreachable; this is this machine's store only, not every machine's\n");
    return {
      rows: parseJsonl(readFileSync(join(store, EXPORT), 'utf8')),
      source: `store ${store} (now, this machine only: the remote is unreachable)`,
    };
  }
  return { rows: parseJsonl(readFileSync(join(store, EXPORT), 'utf8')), source: `store ${store} (now, not synced)` };
}

// The raw state argv names, with the revision it was recorded at (`at`; HEAD for
// the store as it is now) — null for a --jsonl file, which belongs to no revision.
function readRaw(argv) {
  const ref = val(argv, '--ref');
  if (val(argv, '--jsonl')) return { rows: parseJsonl(readFileSync(val(argv, '--jsonl'), 'utf8')), source: `beads jsonl ${val(argv, '--jsonl')}`, at: null };
  if (val(argv, '--at')) return readAt(val(argv, '--at'), { ref });
  if (val(argv, '--at-or-before')) {
    const r = readAt(val(argv, '--at-or-before'), { ref, orBefore: true });
    if (!r) throw new Error(`no recording at or before ${val(argv, '--at-or-before')}`);
    return r;
  }
  return { ...readNow({ ref, offline: argv.includes('--offline') }), at: commitOf('HEAD') };
}

export function read(argv) {
  const r = readRaw(argv);
  return normalize(r.rows, r.source);
}

// read(), with the main line's landed commits beside the issues (model.md, "The
// landed commits"), judged at the revision the state was recorded at.
export function readWithLanded(argv) {
  const r = readRaw(argv);
  const out = normalize(r.rows, r.source);
  if (r.at) out.landed = landedFor(r.at, mainLine().sha);
  return out;
}

function val(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main() {
  const argv = process.argv.slice(2);
  const valued = ['--at', '--at-or-before', '--ref', '--jsonl'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued.includes(a)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) {
        console.error(`adapter.mjs: ${a} needs a value`);
        return 2;
      }
      i++;
    } else if (a === '--offline') continue;
    else if (a === '--help' || a === '-h') {
      console.log('adapter.mjs [--offline | --at <rev> | --at-or-before <rev> | --jsonl <file>] [--ref <git ref>]  > normalized.json');
      return 0;
    } else {
      console.error(`adapter.mjs: unknown argument ${a}`);
      return 2;
    }
  }
  try {
    process.stdout.write(JSON.stringify(readWithLanded(argv), null, 2) + '\n');
    return 0;
  } catch (e) {
    console.error(`backlog adapter: cannot read the tracker: ${e.message.split('\n')[0]}`);
    console.error('Is this clone connected? Run: npm run connect');
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
