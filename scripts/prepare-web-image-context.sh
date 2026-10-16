#!/bin/sh
# Assemble the source needed to bundle the web server and build its app.
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
context=${1:-"$root/.docker-web-context"}
case "$context" in /*) ;; *) context="$root/$context" ;; esac
if [ -e "$context" ]; then
    printf '%s\n' "prepare-web-image-context: $context already exists; remove the stale context yourself" >&2
    exit 2
fi
mkdir -p "$context/docker/web" "$context/web"
cp "$root/package.json" "$root/package-lock.json" "$root/.npmrc" "$context/"
cp -R "$root/src" "$context/src"
cp -R "$root/web/app" "$context/web/app"
cp -R "$root/web/kit" "$context/web/kit"
cp "$root/docker/web/Dockerfile" "$context/docker/web/Dockerfile"
