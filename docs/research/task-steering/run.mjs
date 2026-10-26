import {spawn} from 'node:child_process';
import {connect} from 'node:net';
import {mkdirSync,writeFileSync,readFileSync,existsSync,appendFileSync} from 'node:fs';
import {AcpConnection,prepareWorkspace,agentEnv} from '/previous/raw-acp-driver.mjs';
import {CANDIDATES} from '/previous/probe-agents.mjs';
import {createTaskModelRelay} from '/opt/lifemodel/loader/dist/task-model-relay.js';
import {configureAgent} from '/opt/lifemodel/loader/dist/task-opencode.js';
import {startStub} from './stub.mjs';
const [agent,scenario]=process.argv.slice(2); const work='/work/probe'; prepareWorkspace(work);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const record=x=>appendFileSync('/out/driver-events.jsonl',JSON.stringify({at:new Date().toISOString(),...x})+'\n');
let seq=0;
async function socketCall(socket,command,prime=false) {
 const id=prime&&command.type==='steer'&&scenario==='duplicate'?'lost-ack-stable-id':`native-${++seq}`;
 const q=prime?{type:'command',id,protocol:{name:'prime-agent.daemon',version:7},command}:command;
 record({event:'native-send',q});
 return new Promise((resolve,reject)=>{let buf='';const s=connect(socket);const timer=setTimeout(()=>{s.destroy();reject(Error('native timeout'));},30000);
 s.once('error',e=>{clearTimeout(timer);reject(e);});s.once('connect',()=>s.write(JSON.stringify(q)+'\n'));
 s.on('data',d=>{buf+=d;let n;while((n=buf.indexOf('\n'))>=0){const v=JSON.parse(buf.slice(0,n));buf=buf.slice(n+1);record({event:'native-receive',v:v.type==='daemon_hello'?{type:v.type,protocol:v.protocol,appVersion:v.appVersion,schemaRevision:v.schemaRevision,runtime:v.runtime,supervisorPid:v.supervisorPid}:v});if(!prime||v.id===id){clearTimeout(timer);s.end();resolve(v);}}});});
}
let activeSessionId,sessionID,c,relay,stub,steerPromise;let admissionCount=0;const admissions=[];
const socket=agent==='opencode'?work+'/tmp/steer.sock':work+'/tmp/daemon.sock';
async function steer(){
 ++admissionCount; const command=agent==='opencode'?{op:'steer',sessionID,id:'msg_steer_unique_6539',text:'STEER_UNIQUE_6539: use the native input queue.'}:{type:'steer',activeSessionId,message:'STEER_UNIQUE_6539: use the native input queue.'};
 const receipt=await socketCall(socket,command,agent==='prime-agent');admissions.push(receipt);record({event:'steer-ack',receipt});return receipt;
}
try {
 relay=await createTaskModelRelay({modelEndpoint:'https://127.0.0.1:8443',modelTokenFile:'/certs/token',modelCaFile:'/certs/stub.crt',timeoutMs:120000});
 let candidate;
 if(agent==='opencode') candidate={label:agent,command:'/usr/local/bin/opencode',args:['acp'],configure:()=>({...configureAgent({workDirectory:work,configFile:'/etc/lifemodel/opencode.json',relayBaseURL:relay.baseURL}),PROBE_STEER_SOCKET:socket,
 OPENCODE_CONFIG_CONTENT:JSON.stringify({model:'lifemodel/task',plugins:['-opencode.browser','/opt/probe/steering-plugin'],providers:{lifemodel:{name:'Probe',package:'@opencode/ai/providers/openai-compatible',settings:{baseURL:relay.baseURL,apiKey:'probe-placeholder'},models:{task:{name:'Probe',capabilities:{tools:true,input:['text'],output:['text']},limit:{context:128000,output:4096},cost:{input:0,output:0}}}}}})})};
 else candidate=CANDIDATES['prime-agent'];
 const env=agentEnv(candidate,{baseURL:relay.baseURL,workDirectory:work});
 if(agent==='prime-agent'&&scenario==='compact') {
  const config=JSON.parse(readFileSync(work+'/home/.prime/agent/models.json'));config.providers.probe.models[0].contextWindow=32768;writeFileSync(work+'/home/.prime/agent/models.json',JSON.stringify(config));
  const sf=work+'/home/.prime/agent/settings.json';const settings=JSON.parse(readFileSync(sf));settings.compaction={enabled:true,reserveTokens:1024,keepRecentTokens:100,thresholdPercent:50};writeFileSync(sf,JSON.stringify(settings));
 }
 stub=await startStub({scenario,agent,onFinal:async()=>{record({event:'final-content-sent'});await steer();},onRequest:async entry=>{
  record({event:'model-request',n:entry.n,kind:entry.kind});
  if(scenario==='race'&&entry.kind==='primary'&&entry.n===1){await steer();}
  if(scenario==='compact'&&agent==='opencode'&&entry.kind==='primary'&&entry.n===2)await socketCall(socket,{op:'compact',sessionID});
 }});
 c=new AcpConnection({candidate,env,workDirectory:work,transcript:'/out/acp.jsonl',timeoutMs:120000});
 await c.start();const init=await c.request('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'native-steering-probe',version:'1'}});
 const session=await c.request('session/new',{cwd:work,mcpServers:[]});sessionID=session.sessionId;
 record({event:'session',init,session});
 if(agent==='prime-agent') {
  const list=await socketCall(socket,{type:'list',includeClientOwned:true},true);writeFileSync('/out/list.json',JSON.stringify(list,null,2));
  const sessions=list.data?.sessions??list.sessions??list.data;
  if(!Array.isArray(sessions))throw Error('list shape:'+JSON.stringify(list));
  if(sessions.length!==1)throw Error('ambiguous sessions');activeSessionId=sessions[0].activeSessionId;
  if(!activeSessionId)throw Error('no activeSessionId');
 }
 let toolWatcher;
 if(!['race','late','tail'].includes(scenario)) toolWatcher=(async()=>{
  const deadline=Date.now()+45000;while(!existsSync(work+'/start-0')){if(Date.now()>deadline)throw Error('tool never started');await pause(50);}
  record({event:'tool-start-marker'});await pause(500);
  const before=Date.now();await steer();if(scenario==='duplicate')await steer();
  // Compaction is requested after the steer user row has entered primary context.
  const state=agent==='prime-agent'?await socketCall(socket,{type:'get_state',activeSessionId},true):await socketCall(socket,{op:'disposition',sessionID,id:'msg_steer_unique_6539'});
  writeFileSync('/out/during-tool-state.json',JSON.stringify(state,null,2));
  record({event:'admitted-during-tool',elapsed:Date.now()-before,done0:existsSync(work+'/done-0'),done1:existsSync(work+'/done-1')});
 })();
 const started=Date.now();record({event:'acp-prompt-start',turn:1});
 const first=await c.request('session/prompt',{sessionId:sessionID,prompt:[{type:'text',text:'PROBE_TASK: run the offered shell tools and finish. Do not launch children.'+(scenario==='compact'&&agent==='prime-agent'?'\nPROBE_PADDING '+('padding '.repeat(15000)):'')}]});
 record({event:'acp-prompt-end',turn:1,result:first,elapsed:Date.now()-started});
 await toolWatcher;
 if(scenario==='late')await steer();
 // No manual Prime compact here: it aborts active execution or runs an auxiliary request outside the ACP turn.
 const requestsAtEnd=stub.requests.length;
 await pause(2000);const requestsAfterObservation=stub.requests.length;record({event:'observer',requestsAtEnd,requestsAfter:requestsAfterObservation});
 if(agent==='opencode'){const disposition=await socketCall(socket,{op:'disposition',sessionID,id:'msg_steer_unique_6539'});writeFileSync('/out/disposition.json',JSON.stringify(disposition,null,2));}
 const inspect=agent==='opencode'?await socketCall(socket,{op:'context',sessionID}):await socketCall(socket,{type:'get_state',activeSessionId},true);
 writeFileSync('/out/native-state.json',JSON.stringify(inspect,null,2));
 if(agent==='prime-agent'){const history=await socketCall(socket,{type:'get_messages',activeSessionId},true);writeFileSync('/out/native-history.json',JSON.stringify(history,null,2));const queue=await socketCall(socket,{type:'get_queue',activeSessionId},true);writeFileSync('/out/native-queue.json',JSON.stringify(queue,null,2));const connection=await socketCall(socket,{type:'get_connection_state',activeSessionId},true);writeFileSync('/out/native-connection.json',JSON.stringify(connection,null,2));}
 if(scenario==='duplicate'){await steer();await pause(1000);record({event:'duplicate-after-promotion',requests:stub.requests.length});if(agent==='opencode'){record({event:'acp-prompt-start',turn:2});const continued=await c.request('session/prompt',{sessionId:sessionID,prompt:[{type:'text',text:'Continue with already admitted input; do not repeat it.'}]});record({event:'acp-prompt-end',turn:2,result:continued});await pause(1000);const after=await socketCall(socket,{op:'context',sessionID});writeFileSync('/out/after-retry-context.json',JSON.stringify(after,null,2));}}
 if(['race','late','tail','compact'].includes(scenario)) {
  record({event:'acp-prompt-start',turn:2});
  const second=await c.request('session/prompt',{sessionId:sessionID,prompt:[{type:'text',text:'Continue with any already queued input; no steering text is resubmitted.'}]});
  record({event:'acp-prompt-end',turn:2,result:second});await pause(1000);
 }
 const result={agent,scenario,sessionID,activeSessionId,first,admissionCount,admissions,requestsAtEnd,requestsAfterObservation,totalRequests:stub.requests.length,done0:existsSync(work+'/done-0'),done1:existsSync(work+'/done-1')};
 writeFileSync('/out/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));c.promptSettled=true;
} catch(e) {record({event:'error',error:String(e),stack:e.stack});writeFileSync('/out/error.txt',String(e));process.exitCode=1;}
finally {
 if(c){writeFileSync('/out/stderr.txt',c.stderr);await c.close();}
 if(agent==='prime-agent'&&existsSync(socket))try{await socketCall(socket,{type:'shutdown',force:true},true);}catch(e){record({event:'cleanup-error',error:String(e)});}
 await relay?.close();await stub?.close();
}
