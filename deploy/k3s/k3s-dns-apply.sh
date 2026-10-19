#!/bin/sh
# Reconcile pending resolver content after k3s is ready. Failure leaves the
# applied marker untouched; systemd retries, including across startup races.
set -eu
target=${1:?usage: k3s-dns-apply.sh TARGET}
[ -s "$target" ] || { echo 'k3s resolver missing or empty' >&2; exit 1; }
marker="$(dirname "$target")/k3s-resolv.applied"
snapshot="$target.apply.$$.tmp"
pod="$target.pod.$$.tmp"
trap 'rm -f "$snapshot" "$pod" "$marker.$$.tmp"' EXIT HUP INT TERM
cp "$target" "$snapshot"
hash() {
  node -e 'const fs=require("node:fs"); process.stdout.write(require("node:crypto").createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$1"
}
desired=$(hash "$snapshot")
applied=$(cat "$marker" 2>/dev/null || true)
[ "$desired" != "$applied" ] || exit 0
kubectl() {
  k3s kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml --request-timeout=10s "$@"
}
# Eleven requests of at most 10s, ten pauses of 1s: about 120s maximum.
ready=0
attempt=0
while [ "$attempt" -lt 11 ]; do
  attempt=$((attempt + 1))
  if kubectl get --raw=/readyz >/dev/null 2>&1; then ready=1; break; fi
  [ "$attempt" -eq 11 ] || sleep 1
done
[ "$ready" -eq 1 ] || { echo 'k3s API readiness deadline exceeded' >&2; exit 1; }
kubectl rollout restart deploy/coredns -n kube-system
kubectl rollout status deploy/coredns -n kube-system --timeout=90s
kubectl -n kube-system exec deploy/coredns -- cat /etc/resolv.conf > "$pod"
# Search domains are kubelet policy; the upstream nameservers must match in
# order and count. No marker may be committed before this verification.
node -e '
const fs = require("node:fs");
const servers = path => fs.readFileSync(path, "utf8").split("\n")
  .map(line => line.trim().split(/\s+/)).filter(fields => fields[0] === "nameserver")
  .map(fields => fields[1]);
if (JSON.stringify(servers(process.argv[1])) !== JSON.stringify(servers(process.argv[2]))) {
  console.error("CoreDNS resolver does not match desired nameservers"); process.exit(1);
}' "$snapshot" "$pod"
# A concurrent generator may have published newer desired content while the
# rollout was running. Fail for retry rather than lose that pending update.
[ "$(hash "$target")" = "$desired" ] || { echo 'resolver changed during apply' >&2; exit 1; }
printf '%s\n' "$desired" > "$marker.$$.tmp"
mv "$marker.$$.tmp" "$marker"
