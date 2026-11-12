#!/usr/bin/env bash
# WALK-LOGS-VOLUME, unmounted case: with the log volume unmounted the store does
# not start, nothing lands on the root filesystem, and a remount brings it back
# (ADR-016 L05, §5).
#
# What it proves
# --------------
# 1. The log volume is mounted and the store is Ready before the walk.
# 2. With the store stopped and the host mount unit stopped, the store's pod is
#    scaled back up but does not become Ready, and no file appears under the
#    PV's path (/var/lib/lifemodel-logs/data) on the root filesystem: that path
#    is a subdirectory that only exists inside the mounted filesystem, so the
#    guarantee cannot vanish silently.
# 3. kubelet says why: a FailedMount event names the missing volume path.
# 4. Starting the installer's mount unit again (var-lib-lifemodel\x2dlogs.mount,
#    the same unit scripts/install.sh installs) with no other change brings the
#    store Ready and the loader's logs API answers within --api-wait seconds: a
#    Service's endpoints follow readiness with a short lag.
#
# Arguments (defaults are the test VM's)
# --------------------------------------
#   --password-file PATH  the loader's login password, read from this file and
#                         never printed (required for the logs API assertion)
#   --loader-host HOST    where the walk connects (default boot-lifemodel.local)
#   --loader-port PORT    the loader's TLS port (default 443)
#   --origin-host HOST    the host the loader answers on, sent as Host and as
#                         the login Origin (default boot-lifemodel.local); pass
#                         127.0.0.1 with a port-forward for --loader-host
#   --ca-file PATH        verify the loader's certificate with this CA; without
#                         it the TLS chain is not verified
#   --kubectl COMMAND     default "k3s kubectl"
#   --namespace NS        the store's namespace (default lifemodel-system)
#   --store NAME          the store's Deployment (default logs-store)
#   --mount PATH          the host mount point (default /var/lib/lifemodel-logs)
#   --pv-path PATH        the PV's path inside that mount
#                         (default /var/lib/lifemodel-logs/data)
#   --mount-unit UNIT     the systemd mount unit
#                         (default var-lib-lifemodel\x2dlogs.mount)
#   --observe-seconds N   how long the store pod must stay not Ready (default 45)
#   --ready-timeout N     bound on the store becoming Ready again (default 600)
#   --api-wait N          bound on the logs API answering after the remount
#                         (default 60): a Service's endpoints follow readiness
#                         with a short lag
#
# What it changes and restores
# ----------------------------
# It scales deployment/logs-store to 0 and back to its previous replica count,
# and stops and starts the systemd mount unit. The EXIT trap restores both, also
# when an assertion fails, and prints a RESTORE line.
#
# The evictor CronJob mounts the same volume for a second once a minute, so the
# unmount is retried for up to two minutes until it finds a gap between runs.
#
# Exit status is non-zero when any assertion failed.
set -u -o pipefail

PASSWORD_FILE=
LOADER_HOST=boot-lifemodel.local
LOADER_PORT=443
ORIGIN_HOST=boot-lifemodel.local
CA_FILE=
KUBECTL='k3s kubectl'
STORE_NAMESPACE=lifemodel-system
STORE=logs-store
MOUNT=/var/lib/lifemodel-logs
PV_PATH=/var/lib/lifemodel-logs/data
MOUNT_UNIT='var-lib-lifemodel\x2dlogs.mount'
OBSERVE_SECONDS=45
READY_TIMEOUT=600
API_WAIT=60

