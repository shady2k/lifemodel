"""Bounded, serialized, network-none runtime probe. Run from repository root."""
import argparse,pathlib,subprocess
p=argparse.ArgumentParser();p.add_argument('agent',choices=['opencode','prime-agent']);p.add_argument('scenario',choices=['mid','parallel','compact','duplicate','race','late','tail']);p.add_argument('--name');a=p.parse_args()
b=pathlib.Path(__file__).resolve().parent;out=b/'runs'/(a.name or f'{a.agent}-{a.scenario}')
if out.exists() and any(out.iterdir()):raise SystemExit('Nonempty evidence directory refused')
out.mkdir(parents=True,exist_ok=True);out.chmod(0o777)
name='probe-6539-2-'+(a.name or f'{a.agent}-{a.scenario}')
args=['lifemodel-heavy','timeout','--signal=TERM','--kill-after=10s','180s','docker','run','--rm','--name',name,'--label','com.lifemodel.probe=6539-2','--network','none','--cpus','1','--memory','1g','--pids-limit','256','-v',f'{b}:/probe:ro','-v',f'{b.parent}/task-harness-acp:/previous:ro','-v',f'{out}:/out','-v',f'{b}/artifacts:/certs:ro','--entrypoint','strace','probe-6539-2/steering:probe','-f','-tt','-s','256','-e','trace=connect','-o','/out/connect.log','node','/probe/run.mjs',a.agent,a.scenario]
(out/'command.txt').write_text(' '.join(args)+'\n')
code=1
try:
 with (out/'driver.log').open('w') as f:code=subprocess.run(args,stdout=f,stderr=subprocess.STDOUT,timeout=1800).returncode
finally:
 if code:subprocess.run(['docker','rm','-f',name],capture_output=True,timeout=20)
 (out/'exit-code.txt').write_text(str(code)+'\n')
raise SystemExit(code)
