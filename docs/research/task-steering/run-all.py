import pathlib,subprocess,sys,json
base=pathlib.Path(__file__).resolve().parent
cases=[(agent,scenario) for agent in ['opencode','prime-agent'] for scenario in ['mid','parallel','compact','duplicate','tail','late']]
for agent,scenario in cases:
 name='final-'+agent+'-'+scenario
 print(name,flush=True)
 code=subprocess.run([sys.executable,str(base/'run-local.py'),agent,scenario,'--name',name]).returncode
 print(name,'exit',code,flush=True)
 if code:raise SystemExit(code)
