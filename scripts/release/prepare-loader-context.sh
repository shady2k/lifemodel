#!/bin/sh
# Prepare the full-history bundle consumed by the platform loader image.
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

if [ "$(git rev-parse --is-shallow-repository)" != false ]; then
    printf '%s\n' \
        "prepare-loader-context: $root is a shallow checkout, so the seed bundle would carry no history and the instance repository could not be merged with upstream; fetch the full history first (git fetch --unshallow, or actions/checkout with fetch-depth: 0)" >&2
    exit 2
fi
if [ ! -d loader ]; then
    printf '%s\n' \
        "prepare-loader-context: no loader/ in $root: this checkout cannot build the loader image" >&2
    exit 2
fi

context=.docker-context
if [ -e "$context" ]; then
    printf '%s\n' \
        "prepare-loader-context: $root/$context already exists, and this script only removes a context it made itself; nothing was deleted - remove it yourself if it is stale" >&2
    exit 2
fi
mkdir "$context"
trap 'rm -rf "$context"' 0
trap 'exit 1' HUP INT TERM
git bundle create "$context/seed.bundle" HEAD >/dev/null
git bundle verify "$context/seed.bundle" >/dev/null
trap - 0 HUP INT TERM
printf 'prepare-loader-context: prepared full-history seed bundle at %s/%s/seed.bundle\n' "$root" "$context"
