import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {CANDIDATES} from './probe-agents.mjs';
import {AcpConnection,runRawAcp,prepareWorkspace,agentEnv} from './raw-acp-driver.mjs';
import {createTaskModelRelay} from '/opt/lifemodel/loader/dist/task-model-relay.js';
import {AcpTaskHarness} from '/opt/lifemodel/loader/dist/task-acp.js';
const [label,scenario='success',client='raw']=process.argv.slice(2);
const candidate=CANDIDATES[label];
if(!candidate) throw Error('unknown_candidate');
const out='/out'; const work='/work/probe'; prepareWorkspace(work);
const cmd=scenario==='cancel' ? 'echo $$ > /work/probe/probe-shell-pid; sleep 30 & child=$!; echo $child > /work/probe/probe-child-pid; touch /work/probe/probe-start-marker; wait $child; touch /work/probe/probe-cancel-marker'
 : scenario==='failure' ? 'echo PROBE_SHELL_FAILURE >&2; exit 7'
 : 'echo probe-tool-ok > /work/probe/probe-tool-marker; echo probe-tool-ok';
const stub=spawn('node',['/probe/stub-model-server.mjs'],{env:{PATH:process.env.PATH,PROBE_TLS:'1',
 PROBE_PROVIDER_ERROR:scenario==='provider-error'?'1':'0',PROBE_CERT:'/certs/stub.crt',PROBE_KEY:'/certs/stub.key',PROBE_LOG:out+'/model-requests.jsonl',PROBE_TOOL_COMMAND:cmd,
 PROBE_FINAL_TEXT:scenario==='failure'?'PROBE_FINAL: shell failed.':'PROBE_FINAL: finished.'},stdio:['ignore','ignore','pipe']});
await new Promise((resolve,reject)=>{stub.stderr.once('data',resolve);stub.once('error',reject);});
const options={modelEndpoint:'https://127.0.0.1:8443',modelTokenFile:'/certs/token',modelCaFile:'/certs/stub.crt',timeoutMs:60000};
let relay; let result;
const traced=process.env.PROBE_OUTER_TRACE === '1' ? candidate : {...candidate,command:'strace',args:['-f','-tt','-s','256','-e','trace=connect','-o',out+'/connect.log',candidate.command,...candidate.args]};
try {
 if(client==='real') {
   const events=[];
   const harness=new AcpTaskHarness({...options,workDirectory:work,agent:{...traced,configFile:'/unused'},
     configure:({relayBaseURL})=>candidate.configure({relayBaseURL,workDirectory:work,scenario}),
     onEvent:e=>{events.push(e);if(scenario==='cancel' && e.type==='tool' && e.status==='running')setTimeout(()=>harness.abort(),1000);}});
   result={candidate:label,scenario,client,result:await harness.start({text:'Run the shell command then report.',model:'task'}),events};
 } else {
   relay=await createTaskModelRelay(options);
   const env=agentEnv({...candidate,configure:opts=>candidate.configure({...opts,scenario})},{baseURL:relay.baseURL,workDirectory:work});
   if(scenario==='startup') {
     writeFileSync(out+'/startup.transcript.jsonl','');
     const c=new AcpConnection({candidate:traced,env,workDirectory:work,transcript:out+'/startup.transcript.jsonl',timeoutMs:30000});
     try {await c.start(); const init=await c.request('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'probe',version:'1'}});
       const session=await c.request('session/new',{cwd:work,mcpServers:[]});
       result={candidate:label,scenario,initialize:init,session};c.promptSettled=true; await new Promise(resolve=>setTimeout(resolve,3000));
     } catch(e){result={candidate:label,scenario,error:String(e)};} finally{await c.close();result.stderr=c.stderr;}
   } else result=await runRawAcp({candidate:traced,env,workDirectory:work,outFile:out+'/acp',scenario,toolCommand:cmd,cancelAfterMs:1000});
 }
 writeFileSync(out+'/result.json',JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));
} finally {
 await relay?.close();stub.kill('SIGTERM');
 if(label==='prime-agent') {
   const env=agentEnv(candidate,{baseURL:'http://127.0.0.1:1/v1',workDirectory:work});
   const cleanup=spawn(candidate.command,['shutdown','--force','--json'],{cwd:work,env,stdio:['ignore','pipe','pipe']});
   let text='';cleanup.stdout.on('data',d=>text+=d);cleanup.stderr.on('data',d=>text+=d);
   const timer=setTimeout(()=>cleanup.kill('SIGKILL'),10000);
   const code=await new Promise(resolve=>cleanup.once('exit',resolve));clearTimeout(timer);
   writeFileSync(out+'/cleanup.json',JSON.stringify({code,text})+'\n');
 }
}
