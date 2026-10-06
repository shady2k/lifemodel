#!/usr/bin/env node
// br (beads_rust) -> the normalized backlog the shipped rules read (.backlog/rules/,
// model.md of shady2k-skills). The rules know no tracker; everything br-specific is here.
//
//   adapter.mjs                       the working tree's .beads/issues.jsonl
//   adapter.mjs --at <rev>            the export as committed at <rev> (`:0` = staged, `HEAD` = last commit)
//   adapter.mjs --jsonl <file>        any beads-format JSONL export
//
// It reads the TRACKED JSONL EXPORT, not br's database, deliberately: `br` never
// runs git, so the export is the only copy git can show at another revision — which
// is where a baseline comes from, and the only honest source of ages once a bulk
// edit has rewritten them. The database is also the main checkout's from every
// worktree, so reading it would answer about the wrong branch. A live read for
// the commit-link check uses the export `br where` names (see commits.mjs).
//
// Exit 2, with the reason, when the tracker cannot be read: an unreadable
// backlog is never an empty one.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const TYPES = new Set(['epic', 'task', 'bug', 'chore']);
// `submitted` and `implemented` are br statuses of this project (.beads/policy.yaml),
// and the transition that sets one carries its revision and evidence as a comment:
// `submitted: <rev> -- <evidence>` (docs/backlog-integration.md).
const STATUS = {
  open: 'open',
  blocked: 'open', // a derived view; the edges say what blocks it
  in_progress: 'active',
  submitted: 'submitted',
  implemented: 'implemented',
  deferred: 'deferred',
  closed: 'closed',
};
const MARKER = /^(submitted|implemented):\s*(.*)$/s;
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

export function readExport(at, exportPath = '.beads/issues.jsonl') {
  // `git show :0:<path>` is the staged copy and `git show HEAD:<path>` the last
  // committed one; both take the same spelling, so one flag serves the hook and
  // a baseline alike.
  const text = at
    ? execFileSync('git', ['show', `${at}:${exportPath}`], { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] })
    : readFileSync(exportPath, 'utf8');
  return parseJsonl(text);
}

export function read(argv) {
  const at = argv.indexOf('--at');
  const file = argv.indexOf('--jsonl');
  if (at >= 0) {
    const rev = argv[at + 1];
    return normalize(readExport(rev), `beads .beads/issues.jsonl @ ${rev}`);
  }
  if (file >= 0) return normalize(parseJsonl(readFileSync(argv[file + 1], 'utf8')), `beads jsonl ${argv[file + 1]}`);
  return normalize(readExport(null), 'beads .beads/issues.jsonl (working tree)');
}

function main() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--at' || a === '--jsonl') i++; // value flag
    else if (a === '--help' || a === '-h') {
      console.log('adapter.mjs [--at <git-rev>|:0] [--jsonl <file>]  > normalized.json');
      return 0;
    } else {
      console.error(`adapter.mjs: unknown argument ${a}`);
      return 2;
    }
  }
  try {
    process.stdout.write(JSON.stringify(read(argv), null, 2) + '\n');
    return 0;
  } catch (e) {
    console.error(`backlog adapter: cannot read the tracker: ${e.message.split('\n')[0]}`);
    console.error('Is this clone connected? Run: npm run connect');
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
