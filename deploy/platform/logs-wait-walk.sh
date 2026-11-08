#!/usr/bin/env bash
# WALK-LOGS-WAIT: a log step does not gate the platform's readiness (ADR-016
# L09, §1).
#
# What it proves
# --------------
# The two log Flux steps run at `wait: false`, so a log pod that cannot start
# does not hold the platform back:
# 1. the collector DaemonSet is Ready before the walk;
# 2. it is patched to a non-existent image digest, and its pod reports an image
#    pull failure instead of becoming Ready;
# 3. the platform's steps are asked to reconcile (the
#    reconcile.fluxcd.io/requestedAt annotation), and every Kustomization in
#    flux-system other than the log steps is Ready, the root `platform`
#    included;
# 4. the log steps themselves are Ready (they applied their manifests; only
#    their pod cannot start), and the loader and core pods are Ready;
# 5. the log pod is still broken after that reconcile;
# 6. the image is restored and the collector is Ready again.
#
# Arguments (defaults are the test VM's)
# --------------------------------------
#   --kubectl COMMAND      default "k3s kubectl"
#   --collector-namespace NS  the collector's namespace (default lifemodel-logs)
#   --collector NAME       the collector's DaemonSet (default logs-collector)
#   --flux-namespace NS    default flux-system
#   --steps "NAMES"        the platform steps to reconcile, space separated
#                          (default: platform platform-instance platform-a0
#                          platform-a platform-b platform-c platform-d)
#   --log-steps "NAMES"    the log steps, excluded from the readiness verdict
#                          and never asked to reconcile (default: platform-logs-store platform-logs)
#   --loader-namespace NS  default lifemodel-system, label app.kubernetes.io/name=loader
#   --core-namespace NS    default lifemodel, label app.kubernetes.io/name=core
#   --break-timeout N      bound on the collector pod failing to start (default 180)
#   --reconcile-timeout N  bound on the steps finishing their reconcile (default 300)
#   --ready-timeout N      bound on the collector becoming Ready again (default 300)
#
# What it changes and restores
# ----------------------------
# It patches one image reference in the collector DaemonSet's pod template and
# patches the original back. The EXIT trap restores the original image, also
# when an assertion fails, and prints a RESTORE line. Flux owns the object, so
# its own next reconcile converges on the same image.
#
# While the collector pod is broken nothing is collected: its buffer lives in
# the pod, and the replacement pod is the one that cannot start. Lines written in
# that window may be lost; the walk restores the working pod and says so.
#
# The log steps are deliberately not asked to reconcile: a reconcile would
# re-apply the real image and end the fixture. Their own interval is ten
# minutes, longer than the walk's window, so the pod stays broken for the
# assertions and the reconcile is triggered on every other platform step.
#
# Exit status is non-zero when any assertion failed.
set -u -o pipefail

KUBECTL='k3s kubectl'
COLLECTOR_NAMESPACE=lifemodel-logs
COLLECTOR=logs-collector
FLUX_NAMESPACE=flux-system
STEPS='platform platform-instance platform-a0 platform-a platform-b platform-c platform-d'
LOG_STEPS='platform-logs-store platform-logs'
LOADER_NAMESPACE=lifemodel-system
CORE_NAMESPACE=lifemodel
BREAK_TIMEOUT=180
RECONCILE_TIMEOUT=300
READY_TIMEOUT=300

