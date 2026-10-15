#!/bin/sh
# Build only the lifemodel core image. Pushing is the caller's responsibility.
set -eu
image=${LIFEMODEL_CORE_IMAGE:-ghcr.io/shady2k/lifemodel-core}
if [ "$#" -gt 0 ]; then tags=$*; else tags=local; fi
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
context=.docker-core-context
"$root/scripts/prepare-core-image-context.sh" "$context"
trap 'rm -rf "$context"' EXIT INT TERM
commit=$(git rev-parse HEAD)
printf 'build-core-image: building %s at %s, tags %s\n' "$image" "$commit" "$tags"
set -- docker build --file docker/core/Dockerfile --label "org.opencontainers.image.revision=$commit"
for tag in $tags; do set -- "$@" --tag "$image:$tag"; done
"$@" "$context"
