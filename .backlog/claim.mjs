#!/usr/bin/env node
// Guarded task claims (lifemodel-j1l). Readiness belongs to this project;
// ownership and target compare-and-swap stay in br's native transaction.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {normalize, parseJsonl} from './adapter.mjs';
import {readyLeaves} from './ready.mjs';

function br(args) {
  return execFileSync('br', args, {encoding:'utf8', maxBuffer:64*1024*1024, stdio:['ignore','pipe','pipe']});
}
export function claim(id, {actor, checkout='HEAD'} = {}) {
  if (!id || !/^[^:\s]+:[^@\s]+@[^:\s]+:[^#\s]+#[^\s]+$/.test(actor || '')) {
    throw new Error('claim needs an issue id and --actor <harness-role:person@machine:branch#session>');
  }
  const version = /\bbr\s+(\d+)\.(\d+)\.(\d+)\b/.exec(br(['--version']));
  if (!version || Number(version[1]) === 0 && Number(version[2]) < 7) {
    throw new Error('Guarded claim needs br >=0.7.0 (--if-unchanged); upgrade br, never use a manual --force fallback');
  }
  // Do not judge an old checkout export: every worktree uses the main store.
  // Flush normally, without any export/import force or guard waiver.
  br(['sync','--flush-only','--export-parallelism','1']);
  const location = JSON.parse(br(['where','--json']));
  if (!location.jsonl_path) throw new Error('br where did not report its authoritative jsonl_path');
  const rows = parseJsonl(readFileSync(location.jsonl_path,'utf8'));
  const snapshot = normalize(rows, 'br authoritative flushed export');
  const target = rows.find(row => row.id === id && row.status !== 'tombstone');
  if (!target || !target.updated_at) throw new Error(`${id}: no live target with updated_at`);
  const merged = revision => {
    const sha = String(revision || '').split('@').pop();
    if (!sha) return false;
    try {
      execFileSync('git',['merge-base','--is-ancestor',sha,checkout],{stdio:'ignore'});
      return true;
    } catch { return false; }
  };
  const candidate = readyLeaves(snapshot.issues,{merged}).find(issue => issue.id === id);
  if (!candidate) throw new Error(`${id}: not an open, unheld, ready leaf in checkout ${checkout}; no claim attempted`);
  const by = new Map(snapshot.issues.map(issue => [issue.id,issue]));
  const override = candidate.blockedBy.some(dep => by.get(dep)?.status === 'implemented');
  const args = ['update',id,'--claim','--actor',actor,'--if-unchanged',target.updated_at];
  // The ONLY approved waiver is br's closed-only advisory dependency check,
  // after project readiness/ancestry guards pass. Native exclusive ownership,
  // target timestamp CAS and terminal-state checks are not waived by --force.
  if (override) args.push('--force');
  return br(args);
}
function main(argv) {
  const [id,...rest] = argv;
  if (id === '--help') {
    console.log('claim.mjs <id> --actor <full-agent-name> [--checkout <revision>]\nRequires br >=0.7.0. No caller --force option.');
    return 0;
  }
  const options = {};
  for (let i=0;i<rest.length;i+=2) {
    const key=rest[i], value=rest[i+1];
    if (!['--actor','--checkout'].includes(key) || !value || value.startsWith('--') || Object.hasOwn(options,key.slice(2))) {
      throw new Error(`Unknown, duplicate or incomplete claim option: ${key}`);
    }
    options[key.slice(2)]=value;
  }
  process.stdout.write(claim(id,options));
  return 0;
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {process.exitCode=main(process.argv.slice(2));}
  catch(error) {
    console.error(`Guarded claim refused: ${error.stderr?.toString().trim() || error.message}`);
    process.exitCode=1;
  }
}
