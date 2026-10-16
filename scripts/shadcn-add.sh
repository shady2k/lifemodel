#!/usr/bin/env bash
set -euo pipefail
mode=write
if [[ ${1:-} == --check ]]; then mode=check; shift; fi
if (($# == 0)); then echo "usage: scripts/shadcn-add.sh [--check] <registry-item>..." >&2; exit 2; fi
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
( cd "$tmp" && npx -y shadcn@4.21.5 init -t vite -b radix -p nova -n web --no-monorepo -y </dev/null )
project="$tmp/web"
node - "$project/components.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
config.aliases = { components: '@kit/components', utils: '@kit/lib/utils', ui: '@kit/components/ui', lib: '@kit/lib', hooks: '@kit/hooks' };
config.tailwind.css = 'src/index.css';
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
for (const name of ['tsconfig.json', 'tsconfig.app.json']) {
  const target = require('node:path').join(require('node:path').dirname(file), name);
  if (!fs.existsSync(target)) continue;
  const source = fs.readFileSync(target, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
  const tsconfig = JSON.parse(source);
  tsconfig.compilerOptions ??= {};
  tsconfig.compilerOptions.paths ??= {};
  tsconfig.compilerOptions.paths['@kit/*'] = ['./src/*'];
  fs.writeFileSync(target, JSON.stringify(tsconfig, null, 2) + '\n');
}
NODE
( cd "$project" && npx -y shadcn@4.21.5 add -y "$@" </dev/null )
lock="$tmp/registry-lock/files"
mkdir -p "$lock"
while IFS= read -r -d '' file; do
  rel="${file#"$project/src/"}"
  mkdir -p "$lock/$(dirname "$rel")"
  cp "$file" "$lock/$rel"
done < <(find "$project/src/components/ui" "$project/src/hooks" "$project/src/lib" -type f -print0)
node - "$lock" "$@" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dir = process.argv[2];
const items = process.argv.slice(3);
const files = [];
function walk(base) { for (const entry of fs.readdirSync(base, { withFileTypes: true })) { const file = path.join(base, entry.name); if (entry.isDirectory()) walk(file); else { const relative = path.relative(dir, file).split(path.sep).join('/'); files.push({ path: relative, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }); } } }
walk(dir); files.sort((a,b) => a.path.localeCompare(b.path));
fs.writeFileSync(path.join(path.dirname(dir), 'manifest.json'), JSON.stringify({ cli: 'shadcn@4.21.5', init: 'npx -y shadcn@4.21.5 init -t vite -b radix -p nova -n web --no-monorepo -y', items, files }, null, 2) + '\n');
NODE
if [[ "$mode" == check ]]; then
  diff -ru "$root/web/kit/registry-lock/files" "$lock"
  diff -u "$root/web/kit/registry-lock/manifest.json" "$tmp/registry-lock/manifest.json"
  while IFS= read -r -d '' file; do rel="${file#"$lock/"}"; diff -u "$file" "$root/web/kit/$rel"; done < <(find "$lock" -type f -print0)
else
  rm -rf "$root/web/kit/registry-lock/files"
  cp -R "$lock" "$root/web/kit/registry-lock/files"
  cp "$tmp/registry-lock/manifest.json" "$root/web/kit/registry-lock/manifest.json"
  while IFS= read -r -d '' file; do rel="${file#"$project/src/"}"; mkdir -p "$root/web/kit/$(dirname "$rel")"; cp "$file" "$root/web/kit/$rel"; done < <(find "$project/src/components/ui" "$project/src/hooks" "$project/src/lib" -type f -print0)
fi