usage() {
  echo "usage: $0 [--kubectl CMD] [--collector-namespace NS] [--collector NAME] [--flux-namespace NS]" >&2
  echo "          [--steps NAMES] [--log-steps NAMES] [--loader-namespace NS] [--core-namespace NS]" >&2
  echo "          [--break-timeout N] [--reconcile-timeout N] [--ready-timeout N]" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case $1 in
    --kubectl) [ "$#" -ge 2 ] || usage; KUBECTL=$2; shift 2 ;;
    --collector-namespace) [ "$#" -ge 2 ] || usage; COLLECTOR_NAMESPACE=$2; shift 2 ;;
    --collector) [ "$#" -ge 2 ] || usage; COLLECTOR=$2; shift 2 ;;
    --flux-namespace) [ "$#" -ge 2 ] || usage; FLUX_NAMESPACE=$2; shift 2 ;;
    --steps) [ "$#" -ge 2 ] || usage; STEPS=$2; shift 2 ;;
    --log-steps) [ "$#" -ge 2 ] || usage; LOG_STEPS=$2; shift 2 ;;
    --loader-namespace) [ "$#" -ge 2 ] || usage; LOADER_NAMESPACE=$2; shift 2 ;;
    --core-namespace) [ "$#" -ge 2 ] || usage; CORE_NAMESPACE=$2; shift 2 ;;
    --break-timeout) [ "$#" -ge 2 ] || usage; BREAK_TIMEOUT=$2; shift 2 ;;
    --reconcile-timeout) [ "$#" -ge 2 ] || usage; RECONCILE_TIMEOUT=$2; shift 2 ;;
    --ready-timeout) [ "$#" -ge 2 ] || usage; READY_TIMEOUT=$2; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

command -v python3 >/dev/null 2>&1 || { echo 'missing tool: python3' >&2; exit 2; }

FAILS=0
ORIGINAL_IMAGE=
IMAGE_INDEX=0
SELECTOR=
RESTORE_IMAGE=0

pass() { printf 'PASS %s%s\n' "$1" "${2:+ - $2}"; }
fail() { printf 'FAIL %s%s\n' "$1" "${2:+ - $2}"; FAILS=$((FAILS + 1)); }
check() {
  local name=$1
  shift
  if "$@" >/dev/null 2>&1; then pass "$name"; return 0; else fail "$name"; return 1; fi
}

wait_until() { # seconds command...
  local limit=$1
  shift
  local end
  end=$(( $(date +%s) + limit ))
  while :; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    [ "$(date +%s)" -lt "$end" ] || return 1
    sleep 3
  done
}

ds_json() { $KUBECTL -n "$COLLECTOR_NAMESPACE" get daemonset "$COLLECTOR" -o json 2>/dev/null; }

collector_details() {
  # The DaemonSet's first container image, then its pod selector, one per line.
  ds_json | python3 -c '
import json, sys
daemonset = json.load(sys.stdin)
containers = daemonset["spec"]["template"]["spec"]["containers"]
labels = daemonset["spec"]["selector"]["matchLabels"]
print(containers[0]["image"])
print(",".join("%s=%s" % (key, value) for key, value in sorted(labels.items())))
'
}

