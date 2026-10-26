import { createServer } from 'node:net';
import { appendFileSync, rmSync } from 'node:fs';
export default {
 id:'probe-steering',
 async setup(ctx) {
  const socket=process.env.PROBE_STEER_SOCKET;
  const log=entry=>appendFileSync('/out/plugin.jsonl',JSON.stringify({at:new Date().toISOString(),...entry})+'\n');
  await ctx.session.hook('model.request', p=>{p.headers['x-probe-request-kind']=p.kind;log({event:'model.request',sessionID:p.sessionID,kind:p.kind});});
  const dispositions=new Map();const abort=new AbortController();
  void (async()=>{try{for await(const event of ctx.event.subscribe({signal:abort.signal})){if(event.type.startsWith('session.'))log({event:'native-event',native:event});if(event.type==='session.inbox.enqueued')dispositions.set(event.data.inboxID,'pending');if(event.type==='session.inbox.delivered')dispositions.set(event.data.inboxID,'inserted');}}catch(e){if(!abort.signal.aborted)log({event:'observer-error',error:String(e)});}})();
  rmSync(socket,{force:true});
  const server=createServer(s=>{let buf='';s.on('data',d=>{buf+=d;let n;while((n=buf.indexOf('\n'))>=0){const line=buf.slice(0,n);buf=buf.slice(n+1);void (async()=>{let q;try{q=JSON.parse(line);log({event:'command',q});let data;
    if(q.op==='steer') data=await ctx.session.prompt({sessionID:q.sessionID,id:q.id,text:q.text,delivery:'steer',resume:false});
    else if(q.op==='compact') data=await ctx.session.compact({sessionID:q.sessionID,delivery:'steer'});
    else if(q.op==='context') data=await ctx.session.context({sessionID:q.sessionID});
    else if(q.op==='disposition')data={id:q.id,status:dispositions.get(q.id)??'unknown'};
    else data=await ctx.session.get({sessionID:q.sessionID});
    log({event:'reply',op:q.op,data});s.write(JSON.stringify({ok:true,data})+'\n');
   }catch(e){log({event:'error',error:String(e)});s.write(JSON.stringify({ok:false,error:String(e)})+'\n');}})();}});});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
  log({event:'ready',socket});
  return ()=>{abort.abort();return new Promise(resolve=>server.close(resolve));};
 }
};
