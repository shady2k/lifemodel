#!/bin/sh
# Import the actual runtime entrypoint, offline, without starting its service.
set -eu
[ "$#" = 2 ] || { echo 'usage: smoke-image-modules.sh core|loader|web IMAGE' >&2; exit 2; }
case "$1" in
    core) entry=/opt/lifemodel/dist/index.js ;;
    loader) entry=/opt/lifemodel/loader/dist/main.js ;;
    web) entry=/opt/lifemodel/dist/web/server.cjs ;;
    *) echo "unknown image kind: $1" >&2; exit 2 ;;
esac
name="lifemodel-module-smoke-$$"
cleanup() {
    timeout --kill-after=2 10 docker rm --force "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
timeout --kill-after=5 60 docker run --rm --name "$name" --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --memory 512m --pids-limit 64 \
    --entrypoint node "$2" "$entry" --check-modules