collector_ready() {
  local counts ready desired
  counts=$($KUBECTL -n "$COLLECTOR_NAMESPACE" get daemonset "$COLLECTOR" \
    -o jsonpath='{.status.numberReady}:{.status.desiredNumberScheduled}' 2>/dev/null)
  ready=${counts%%:*}
  desired=${counts##*:}
  [ "${desired:-0}" -ge 1 ] && [ "$ready" = "$desired" ]
}

collector_broken() {
  $KUBECTL -n "$COLLECTOR_NAMESPACE" get pods -l "$SELECTOR" -o json 2>/dev/null | python3 -c '
import json, sys
items = json.load(sys.stdin).get("items", [])
if not items:
    sys.exit(1)
for pod in items:
    for status in pod.get("status", {}).get("containerStatuses") or []:
        waiting = (status.get("state") or {}).get("waiting") or {}
        if waiting.get("reason") in ("ImagePullBackOff", "ErrImagePull", "InvalidImageName"):
            sys.exit(0)
sys.exit(1)
'
}

kustomization_ready() {
  [ "$($KUBECTL -n "$FLUX_NAMESPACE" get kustomization "$1" \
    -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" = True ]
}

kustomization_handled() { # name, requestedAt stamp
  [ "$($KUBECTL -n "$FLUX_NAMESPACE" get kustomization "$1" \
    -o jsonpath='{.status.lastHandledReconcileAt}' 2>/dev/null)" = "$2" ] && kustomization_ready "$1"
}

unready_kustomizations() { # names to exclude
  $KUBECTL -n "$FLUX_NAMESPACE" get kustomizations -o json 2>/dev/null | python3 -c '
import json, sys
exclude = set(sys.argv[1:])
bad = []
for item in json.load(sys.stdin).get("items", []):
    name = item["metadata"]["name"]
    if name in exclude:
        continue
    conditions = (item.get("status") or {}).get("conditions") or []
    if not any(c.get("type") == "Ready" and c.get("status") == "True" for c in conditions):
        bad.append(name)
print(",".join(sorted(bad)))
' "$@"
}

workload_ready() { # namespace, label selector
  $KUBECTL -n "$1" get pods -l "$2" -o json 2>/dev/null | python3 -c '
import json, sys
items = json.load(sys.stdin).get("items", [])
ready = [pod for pod in items
         if any(c.get("type") == "Ready" and c.get("status") == "True"
                for c in pod.get("status", {}).get("conditions") or [])]
sys.exit(0 if items and len(ready) == len(items) else 1)
'
}

patch_image() { # image
  local payload
  payload=$(python3 -c 'import json, sys; print(json.dumps([{"op": "replace", "path": "/spec/template/spec/containers/%s/image" % sys.argv[2], "value": sys.argv[1]}]))' "$1" "$IMAGE_INDEX") || return 1
  $KUBECTL -n "$COLLECTOR_NAMESPACE" patch daemonset "$COLLECTOR" --type=json -p "$payload" >/dev/null 2>&1
}

restore() {
  local code=$?
  trap - EXIT HUP INT TERM
  local restored=1
  if [ "$RESTORE_IMAGE" = 1 ] && [ -n "$ORIGINAL_IMAGE" ]; then
    patch_image "$ORIGINAL_IMAGE" || restored=0
    wait_until "$READY_TIMEOUT" collector_ready || restored=0
  fi
  if [ "$restored" = 1 ]; then
    printf 'RESTORE collector image %s, daemonset %s/%s Ready\n' \
      "${ORIGINAL_IMAGE:-unchanged}" "$COLLECTOR_NAMESPACE" "$COLLECTOR"
  else
    printf 'RESTORE incomplete: restore the image of daemonset %s/%s by hand\n' \
      "$COLLECTOR_NAMESPACE" "$COLLECTOR"
  fi
  exit "$code"
}
trap restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

details=$(collector_details)
if [ -z "$details" ]; then
  fail 'the collector DaemonSet is readable' "$COLLECTOR_NAMESPACE/$COLLECTOR"
  exit 1
fi
ORIGINAL_IMAGE=$(printf '%s\n' "$details" | sed -n 1p)
SELECTOR=$(printf '%s\n' "$details" | sed -n 2p)
if [ -z "$ORIGINAL_IMAGE" ] || [ -z "$SELECTOR" ]; then
  fail 'the collector DaemonSet names an image and a pod selector' "$COLLECTOR_NAMESPACE/$COLLECTOR"
  exit 1
fi

if wait_until 120 collector_ready; then
  pass 'the collector is Ready before the walk' "$COLLECTOR_NAMESPACE/$COLLECTOR"
else
  fail 'the collector is Ready before the walk' "$COLLECTOR_NAMESPACE/$COLLECTOR"
  exit 1
fi

BASE=${ORIGINAL_IMAGE%%@*}
BAD_DIGEST=0000000000000000000000000000000000000000000000000000000000000000
BROKEN_IMAGE="$BASE@sha256:$BAD_DIGEST"
if [ "$BASE" = "$ORIGINAL_IMAGE" ]; then BROKEN_IMAGE="$ORIGINAL_IMAGE@sha256:$BAD_DIGEST"; fi
RESTORE_IMAGE=1
if patch_image "$BROKEN_IMAGE"; then
  pass 'the collector is patched to a non-existent image digest' "$BASE with a zero digest"
else
  fail 'the collector is patched to a non-existent image digest' 'the patch was refused'
  exit 1
fi

if wait_until "$BREAK_TIMEOUT" collector_broken; then
  pass 'the collector pod does not become Ready' 'an image pull failure is reported'
else
  fail 'the collector pod does not become Ready' 'no image pull failure within the bound'
fi

STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ANNOTATED=0
for step in $STEPS; do
  if $KUBECTL -n "$FLUX_NAMESPACE" annotate kustomization "$step" \
    "reconcile.fluxcd.io/requestedAt=$STAMP" --overwrite >/dev/null 2>&1; then
    ANNOTATED=$((ANNOTATED + 1))
  else
    fail "the platform step $step is asked to reconcile" "$FLUX_NAMESPACE/$step"
  fi
done
if [ "$ANNOTATED" -gt 0 ]; then
  pass 'the platform steps are asked to reconcile' "$ANNOTATED step(s) at $STAMP"
fi

for step in $STEPS; do
  if wait_until "$RECONCILE_TIMEOUT" kustomization_handled "$step" "$STAMP"; then
    pass "the platform step $step is Ready after its reconcile" "$FLUX_NAMESPACE/$step"
  else
    fail "the platform step $step is Ready after its reconcile" "not Ready or not handled at $STAMP"
  fi
done

UNREADY=$(unready_kustomizations $LOG_STEPS)
if [ -z "$UNREADY" ]; then
  pass 'every Kustomization outside the log steps is Ready' "$FLUX_NAMESPACE"
else
  fail 'every Kustomization outside the log steps is Ready' "not Ready: $UNREADY"
fi

if kustomization_ready platform; then
  pass 'the root Kustomization is Ready while the log pod is broken' "$FLUX_NAMESPACE/platform wait: true"
else
  fail 'the root Kustomization is Ready while the log pod is broken' "$FLUX_NAMESPACE/platform"
fi

BROKEN_LOG_STEPS=
for step in $LOG_STEPS; do
  if kustomization_ready "$step"; then
    pass "the log step $step is Ready while its pod cannot start" 'wait: false'
  else
    BROKEN_LOG_STEPS="$BROKEN_LOG_STEPS $step"
    fail "the log step $step is Ready while its pod cannot start" "$FLUX_NAMESPACE/$step"
  fi
done

if wait_until 120 workload_ready "$LOADER_NAMESPACE" app.kubernetes.io/name=loader; then
  pass 'the loader is Ready while the log pod is broken' "$LOADER_NAMESPACE"
else
  fail 'the loader is Ready while the log pod is broken' "$LOADER_NAMESPACE"
fi
if wait_until 120 workload_ready "$CORE_NAMESPACE" app.kubernetes.io/name=core; then
  pass 'the core is Ready while the log pod is broken' "$CORE_NAMESPACE"
else
  fail 'the core is Ready while the log pod is broken' "$CORE_NAMESPACE"
fi

check 'the log pod is still broken after the platform reconcile' collector_broken

if patch_image "$ORIGINAL_IMAGE"; then
  RESTORE_IMAGE=0
  pass 'the collector image is restored' "$ORIGINAL_IMAGE"
else
  fail 'the collector image is restored' 'the patch was refused'
fi
if wait_until "$READY_TIMEOUT" collector_ready; then
  pass 'the collector is Ready again' "$COLLECTOR_NAMESPACE/$COLLECTOR"
else
  fail 'the collector is Ready again' 'not Ready within the bound'
fi

printf 'RESULT %d assertion(s) failed\n' "$FAILS"
exit $(( FAILS > 0 ? 1 : 0 ))
