#!/bin/bash
# Delivery liveness, not store liveness: a store outage must not restart collectors.
# Test overrides: LOGS_STORE_HEALTH_URL, LOGS_COLLECTOR_METRICS_URL,
# LOGS_DELIVERY_STATE_FILE and LOGS_DELIVERY_NOW (epoch seconds).
# Production probes run every 30s; a >60s gap starts a new observation window.
set -u

store_url=${LOGS_STORE_HEALTH_URL:-http://logs-store.lifemodel-system.svc:9428/health}
metrics_url=${LOGS_COLLECTOR_METRICS_URL:-http://127.0.0.1:9598/metrics}
state=${LOGS_DELIVERY_STATE_FILE:-/tmp/logs-delivery-state}
now=${LOGS_DELIVERY_NOW:-$(date +%s)}

# HTTP/1.0 avoids chunked framing. Bound the complete exchange, including DNS,
# connection and body read; neither HTTP response bodies nor errors are printed.
http_get() {
  local url=$1 authority host port path response status
  [[ $url == http://* ]] || return 1
  url=${url#http://}
  authority=${url%%/*}
  path=/${url#*/}
  [[ $url == */* ]] || path=/
  host=${authority%%:*}
  port=${authority##*:}
  [[ $authority == *:* ]] || port=80
  [[ $host =~ ^[a-zA-Z0-9.-]+$ && $port =~ ^[0-9]+$ ]] || return 1
  response=$(timeout 3 /bin/bash -c '
    exec 3<>/dev/tcp/"$1"/"$2" || exit 1
    printf "GET %s HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n" "$3" "$1" >&3
    head -c 1048576 <&3
  ' _ "$host" "$port" "$path" 2>/dev/null) || return 1
  status=${response%%$'\n'*}
  [[ $status =~ ^HTTP/1\.[01][[:space:]]2[0-9][0-9][[:space:]] ]] || return 1
  printf '%s\n' "$response" | awk '
    body { sub(/\r$/, ""); print; next }
    /^\r?$/ { body=1 }
  '
}

# The file holds only observed time, last progress time and a numeric counter.
previous=0
progress=$now
counter=-1
if [[ -r $state ]]; then
  read -r previous progress counter < "$state" || previous=0
fi
if ! [[ $previous =~ ^[0-9]+$ && $progress =~ ^[0-9]+$ && $counter =~ ^(-1|[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?)$ ]]; then
  previous=0
  progress=$now
  counter=-1
fi
if (( now < previous || now - previous > 60 )); then
  progress=$now
  counter=-1
fi

if ! http_get "$store_url" >/dev/null; then
  # Forget the whole healthy-store window, including the counter baseline.
  rm -f "$state"
  exit 0
fi

current=$(http_get "$metrics_url" | awk '
  /^vector_component_sent_events_total\{/ {
    end=index($0, "}")
    labels=substr($0, 1, end)
    if (labels !~ /[{,]component_id="logs-store"[,}]/) next
    value=substr($0, end + 1)
    sub(/^[ \t]+/, "", value)
    split(value, fields, /[ \t]+/)
    if (fields[1] !~ /^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$/) next
    total+=fields[1]
    found=1
  }
  END { if (found) printf "%.17g\n", total }
')
if [[ -n $current ]]; then
  if awk -v current="$current" -v counter="$counter" 'BEGIN { exit !(counter < 0 || current != counter) }'; then
    # Both delivery progress and a collector counter restart grant fresh grace.
    progress=$now
  fi
  counter=$current
fi

# Atomic replacement prevents an interrupted probe from leaving half a record.
if ! printf '%s %s %s\n' "$now" "$progress" "$counter" > "$state.tmp.$$"; then
  exit 1
fi
mv -f "$state.tmp.$$" "$state" || exit 1
(( now - progress < 300 ))
