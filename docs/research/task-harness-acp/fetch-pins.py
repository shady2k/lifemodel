"""Fetch/verify immutable probe pins. Run from any cwd with Python 3.12+."""
import hashlib, json, pathlib, tarfile, urllib.request
base=pathlib.Path(__file__).resolve().parent
pins=json.loads((base/'pins.json').read_text())
artifacts=base/'artifacts'; artifacts.mkdir(exist_ok=True)
for name,pin in pins.items():
 archive=artifacts/f'{name}.tar.gz'
 if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest()!=pin['sha256']:
  with urllib.request.urlopen(pin['url'],timeout=1800) as response, archive.open('wb') as out:
   while chunk:=response.read(1024*1024): out.write(chunk)
 assert hashlib.sha256(archive.read_bytes()).hexdigest()==pin['sha256'], f'checksum mismatch: {name}'
 with tarfile.open(archive) as tar: tar.extractall(artifacts/name,filter='data')
 print(f'{name} {pin["version"]} {pin["sha256"]}')