usage() {
  sed -n '2,/^set -u/{/^set -u/!s/^# \{0,1\}//p}' "$0" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case $1 in
    --password-file) [ "$#" -ge 2 ] || usage; PASSWORD_FILE=$2; shift 2 ;;
    --loader-host) [ "$#" -ge 2 ] || usage; LOADER_HOST=$2; shift 2 ;;
    --loader-port) [ "$#" -ge 2 ] || usage; LOADER_PORT=$2; shift 2 ;;
    --origin-host) [ "$#" -ge 2 ] || usage; ORIGIN_HOST=$2; shift 2 ;;
    --ca-file) [ "$#" -ge 2 ] || usage; CA_FILE=$2; shift 2 ;;
    --kubectl) [ "$#" -ge 2 ] || usage; KUBECTL=$2; shift 2 ;;
    --namespace) [ "$#" -ge 2 ] || usage; STORE_NAMESPACE=$2; shift 2 ;;
    --store) [ "$#" -ge 2 ] || usage; STORE=$2; shift 2 ;;
    --mount) [ "$#" -ge 2 ] || usage; MOUNT=$2; shift 2 ;;
    --pv-path) [ "$#" -ge 2 ] || usage; PV_PATH=$2; shift 2 ;;
    --mount-unit) [ "$#" -ge 2 ] || usage; MOUNT_UNIT=$2; shift 2 ;;
    --observe-seconds) [ "$#" -ge 2 ] || usage; OBSERVE_SECONDS=$2; shift 2 ;;
    --ready-timeout) [ "$#" -ge 2 ] || usage; READY_TIMEOUT=$2; shift 2 ;;
    --api-wait) [ "$#" -ge 2 ] || usage; API_WAIT=$2; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

if [ -z "$PASSWORD_FILE" ] || [ ! -r "$PASSWORD_FILE" ]; then
  echo 'a readable --password-file is required' >&2
  exit 2
fi
for tool in curl python3 systemctl find mountpoint; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool" >&2; exit 2; }
done

FAILS=0
ORIGINAL_REPLICAS=
COOKIE_JAR=
PROBE_BODY=
STORE_POD=

pass() { printf 'PASS %s%s\n' "$1" "${2:+ - $2}"; }
fail() { printf 'FAIL %s%s\n' "$1" "${2:+ - $2}"; FAILS=$((FAILS + 1)); }
# PASS when the command succeeds, FAIL when it does not. The command's own
# output stays out of the report: it can carry cluster internals.
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
    sleep 2
  done
}

mount_active() { [ "$(systemctl is-active "$MOUNT_UNIT" 2>/dev/null)" = active ]; }
mount_volume() { systemctl start "$MOUNT_UNIT" >/dev/null 2>&1 && mount_active; }
umount_volume() { systemctl stop "$MOUNT_UNIT" >/dev/null 2>&1; ! mount_active; }

store_pods() {
  $KUBECTL -n "$STORE_NAMESPACE" get pods -l "app.kubernetes.io/name=$STORE" -o name 2>/dev/null
}
store_gone() { [ -z "$(store_pods)" ]; }
store_present() { [ -n "$(store_pods)" ]; }
store_pod_name() {
  $KUBECTL -n "$STORE_NAMESPACE" get pods -l "app.kubernetes.io/name=$STORE" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null
}
store_pod_ready() {
  local ready
  ready=$($KUBECTL -n "$STORE_NAMESPACE" get pods -l "app.kubernetes.io/name=$STORE" \
    -o jsonpath='{range .items[*]}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' \
    2>/dev/null | grep -cx True)
  [ "${ready:-0}" -ge 1 ]
}
store_pod_pending() {
  local phase
  phase=$($KUBECTL -n "$STORE_NAMESPACE" get pod "$STORE_POD" -o jsonpath='{.status.phase}' 2>/dev/null)
  [ "$phase" = Pending ]
}
failed_mount_reported() {
  [ -n "$STORE_POD" ] || return 1
  $KUBECTL -n "$STORE_NAMESPACE" get events --field-selector "involvedObject.name=$STORE_POD" \
    -o jsonpath='{range .items[*]}{.reason}{"\n"}{end}' 2>/dev/null | grep -qx FailedMount
}
# One logs query over the last 15 minutes: the HTTP code on stdout, the body in
# a private file, so a probe can be asked twice without printing anything.
logs_api_probe() {
  local from to
  [ -n "$COOKIE_JAR" ] || return 1
  from=$(( $(date +%s) * 1000 - 900000 ))
  to=$(( $(date +%s) * 1000 ))
  curl --silent --show-error --max-time 20 --noproxy '*' "${CURL_TLS[@]}" -b "$COOKIE_JAR" \
    -o "$PROBE_BODY" -w '%{http_code}' -H "Host: $ORIGIN_HOST" \
    "https://$LOADER_HOST:$LOADER_PORT/api/logs?from=$from&to=$to"
}

