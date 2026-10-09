// node --test .backlog/claim.test.mjs (execute inside the test boundary).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const adapter=fileURLToPath(new URL('./claim.mjs',import.meta.url));
const actor='prime-worker:fixture@offline:main#test1234';
function fixture(action){
 const root=mkdtempSync(join(tmpdir(),'guarded-claim-unit-'));
 try{
 const env={...process.env,GIT_AUTHOR_NAME:'fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
 execFileSync('git',['init','-q',root],{env});execFileSync('git',['commit','--allow-empty','-qm','fixture'],{cwd:root,env});
 const rev=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
 const bin=join(root,'bin');mkdirSync(bin);
 const rows=join(root,'issues.jsonl'), calls=join(root,'calls.json');
 const stamp='2026-10-09T16:00:00Z';
 const stage={id:'stage',issue_type:'epic',status:'open'};
 const target={id:'task',issue_type:'task',status:'open',updated_at:stamp,dependencies:[{type:'parent-child',depends_on_id:'stage'}]};
 const producer={id:'producer',issue_type:'task',status:'implemented',dependencies:[{type:'parent-child',depends_on_id:'stage'}],comments:[{id:1,created_at:stamp,text:`implemented: ${rev} -- checked`}]};
 const save=data=>writeFileSync(rows,data.map(r=>JSON.stringify(r)).join('\n')+'\n');
 save([stage,target]);
 writeFileSync(join(bin,'br'),`#!/usr/bin/env node
import fs from 'node:fs';const args=process.argv.slice(2);
if(args[0]==='--version')console.log(process.env.FIXTURE_BR_VERSION||'br 0.7.0');
else if(args[0]==='where')console.log(JSON.stringify({jsonl_path:${JSON.stringify(rows)}}));
else if(args[0]==='sync'){}
else if(args[0]==='update'){fs.writeFileSync(${JSON.stringify(calls)},JSON.stringify(args));console.log('claimed');}
else process.exit(2);
`,{mode:0o755});
 const invoke=(extra=[],override={})=>spawnSync(process.execPath,[adapter,'task','--actor',actor,...extra],{cwd:root,encoding:'utf8',env:{...env,PATH:bin+':'+process.env.PATH,...override}});
 action({stage,target,producer,save,calls,invoke,stamp});
 }finally{rmSync(root,{recursive:true,force:true});}
}
test('ordinary guarded claim supplies native exclusivity and timestamp CAS without force',()=>fixture(({calls,invoke,stamp})=>{
 const r=invoke();assert.equal(r.status,0,r.stderr);const args=JSON.parse(readFileSync(calls));assert.ok(args.includes('--claim'));assert.equal(args[args.indexOf('--actor')+1],actor);assert.equal(args[args.indexOf('--if-unchanged')+1],stamp);assert.ok(!args.includes('--force'));
}));
test('only validated implemented readiness permits the internal advisory override',()=>fixture(({stage,target,producer,save,calls,invoke})=>{
 target.dependencies.push({type:'blocks',depends_on_id:'producer'});save([stage,target,producer]);const r=invoke();assert.equal(r.status,0,r.stderr);assert.ok(JSON.parse(readFileSync(calls)).includes('--force'));
}));
test('held or unready target never reaches native claim',()=>fixture(({stage,target,producer,save,calls,invoke})=>{
 target.assignee='other';save([stage,target]);assert.equal(invoke().status,1);assert.ok(!existsSync(calls));
 target.assignee=null;producer.comments=[];target.dependencies.push({type:'blocks',depends_on_id:'producer'});save([stage,target,producer]);assert.equal(invoke().status,1);assert.ok(!existsSync(calls));
}));
test('manual force, duplicate flags and unsupported br are refused without claim',()=>fixture(({calls,invoke})=>{
 for(const r of [invoke(['--force']),invoke(['--actor',actor]),invoke([],{FIXTURE_BR_VERSION:'br 0.6.0'})])assert.equal(r.status,1,r.stderr);
 assert.ok(!existsSync(calls));
}));
