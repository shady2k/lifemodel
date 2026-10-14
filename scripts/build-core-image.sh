#!/bin/sh
# Build only the lifemodel core image. Pushing is the caller's responsibility.
set -eu
image=${LIFEMODEL_CORE_IMAGE:-ghcr.io/shady2k/lifemodel-core}
if [ "$#" -gt 0 ]; then tags=$*; else tags=local; fi
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
context=.docker-core-context
if [ -e "$context" ]; then
    printf '%s\n' "build-core-image: $context already exists; remove the stale context yourself" >&2
    exit 2
fi
trap 'rm -rf "$context"' EXIT INT TERM
mkdir -p "$context/docker/core"
cp package.json package-lock.json tsconfig.json .npmrc "$context/"
cp -R src "$context/src"
cp docker/core/Dockerfile docker/core/entrypoint.sh "$context/docker/core/"
commit=$(git rev-parse HEAD)
printf 'build-core-image: building %s at %s, tags %s\n' "$image" "$commit" "$tags"
set -- docker build --file docker/core/Dockerfile --label "org.opencontainers.image.revision=$commit"
for tag in $tags; do set -- "$@" --tag "$image:$tag"; done
"$@" "$context"
