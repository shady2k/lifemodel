#!/bin/sh
# Build only the lifemodel web image. Pushing is the caller's responsibility.
set -eu
image=${LIFEMODEL_WEB_IMAGE:-ghcr.io/shady2k/lifemodel-web}
if [ "$#" -gt 0 ]; then tags=$*; else tags=local; fi
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
context=.docker-web-context
"$root/scripts/prepare-web-image-context.sh" "$context"
trap 'rm -rf "$context"' EXIT INT TERM
commit=$(git rev-parse HEAD)
printf 'build-web-image: building %s at %s, tags %s\n' "$image" "$commit" "$tags"
set -- docker build --file docker/web/Dockerfile --label "org.opencontainers.image.revision=$commit"
for tag in $tags; do set -- "$@" --tag "$image:$tag"; done
"$@" "$context"
