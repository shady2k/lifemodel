"""Copy only final runs, preserve raw stub requests, and make a small index.
Run after run-all.py finishes. No owner paths or settings are read.
"""
from pathlib import Path
import json,shutil,hashlib
base=Path(__file__).resolve().parent
out=base/'evidence'
summary={}
for d in sorted((base/'runs').glob('final-*')):
    assert (d/'exit-code.txt').read_text().strip()=='0',d
    target=out/d.name.removeprefix('final-')
    target.mkdir(exist_ok=False)
    for name in ['command.txt','exit-code.txt','model-requests.jsonl','acp.jsonl','driver-events.jsonl','result.json','connect.log','during-tool-state.json','after-retry-context.json','native-state.json','native-history.json','native-queue.json','native-connection.json','disposition.json','plugin.jsonl','stderr.txt']:
        if (d/name).exists():shutil.copyfile(d/name,target/name)
    entries=[json.loads(s) for s in (target/'model-requests.jsonl').read_text().splitlines()]
    requests=[e for e in entries if isinstance(e.get('body'),dict)]
    result=json.loads((target/'result.json').read_text())
    events=[json.loads(s) for s in (target/'driver-events.jsonl').read_text().splitlines()]
    summary[target.name]={'result':result,'requests':[{'at':e['at'],'kind':e['kind'],'n':e['n'],'roles':[m['role'] for m in e['body']['messages']],'steerOccurrences':sum(str(m.get('content')).count('STEER_UNIQUE_6539') for m in e['body']['messages'])} for e in requests],'timeline':[e for e in events if e['event'] in ['acp-prompt-start','acp-prompt-end','model-request','observer','steer-ack','final-content-sent','admitted-during-tool','duplicate-after-promotion']]}
(out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
manifest={str(f.relative_to(base)):hashlib.sha256(f.read_bytes()).hexdigest() for f in out.rglob('*') if f.is_file() and f.name!='sha256.json'}
manifest.update({str(f.relative_to(base)):hashlib.sha256(f.read_bytes()).hexdigest() for f in list(base.glob('*.mjs'))+list(base.glob('*.py'))+[base/'plugin/index.mjs',base/'plugin/package.json',base/'Dockerfile.probe',base/'pins.json']})
for name in ['raw-acp-driver.mjs','probe-agents.mjs','Dockerfile.probe','pins.json']:
    f=base.parent/'task-harness-acp'/name
    manifest['../task-harness-acp/'+name]=hashlib.sha256(f.read_bytes()).hexdigest()
(out/'sha256.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Collected',len(summary),'final runs')
