#!/usr/bin/env node
// Guarded task claims (lifemodel-j1l). Readiness belongs to this project; the
// claim itself goes through the store's mechanism (.backlog/sync/tracker-sync.mjs),
// which writes the holder against the state it just merged from the remote and
// counts the claim only once it is on the remote (lifemodel-hsyc). A claim the
// remote's newer state refuses is lost and said so: exit 3, nothing left behind.
//
// The residual the layout accepts: two machines claiming one item inside the
// same seconds can both believe they hold it until the next sync, after which
// every machine shows one holder and the other session learns at its next read
// that the item is not its own.
import {spawnSync} from 'node:child_process';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {read} from './adapter.mjs';
import {readyLeaves} from './ready.mjs';

const MECHANISM=join(dirname(fileURLToPath(import.meta.url)),'sync','tracker-sync.mjs');
const ACTOR=/^[^:\s]+:[^@\s]+@[^:\s]+:[^#\s]+#[^\s]+$/;

function mechanism(args) {
  const r=spawnSync(process.execPath,[MECHANISM,...args],{encoding:'utf8',maxBuffer:64*1024*1024});
  if (r.error) throw new Error(`the store's mechanism could not be run: ${r.error.message}`);
  return r;
}
function said(r) {return `${(r.stderr||'').trim()} ${(r.stdout||'').trim()}`.trim();}

export function claim(id, {actor, checkout='HEAD'} = {}) {
  if (!id || !ACTOR.test(actor || '')) {
    throw new Error('claim needs an issue id and --actor <harness-role:person@machine:branch#session>');
  }
  // The store as every machine has it now: a read that cannot reach the remote
  // says so, and the claim below would refuse anyway (it must reach the remote).
  const snapshot=read([]);
  const merged = revision => {
    const sha = String(revision || '').split('@').pop();
    if (!sha) return false;
    return spawnSync('git',['merge-base','--is-ancestor',sha,checkout],{stdio:'ignore'}).status===0;
  };
  const candidate = readyLeaves(snapshot.issues,{merged}).find(issue => issue.id === id);
  if (!candidate) throw new Error(`${id}: not an open, unheld, ready leaf in checkout ${checkout}; no claim attempted`);
  const held=mechanism(['claim','--item',id,'--holder',actor]);
  if (held.status===3) throw Object.assign(new Error(`claim lost: ${said(held)}`),{lost:true});
  if (held.status!==0) throw new Error(`the claim was not made (exit ${held.status}): ${said(held)}`);
  // The holder alone leaves the item open; the claim is the holder and the
  // active status together, each published before it counts.
  const active=mechanism(['transition','--item',id,'--to','in_progress','--expect','open']);
  if (active.status!==0) throw new Error(`${id} is held by ${actor} but could not be made active (exit ${active.status}): ${said(active)}; release or retry it`);
  return `${id} claimed by ${actor}, active, on the remote\n`;
}
function main(argv) {
  const [id,...rest] = argv;
  if (id === '--help') {
    console.log('claim.mjs <id> --actor <full-agent-name> [--checkout <revision>]\nExit 3 when the claim was lost to another holder.');
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
    console.error(`Guarded claim refused: ${error.message}`);
    process.exitCode=error.lost?3:1;
  }
}
