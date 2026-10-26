"""Reproduce a probe from the repository root. No credentials are read.
Prerequisites: stock workbench built; verified archives extracted under artifacts/;
prime overlay built for prime-agent. All runtime runs have --network none.
"""
import argparse, pathlib, subprocess
p=argparse.ArgumentParser()
p.add_argument('candidate', choices=['goose','goose-musl','prime-agent'])
p.add_argument('scenario', choices=['startup','success','failure','cancel','permission','permission-allow','provider-error'])
p.add_argument('--client', choices=['raw','real'], default='raw')
a=p.parse_args()
base=pathlib.Path(__file__).resolve().parent
out=base/'runs'/f'{a.candidate}-{a.scenario}-{a.client}'
if out.exists() and any(out.iterdir()):
 raise SystemExit(f'Refusing to mix evidence in {out}; move the old directory aside first.')
out.mkdir(parents=True,exist_ok=True);out.chmod(0o777)
args=['lifemodel-heavy','timeout','--signal=TERM','--kill-after=10s','150s','docker','run','--rm','--name',f'probe-6539-{a.candidate}-{a.scenario}-{a.client}',
'--label','com.lifemodel.probe=6539','-e','PROBE_OUTER_TRACE=1','--network','none','--cpus','1','--memory','1g','--pids-limit','256',
'-v',f'{base}:/probe:ro','-v',f'{out}:/out','-v',f'{base}/artifacts:/certs:ro']
if a.candidate.startswith('goose'):
 args+=['-v',f'{base}/artifacts/{a.candidate}:/opt/probe/goose:ro']
image='probe-6539/prime:0.10.1' if a.candidate=='prime-agent' else 'probe-6539/workbench:stock'
args+=['--entrypoint','strace',image,'-f','-tt','-s','256','-e','trace=connect','-o','/out/all-connect.log','node','/probe/run-probe.mjs','goose' if a.candidate.startswith('goose') else a.candidate,a.scenario,a.client]
(out/'command.txt').write_text(' '.join(args)+'\n')
code=1
try:
 with (out/'driver.log').open('w') as log:
  result=subprocess.run(args,stdout=log,stderr=subprocess.STDOUT,timeout=1800)
  code=result.returncode
finally:
 if code:
  subprocess.run(['docker','rm','-f',f'probe-6539-{a.candidate}-{a.scenario}-{a.client}'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
 (out/'exit-code.txt').write_text(str(code)+'\n')
raise SystemExit(code)
