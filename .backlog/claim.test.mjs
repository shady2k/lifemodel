// node --test .backlog/claim.test.mjs
//
// The guarded claim against a real store: a scratch remote, a clone connected
// to its own machine store (XDG_STATE_HOME points into the scratch folder), br
// writing through the clone's .beads link, and claim.mjs run there. The claim
// must land on the remote's refs/tracker/state, holder and active status both.
// Races between machines are the mechanism's own proofs (shady2k-skills
// test/tracker-sync-proof.mjs); this proves the project's readiness guard and
// that the claim goes through the mechanism.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HERE=dirname(fileURLToPath(import.meta.url));
const CLAIM=join(HERE,'claim.mjs');
const MECHANISM=join(HERE,'sync','tracker-sync.mjs');
const RECIPE=join(HERE,'sync','trackers','br.mjs');
const actor='prime-worker:fixture@offline:main#test1234';
let root,work,env;
const run=(cmd,args)=>spawnSync(cmd,args,{cwd:work,encoding:'utf8',env});
const ok=(cmd,args)=>{const r=run(cmd,args);assert.equal(r.status,0,`${cmd} ${args.join(' ')}: ${r.stderr}${r.stdout}`);return r.stdout.trim();};
const created=out=>/(fx-[a-z0-9.]+)/.exec(out)[1];
const remoteItem=id=>{
  const text=execFileSync('git',['--git-dir',join(root,'remote.git'),'show','refs/tracker/state:.beads/issues.jsonl'],{encoding:'utf8'});
  return text.trim().split('\n').map(l=>JSON.parse(l)).find(i=>i.id===id);
};

before(()=>{
  root=mkdtempSync(join(tmpdir(),'guarded-claim-'));
  work=join(root,'work');
  env={...process.env,XDG_STATE_HOME:join(root,'state'),GIT_AUTHOR_NAME:'fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
  execFileSync('git',['init','-q','--bare','-b','main',join(root,'remote.git')]);
  execFileSync('git',['clone','-q',join(root,'remote.git'),work],{env,stdio:'ignore'});
  ok('git',['commit','--allow-empty','-qm','fixture']);
  ok('git',['push','-q','origin','HEAD:main']);
  ok(process.execPath,[MECHANISM,'connect','--checkout',work,'--recipe',RECIPE,'--prefix','fx','--machine','fixture']);
});
after(()=>rmSync(root,{recursive:true,force:true}));

function leaf(){
  const stage=created(ok('br',['--no-color','create','a stage','-t','epic']));
  const task=created(ok('br',['--no-color','create','a leaf','-t','task','--parent',stage]));
  ok(process.execPath,[MECHANISM,'publish']);
  return task;
}

test('a ready leaf is claimed on the remote: holder and active status both',()=>{
  const task=leaf();
  const r=run(process.execPath,[CLAIM,task,'--actor',actor]);
  assert.equal(r.status,0,r.stderr+r.stdout);
  const there=remoteItem(task);
  assert.equal(there.assignee,actor);
  assert.equal(there.status,'in_progress');
});

test('a held leaf is not ready, and never reaches the mechanism',()=>{
  const task=leaf();
  assert.equal(run(process.execPath,[CLAIM,task,'--actor',actor]).status,0);
  const r=run(process.execPath,[CLAIM,task,'--actor','prime-worker:other@offline:main#test9999']);
  assert.equal(r.status,1,r.stderr);
  assert.match(r.stderr,/not an open, unheld, ready leaf/);
  assert.equal(remoteItem(task).assignee,actor);
});

test('a malformed actor, a duplicate or an unknown option is refused without a claim',()=>{
  const task=leaf();
  for(const args of [[task,'--actor','someone'],[task,'--actor',actor,'--actor',actor],[task,'--actor',actor,'--force','x']]){
    assert.equal(run(process.execPath,[CLAIM,...args]).status,1);
  }
  assert.equal(remoteItem(task).assignee ?? null,null);
});
