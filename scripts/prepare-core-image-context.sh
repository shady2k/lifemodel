#!/bin/sh
# Assemble the smallest complete context for the standalone core image.
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
context=${1:-"$root/.docker-core-context"}
case "$context" in
    /*) ;;
    *) context="$root/$context" ;;
esac
if [ -e "$context" ]; then
    printf '%s\n' "prepare-core-image-context: $context already exists; remove the stale context yourself" >&2
    exit 2
fi
mkdir -p "$context/docker/core" "$context/scripts" "$context/db"
cp "$root/package.json" "$root/package-lock.json" "$root/tsconfig.json" "$root/.npmrc" "$context/"
cp -R "$root/src" "$context/src"
cp "$root/docker/core/Dockerfile" "$root/docker/core/entrypoint.sh" "$context/docker/core/"
cp "$root/scripts/apply-migrations.js" "$context/scripts/apply-migrations.js"
cp -R "$root/db/migrations" "$context/db/migrations"
