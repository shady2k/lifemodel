import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
const base=dirname(fileURLToPath(import.meta.url));const evidence=join(base,'evidence');
const json=p=>JSON.parse(readFileSync(p,'utf8'));const lines=p=>readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
const marker='STEER_UNIQUE_6539';let count=0;
for(const agent of ['opencode','prime-agent'])for(const scenario of ['mid','parallel','compact','duplicate','tail','late']){
 const dir=join(evidence,`${agent}-${scenario}`);const r=json(join(dir,'result.json'));const ev=lines(join(dir,'driver-events.jsonl'));const acp=lines(join(dir,'acp.jsonl'));
 const req=lines(join(dir,'model-requests.jsonl')).filter(e=>e.body&&typeof e.body==='object');const primary=req.filter(e=>e.kind==='primary');
 const content=m=>typeof m.content==='string'?m.content:JSON.stringify(m.content??'');
 const occurrences=entry=>entry.body.messages.reduce((n,m)=>n+content(m).split(marker).length-1,0);
 assert.equal(readFileSync(join(dir,'exit-code.txt'),'utf8').trim(),'0');
 assert(acp.some(e=>e.message.method==='initialize'));assert(acp.some(e=>e.message.method==='session/new'));
 assert(!acp.some(e=>e.message.method==='session/cancel'));assert.equal(r.first.stopReason,'end_turn');
 assert(req.every(e=>e.headers['x-lifemodel-task-token']==='probe-placeholder-only'));
 assert(acp.filter(e=>e.message.method==='session/prompt').every(e=>!JSON.stringify(e.message.params).includes(marker)));
 const starts=ev.filter(e=>e.event==='acp-prompt-start');const ends=ev.filter(e=>e.event==='acp-prompt-end');
 const withinTurn=at=>starts.some((s,i)=>at>=s.at&&at<=ends[i].at);
 const expectedOutside=agent==='prime-agent'&&['late','duplicate'].includes(scenario)?1:0;
 assert.equal(req.filter(e=>!withinTurn(e.at)).length,expectedOutside,'all observed request starts must match expected ACP ownership');
 const responseEnds=lines(join(dir,'model-requests.jsonl')).filter(e=>e.event==='response-end');
 assert.equal(responseEnds.filter(e=>!withinTurn(e.at)).length,expectedOutside,'all observed response ends must match expected ACP ownership');
 for(const frame of acp){const u=frame.message.params?.update;if(['tool_call','tool_call_update'].includes(u?.sessionUpdate))assert(withinTurn(frame.at),'tool update outside observed prompt');}
 const firstEnd=ends[0].at,secondStart=starts[1]?.at;
 const outside=req.filter(e=>e.at>firstEnd&&(!secondStart||e.at<secondStart));
 if(agent==='opencode'||!['late','duplicate'].includes(scenario))assert.equal(outside.length,0,`${agent}/${scenario} unobserved run`);
 else assert.equal(outside.length,1,'Prime idle steer must expose the known observer failure');
 if(['mid','parallel','duplicate','compact'].includes(scenario)){
  const admitted=ev.find(e=>e.event==='admitted-during-tool');assert(admitted);assert.equal(admitted.done0,false);assert(r.done0);
  const next=primary[1].body.messages;const steer=next.findIndex(m=>m.role==='user'&&content(m).includes(marker));assert(steer>=0);
  if(scenario!=='compact'){
   const tools=next.map((m,i)=>[m,i]).filter(([m])=>m.role==='tool');
   assert.equal(tools.length,scenario==='parallel'?2:1);assert(tools.every(([m,i])=>i<steer&&content(m).includes('done-')));
  }
  if(scenario==='mid')assert(new Date(ends[0].at)-new Date(starts[0].at)>=20000);
  if(scenario==='parallel'){assert(r.done1);assert.equal(occurrences(primary[1]),1);}
 }
 if(scenario==='duplicate'){
  assert.equal(r.admissionCount,3); // two pending submissions, then retry after promotion
  assert.equal(occurrences(primary[1]),agent==='opencode'?1:2);
  if(agent==='opencode'){assert.equal(r.totalRequests,3);assert.equal(occurrences(primary[2]),1);const context=json(join(dir,'after-retry-context.json')).data;assert.equal(context.filter(m=>m.id==='msg_steer_unique_6539').length,1);}
  else {assert.equal(occurrences(primary.at(-1)),3);assert(r.totalRequests>2);}
 }
 if(scenario==='compact'){
  assert(req.some(e=>e.kind==='compaction'&&JSON.stringify(e.body.messages).includes(marker)),'steer missing from compaction input');
  assert(occurrences(primary.at(-1))>=1,'steer missing after compaction');
  if(agent==='opencode')assert(json(join(dir,'native-state.json')).data.some(m=>m.type==='compaction'&&m.status==='completed'));
  else assert(json(join(dir,'native-connection.json')).data.compactionCount>=2);
 }
 if(scenario==='late'){
  assert.equal(occurrences(primary[0]),0);assert.equal(occurrences(primary[1]),1);
  if(agent==='opencode')assert.equal(json(join(dir,'disposition.json')).data.status,'pending');
 }
 if(scenario==='tail'){
  const final=ev.find(e=>e.event==='final-content-sent');const ack=ev.find(e=>e.event==='steer-ack');assert(final&&ack);assert(final.at<=ack.at&&ack.at<firstEnd);
  assert(ev.some(e=>e.event==='final-content-sent'));assert.equal(occurrences(primary[1]),1);assert(primary[1].at<firstEnd);
 }
 // Every IPv4 connect remains loopback. Network-none prevents outside routing.
 const connects=readFileSync(join(dir,'connect.log'),'utf8').split('\n').filter(s=>s.includes('sa_family=AF_INET'));
 assert(connects.every(s=>s.includes('inet_addr("127.0.0.1")')),`${agent}/${scenario} outside connect`);
 count++;
}
const manifest=json(join(evidence,'sha256.json'));
for(const [path,sha] of Object.entries(manifest))assert.equal(createHash('sha256').update(readFileSync(join(base,path))).digest('hex'),sha,path);
console.log(`Verified ${count} retained runs, ordering, receipts, compaction, duplicate behavior, ACP boundary, and hashes. Prime late observer failure is required negative evidence, not a pass.`);
