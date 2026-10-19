#!/bin/sh
# Local-only generation, before k3s and on each host DNS change.
# An unchanged desired file is still pending until the verified applied hash
# matches. Never block generation behind k3s startup or network readiness.
set -eu
usage='usage: k3s-resolv.sh GENERATOR TARGET SOURCE [SOURCE...]'
generator=${1:?$usage}
target=${2:?$usage}
shift 2
[ "$#" -gt 0 ] || { printf '%s\n' "$usage" >&2; exit 2; }
change=$(node "$generator" "$target" "$@")
[ -s "$target" ] || { echo 'k3s resolver missing or empty' >&2; exit 1; }
desired=$(node -e 'const fs=require("node:fs"); process.stdout.write(require("node:crypto").createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$target")
marker="$(dirname "$target")/k3s-resolv.applied"
applied=$(cat "$marker" 2>/dev/null || true)
if [ "$change" = changed ] || [ "$desired" != "$applied" ] ||
    ! cmp -s "$(dirname "$target")/k3s-resolv.written" "$(dirname "$target")/k3s-resolv.applied-written"; then
  # restart, not start: start would coalesce with an activating apply and
  # lose an update published after its final hash check. This queues a new job.
  systemctl restart --no-block lifemodel-k3s-dns-apply.service
fi
