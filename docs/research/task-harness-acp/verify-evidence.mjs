/** Verify the retained observations, including expected candidate failures. */
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
const base=new URL('./evidence/',import.meta.url);
const read=(path)=>JSON.parse(readFileSync(new URL(path,base),'utf8'));
const run=(name)=>read(name+'/result.json');
const frames=name=>readFileSync(new URL(name+'/acp.transcript.jsonl',base),'utf8').trim().split('\n').map(JSON.parse);
const goose=run('goose-musl-cancel-raw'),prime=run('prime-agent-cancel-raw');
for(const result of [goose,prime]) {
 assert.equal(result.stopReason,'cancelled');
 assert.equal(result.liveAtCancel.startMarker,true);
 assert.equal(result.liveAtCancel.shellAlive,true);assert.equal(result.liveAtCancel.childAlive,true);
 assert.equal(result.shellAliveAtPromptReturn,false);
 assert.equal(result.completionMarker,false);
 assert.ok(result.cancelSentAfterMs < result.durationMs);
}
assert.equal(goose.childAliveAtPromptReturn,true);
assert.equal(goose.childAliveTwoSecondsAfterReturn,true);
assert.match(goose.childStatTwoSecondsAfterReturn,/\(sleep\) S 1 /);
assert.equal(prime.childAliveAtPromptReturn,false);
assert.equal(prime.childAliveTwoSecondsAfterReturn,false);
assert.ok(prime.toolCallStatuses.includes('tool_call_update:failed'));
for(const candidate of ['goose-musl','prime-agent']) {
 assert.equal(run(candidate+'-success-raw').markerCreated,true);
 assert.equal(run(candidate+'-success-real').result.outcome,'succeeded');
 assert.equal(run(candidate+'-failure-real').result.outcome,'succeeded'); // existing final-prose recovery policy
 assert.equal(run(candidate+'-provider-error-real').result.reasonCode,'provider_error');
 const cancel=frames(candidate+'-cancel-raw');
 assert.equal(cancel.filter(f=>f.dir==='out' && f.message.method==='session/cancel').length,1);
}
assert.ok(run('goose-musl-failure-raw').toolCallStatuses.includes('tool_call_update:failed'));
assert.ok(run('prime-agent-failure-raw').toolCallStatuses.includes('tool_call_update:completed'));
const primeFailure=frames('prime-agent-failure-raw').find(f=>f.message.params?.update?.sessionUpdate==='tool_call_update').message.params.update;
assert.match(JSON.stringify(primeFailure.content),/RuntimeError: Shell exit 7/);
assert.equal(primeFailure.rawOutput,undefined);
assert.equal(run('goose-musl-provider-error-raw').stopReason,'end_turn');
assert.match(run('prime-agent-provider-error-raw').error,/rpc_error/);
assert.equal(run('goose-musl-permission-raw').markerCreated,false);
assert.equal(run('goose-musl-permission-allow-raw').markerCreated,true);
assert.equal(run('goose-musl-permission-raw').permissionRequests.length,1);
assert.equal(run('prime-agent-permission-raw').permissionRequests.length,0);
const network=read('network-summary.json');
assert.equal(network['goose-startup-raw'].nonLoopbackConnectCalls,4);
for(const [name,result] of Object.entries(network)) if(name!=='goose-startup-raw')assert.equal(result.nonLoopbackConnectCalls,0,name);
assert.equal(network['prime-agent-startup-raw'].inetConnectCalls,0);
const startup=readFileSync(new URL('prime-agent-startup-raw/startup.transcript.jsonl',base),'utf8').trim().split('\n').map(JSON.parse);
assert.equal(startup.filter(f=>f.dir==='out' && f.message.method==='initialize').length,1);
assert.equal(startup.find(f=>f.dir==='in' && f.message.id===2).message.result.sessionId,run('prime-agent-startup-raw').session.sessionId);
for(const [name] of Object.entries(read('summary.json'))) {
 const exit=readFileSync(new URL(name+'/exit-code.txt',base),'utf8').trim();assert.equal(exit,'0',name);
}
console.log('PASS: 21 retained run receipts; expected startup, cancellation, tool-status and permission failures reproduced.');
