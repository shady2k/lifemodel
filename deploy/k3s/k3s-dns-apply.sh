#!/bin/sh
# Reconcile pending resolver content after k3s is ready. Failure leaves the
# applied marker untouched; systemd retries, including across startup races.
set -eu
target=${1:?usage: k3s-dns-apply.sh TARGET}
[ -s "$target" ] || { echo 'k3s resolver missing or empty' >&2; exit 1; }
marker="$(dirname "$target")/k3s-resolv.applied"
applied_written="$(dirname "$target")/k3s-resolv.applied-written"
snapshot="$target.apply.$$.tmp"
pod="$target.pod.$$.tmp"
deployment="$target.deployment.$$.tmp"
written="$(dirname "$target")/k3s-resolv.written"
written_snapshot="$target.written.$$.tmp"
trap 'rm -f "$snapshot" "$pod" "$deployment" "$written_snapshot" "$marker.$$.tmp" "$applied_written.$$.tmp"' EXIT HUP INT TERM
cp "$target" "$snapshot"
cp "$written" "$written_snapshot"
hash() {
  node -e 'const fs=require("node:fs"); process.stdout.write(require("node:crypto").createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$1"
}
desired=$(hash "$snapshot")
applied=$(cat "$marker" 2>/dev/null || true)
# A hash alone is insufficient for A -> B -> A after an interrupted B rollout.
# Validate and compare the publication identity too, not an old proof of A.
node -e '
const record = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
if (record.sha256 !== process.argv[2] || !Number.isSafeInteger(record.writtenAt) || record.writtenAt <= 0) process.exit(1);
' "$written_snapshot" "$desired"
if [ "$desired" = "$applied" ] && cmp -s "$written_snapshot" "$applied_written"; then exit 0; fi
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
kubectl -n kube-system get deploy/coredns -o json > "$deployment"
kubectl -n kube-system get pods -l k8s-app=kube-dns -o json > "$pod"
# kubelet reads the resolver at pod creation. All labelled pods must have
# been created strictly after publication and be Running/Ready, and the
# deployment controller must have observed the current rollout generation.
node -e '
const fs = require("node:fs");
const read = path => JSON.parse(fs.readFileSync(path, "utf8"));
const [writtenPath, deploymentPath, podsPath, desired] = process.argv.slice(1);
const record = read(writtenPath);
const deployment = read(deploymentPath);
const pods = read(podsPath).items;
const valid = record.sha256 === desired && Number.isSafeInteger(record.writtenAt) && record.writtenAt > 0 &&
  Number.isSafeInteger(deployment.metadata?.generation) && deployment.metadata.generation > 0 &&
  deployment.status?.observedGeneration === deployment.metadata.generation &&
  Array.isArray(pods) && pods.length > 0 && pods.every(pod =>
    pod.metadata?.labels?.["k8s-app"] === "kube-dns" &&
    Date.parse(pod.metadata?.creationTimestamp) > record.writtenAt &&
    pod.status?.phase === "Running" &&
    pod.status?.conditions?.some(condition => condition.type === "Ready" && condition.status === "True"));
if (!valid) { console.error("CoreDNS pods do not prove resolver publication is applied"); process.exit(1); }
' "$written_snapshot" "$deployment" "$pod" "$desired"
# A concurrent generator may have published newer desired content while the
# rollout was running. Fail for retry rather than lose that pending update.
cmp -s "$written" "$written_snapshot" || { echo 'resolver publication changed during apply' >&2; exit 1; }
[ "$(hash "$target")" = "$desired" ] || { echo 'resolver changed during apply' >&2; exit 1; }
cp "$written_snapshot" "$applied_written.$$.tmp"
mv "$applied_written.$$.tmp" "$applied_written"
printf '%s\n' "$desired" > "$marker.$$.tmp"
mv "$marker.$$.tmp" "$marker"