logs_api_field() { # field name
  python3 -c 'import json,sys; print((json.load(open(sys.argv[1])) or {}).get(sys.argv[2], ""))' \
    "$PROBE_BODY" "$1" 2>/dev/null
}

logs_api_answers() {
  [ "$(logs_api_probe)" = 200 ] && [ "$(logs_api_field state)" = ok ]
}

# The page's rule: unavailable is an answer with a reason, never an empty list.
logs_api_unavailable() {
  [ "$(logs_api_probe)" = 503 ] && [ "$(logs_api_field state)" = unavailable ] \
    && [ -n "$(logs_api_field reason)" ]
}

login() {
  local payload code
  payload=$(mktemp) || return 1
  chmod 600 "$payload"
  # The password goes from its file into a private body file, never an argument.
  python3 -c 'import json,sys; sys.stdout.write(json.dumps({"password": open(sys.argv[1], encoding="utf8").read().rstrip("\r\n")}))' \
    "$PASSWORD_FILE" > "$payload" || { rm -f "$payload"; return 1; }
  COOKIE_JAR=$(mktemp) || { rm -f "$payload"; return 1; }
  code=$(curl --silent --show-error --max-time 20 --noproxy '*' "${CURL_TLS[@]}" -c "$COOKIE_JAR" \
    -o /dev/null -w '%{http_code}' \
    -H "Host: $ORIGIN_HOST" -H "Origin: https://$ORIGIN_HOST" \
    -H 'content-type: application/json' --data-binary @"$payload" \
    "https://$LOADER_HOST:$LOADER_PORT/api/login")
  rm -f "$payload"
  [ "$code" = 200 ]
}

scale_store() {
  $KUBECTL -n "$STORE_NAMESPACE" scale deployment "$STORE" --replicas="$1" >/dev/null 2>&1
}

restore() {
  local code=$?
  trap - EXIT HUP INT TERM
  local restored=1
  if [ -n "$ORIGINAL_REPLICAS" ] && ! store_pod_ready; then
    scale_store "$ORIGINAL_REPLICAS" || restored=0
  fi
  if ! mount_active; then
    mount_volume || restored=0
  fi
  if [ -n "$ORIGINAL_REPLICAS" ]; then
    wait_until "$READY_TIMEOUT" store_pod_ready || restored=0
  fi
  if [ -n "$COOKIE_JAR" ]; then rm -f "$COOKIE_JAR"; fi
  if [ -n "$PROBE_BODY" ]; then rm -f "$PROBE_BODY"; fi
  if [ "$restored" = 1 ]; then
    printf 'RESTORE store replicas=%s, %s mounted, store Ready\n' \
      "${ORIGINAL_REPLICAS:-unchanged}" "$MOUNT"
  else
    printf 'RESTORE incomplete: check deployment/%s and unit %s\n' "$STORE" "$MOUNT_UNIT"
  fi
  exit "$code"
}

CURL_TLS=(-k)
if [ -n "$CA_FILE" ]; then CURL_TLS=(--cacert "$CA_FILE"); fi

trap restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

if ! mount_active; then
  fail 'the log volume is mounted before the walk' "$MOUNT_UNIT is not active"
  exit 1
fi
pass 'the log volume is mounted before the walk' "$MOUNT_UNIT -> $MOUNT"
if ! wait_until 120 store_pod_ready; then
  fail 'the store is Ready before the walk' "deployment/$STORE"
  exit 1
fi
pass 'the store is Ready before the walk' "deployment/$STORE"
PROBE_BODY=$(mktemp) || { fail 'a probe body file is created'; exit 1; }
if check 'the loader logs in' login; then
  check 'the logs API answers before the walk' logs_api_answers
