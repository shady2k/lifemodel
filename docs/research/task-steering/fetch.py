import pathlib,urllib.request,hashlib,json,tarfile
base=pathlib.Path(__file__).resolve().parent
pins=json.loads((base.parent/'task-harness-acp/pins.json').read_text())
pin=pins['prime-agent']
a=base/'artifacts/prime-agent.tar.gz'
with urllib.request.urlopen(pin['url'],timeout=180) as r:a.write_bytes(r.read())
assert hashlib.sha256(a.read_bytes()).hexdigest()==pin['sha256']
with tarfile.open(a) as t:t.extractall(base/'artifacts/prime-agent',filter='data')
url='https://codeload.github.com/anomalyco/opencode/tar.gz/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824'
a=base/'artifacts/opencode-source.tar.gz'
with urllib.request.urlopen(url,timeout=180) as r:a.write_bytes(r.read())
with tarfile.open(a) as t:t.extractall(base/'artifacts',filter='data')
print('prime-agent pin verified; OpenCode source downloaded')
