import {createServer} from 'node:https';
import {readFileSync,appendFileSync} from 'node:fs';
const SHELL_NAMES = ['shell', 'bash', 'execute_shell', 'execute_command', 'run_command', 'run_shell', 'container_exec', 'linux_shell', 'exec', 'terminal', 'run_terminal_cmd'];
const COMMAND_KEYS = ['command', 'cmd', 'script', 'input', 'code', 'shell_command'];

/** Pick the agent's own shell tool and build one call that satisfies its schema. */
function toolCallFor(tools, toolCommand) {
  const list = (tools ?? []).filter((t) => t?.function?.name).map((t) => t.function);
  if (!list.length) return undefined;
  const python = list.find(t => t.name === 'python_repl');
  if (python) return {name: python.name, arguments: JSON.stringify({code: `handle = bash(${JSON.stringify(toolCommand)}, yield_after=60)\nresult = await handle\nprint(result.output)\nif result.exit_code != 0: raise RuntimeError(f'Shell exit {result.exit_code}')`})};
  const scored = list.map((fn) => {
    const name = String(fn.name).toLowerCase();
    let score = 0;
    if (SHELL_NAMES.includes(name)) score += 100;
    if (SHELL_NAMES.some((n) => name.includes(n))) score += 40;
    const props = Object.keys(fn.parameters?.properties ?? {}).map((k) => k.toLowerCase());
    if (props.some((k) => COMMAND_KEYS.includes(k))) score += 25;
    if (props.includes('command')) score += 10;
    return { fn, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const chosen = scored[0];
  if (!chosen || chosen.score === 0) return undefined;
  const schema = chosen.fn.parameters ?? { type: 'object', properties: {} };
  const props = schema.properties ?? {};
  const required = schema.required ?? Object.keys(props);
  const args = {};
  for (const key of Object.keys(props)) {
    const lower = key.toLowerCase();
    const type = props[key]?.type;
    if (COMMAND_KEYS.includes(lower) || (lower.endsWith('command') && type === 'string')) args[key] = toolCommand;
    else if (required.includes(key)) {
      if (type === 'string') args[key] = key.toLowerCase().includes('cwd') || lower === 'workdir' ? '/work' : 'probe';
      else if (type === 'number' || type === 'integer') args[key] = 0;
      else if (type === 'boolean') args[key] = false;
      else if (type === 'array') args[key] = [];
      else if (type === 'object') args[key] = {};
    }
  }
  if (!Object.values(args).includes(toolCommand)) {
    const key = Object.keys(props).find((k) => COMMAND_KEYS.includes(k.toLowerCase())) ?? 'command';
    args[key] = toolCommand;
  }
  return { name: chosen.fn.name, arguments: JSON.stringify(args), parameters: props };
}

export async function startStub({scenario,agent,onRequest,onFinal}) {
 const requests=[];let primary=0;let compactionServed=false;
 const log=x=>appendFileSync('/out/model-requests.jsonl',JSON.stringify({at:new Date().toISOString(),...x})+'\n');
 const server=createServer({cert:readFileSync('/certs/stub.crt'),key:readFileSync('/certs/stub.key')},(req,res)=>{
 let raw='';req.on('data',d=>raw+=d);req.on('end',()=>{void (async()=>{
 if(req.url==='/v1/models'){log({method:req.method,url:req.url,body:raw||null});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({object:'list',data:[{id:'task',object:'model'}]}));return;}
 const body=JSON.parse(raw);const hintedKind=req.headers['x-probe-request-kind'];const lastText=JSON.stringify(body.messages?.at(-1)?.content??'');const kind=hintedKind==='compaction'||/You MUST summarize the conversation above|previous response did not fill in|Summarize the conversation|summarize the earlier|conversation below|summarize the following/i.test(lastText)||(body.tools?.length??0)===0?'compaction':'primary';
 const n=kind==='primary'?++primary:primary;const entry={n,kind,body,headers:req.headers};requests.push(entry);log(entry);
 if(primary>12) throw Error('runaway');
 await onRequest?.(entry);
 let calls;
 if(kind==='primary'&&(n===1||(scenario==='compact'&&agent==='prime-agent'&&n===2))&&!['race','late','tail'].includes(scenario)) {
  calls=Array.from({length:scenario==='parallel'?2:1},(_,i)=>{
   const seconds=scenario==='parallel'?(i===0?4:8):n===2?1:20;
   const command=`echo start-${i}; touch /work/probe/start-${i}; sleep ${seconds}; touch /work/probe/done-${i}; echo done-${i}`+(scenario==='compact'&&agent==='prime-agent'?"; python3 -c \"print('RESULT_PADDING ' * 10000)\"":'');
   const call=toolCallFor(body.tools,command);if(!call)throw Error('no tool');
   return {id:`call_probe_${n}_${i}`,type:'function',function:{name:call.name,arguments:call.arguments}};
  });
 }
 const seenSteer=JSON.stringify(body.messages).includes('STEER_UNIQUE_6539');const text=kind==='compaction'?`## Objective\n- Complete the probe.\n\n## Requirements\n- ${seenSteer?'STEER_UNIQUE_6539: use the native input queue.':'No steering in summarizer input.'}\n\n## Decisions\n- Use native queue.\n\n## Work State\n### Completed\n- Shell completed.\n### Active\n- Finish.\n### Blocked\n- (none)\n\n## Next Move\n1. Finish.\n\n## Relevant Files\n- (none)\n\n## Important Context\n- Stub probe.`:'PROBE_FINAL: finished.';
 const highUsage=scenario==='compact'&&kind==='primary'&&!compactionServed;const usage={prompt_tokens:highUsage?30000:100,completion_tokens:20,total_tokens:highUsage?30020:120};if(kind==='compaction')compactionServed=true;
 const message=calls?{role:'assistant',content:null,tool_calls:calls}:{role:'assistant',content:text};
 const reason=calls?'tool_calls':'stop';
 if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'probe',object:'chat.completion',model:body.model,choices:[{index:0,message,finish_reason:reason}],usage}));return;}
 res.writeHead(200,{'content-type':'text/event-stream'});
 const frame=(delta,finish=null)=>res.write('data: '+JSON.stringify({id:'probe',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason:finish}]})+'\n\n');
 if(calls)frame({role:'assistant',tool_calls:calls.map((c,index)=>({index,...c}))});else frame({role:'assistant',content:text});
 if(scenario==='tail'&&kind==='primary'&&n===1){await onFinal?.();}
 frame({},reason);res.write('data: '+JSON.stringify({id:'probe',object:'chat.completion.chunk',model:body.model,choices:[],usage})+'\n\n');
 res.end('data: [DONE]\n\n');log({event:'response-end',n,kind,reason});
 })().catch(e=>{log({error:String(e)});res.writeHead(500);res.end(String(e));});});});
 await new Promise(resolve=>server.listen(8443,'127.0.0.1',resolve));return {requests,close:()=>new Promise(r=>server.close(r))};
}