fi
ORIGINAL_REPLICAS=$($KUBECTL -n "$STORE_NAMESPACE" get deployment "$STORE" \
  -o jsonpath='{.spec.replicas}' 2>/dev/null)
: "${ORIGINAL_REPLICAS:=1}"
case $ORIGINAL_REPLICAS in
  ''|*[!0-9]*) fail 'the store declares its replica count' "deployment/$STORE"; exit 1 ;;
esac

if scale_store 0; then
  pass 'the store is scaled to 0' "deployment/$STORE"
else
  fail 'the store is scaled to 0' "deployment/$STORE"
  exit 1
fi
if wait_until 180 store_gone; then
  pass 'the store has no pod before the unmount'
else
  fail 'the store has no pod before the unmount' 'the pod outlived its scale-down'
  exit 1
fi

if wait_until 120 umount_volume; then
  pass 'the log volume is unmounted' "$MOUNT_UNIT is inactive"
else
  fail 'the log volume is unmounted' "$MOUNT_UNIT is still active"
  exit 1
fi
if mountpoint -q "$MOUNT"; then
  fail 'the mount point is no longer a mount'
else
  pass 'the mount point is no longer a mount' "$MOUNT"
fi

if scale_store "$ORIGINAL_REPLICAS"; then
  pass 'the store is scaled back to 1' "deployment/$STORE replicas=$ORIGINAL_REPLICAS"
else
  fail 'the store is scaled back to 1' "deployment/$STORE"
  exit 1
fi
if wait_until 180 store_present; then
  STORE_POD=$(store_pod_name)
  pass 'the store pod is created without the volume' "${STORE_POD:-unknown}"
else
  fail 'the store pod is created without the volume' 'no pod after the scale-up'
  exit 1
fi

# The pod must not become Ready while the volume is unmounted. Observe it.
OBSERVED=0
READY_SEEN=0
while [ "$OBSERVED" -lt "$OBSERVE_SECONDS" ]; do
  if store_pod_ready; then READY_SEEN=1; break; fi
  sleep 5
  OBSERVED=$((OBSERVED + 5))
done
if [ "$READY_SEEN" = 1 ]; then
  fail "the store pod does not become Ready while the volume is unmounted" "$STORE_POD became Ready"
else
  pass "the store pod does not become Ready while the volume is unmounted" \
    "$STORE_POD stayed not Ready for ${OBSERVE_SECONDS}s"
fi
check "the store pod is Pending while the volume is unmounted" store_pod_pending

if [ ! -e "$PV_PATH" ] && [ -z "$(find "$MOUNT" -mindepth 1 -print -quit 2>/dev/null)" ]; then
  pass 'no file appeared under the PV path on the root filesystem' "$PV_PATH absent, $MOUNT empty"
else
  fail 'no file appeared under the PV path on the root filesystem' \
    "something exists under $MOUNT"
fi

if failed_mount_reported; then
  pass 'kubelet reports the volume path is missing' 'FailedMount on the store pod'
else
  fail 'kubelet reports the volume path is missing' 'no FailedMount event found'
fi
check 'the logs API answers unavailable while the volume is not mounted' logs_api_unavailable

if wait_until 120 mount_volume; then
  pass 'the log volume is mounted again' "$MOUNT_UNIT is active"
else
  fail 'the log volume is mounted again' "$MOUNT_UNIT did not start"
fi
check 'the PV path exists after the remount' test -d "$PV_PATH"

if wait_until "$READY_TIMEOUT" store_pod_ready; then
  pass 'the store is Ready after the remount' "deployment/$STORE"
else
  fail 'the store is Ready after the remount' "not Ready within ${READY_TIMEOUT}s"
fi

if wait_until "$API_WAIT" logs_api_answers; then
  pass 'the logs API answers after the remount' "answered within ${API_WAIT}s"
else
  fail 'the logs API answers after the remount' "no answer within ${API_WAIT}s"
fi

printf 'RESULT %d assertion(s) failed\n' "$FAILS"
exit $(( FAILS > 0 ? 1 : 0 ))
