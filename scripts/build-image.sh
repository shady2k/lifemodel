#!/bin/sh
# build-image.sh — build the lifemodel instance image.
#
# The one command people and CI run. It makes the seed bundle the image carries
# — the repository's history at this commit, which the loader clones the
# instance's repository from on first start — and then runs `docker build`
# (docker/instance/Dockerfile).
#
#   scripts/build-image.sh                  # tags it <image>:local
#   scripts/build-image.sh main "$(git rev-parse HEAD)"   # CI, on a push
#   LIFEMODEL_IMAGE=ghcr.io/me/lifemodel scripts/build-image.sh
#
# The image name is LIFEMODEL_IMAGE (default ghcr.io/shady2k/lifemodel); the
# tags are the arguments, `local` when there are none. It builds only: pushing
# is the caller's step, and CI pushes main and the commit on a push to main.
#
# A checkout without its full history is refused by name: the bundle would
# carry no history, and the instance's repository could then never be merged
# with upstream.
set -eu

image=${LIFEMODEL_IMAGE:-ghcr.io/shady2k/lifemodel}
if [ "$#" -gt 0 ]; then
    tags=$*
else
    tags=local
fi

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

# Keep the instance builder's own clear input diagnostics; the shared helper
# repeats these guards for the standalone loader-image release path.
if [ "$(git rev-parse --is-shallow-repository)" != false ]; then
    printf '%s\n' \
        "build-image: $root is a shallow checkout, so the seed bundle would carry no history and the instance's repository could never be merged with upstream; fetch the full history first (git fetch --unshallow, or actions/checkout with fetch-depth: 0)" >&2
    exit 2
fi
if [ ! -d loader ]; then
    printf '%s\n' \
        "build-image: no loader/ in $root: the image builds the loader from the repository and this checkout does not carry it" >&2
    exit 2
fi

# The shared preparer creates the full-history bundle; this builder owns and
# removes the context around its Docker build.
context=.docker-context
if [ -e "$context" ]; then
    printf '%s\n' \
        "build-image: $root/$context already exists, and this script only removes a build context it made itself; it is not this run's, so nothing was deleted - remove it yourself if it is stale" >&2
    exit 2
fi
trap 'rm -rf "$context"' EXIT INT TERM
scripts/release/prepare-loader-context.sh

commit=$(git rev-parse HEAD)

printf 'build-image: building %s at %s, tags %s\n' "$image" "$commit" "$tags"

set -- docker build \
    --file docker/instance/Dockerfile \
    --label "org.opencontainers.image.revision=$commit"
for tag in $tags; do
    set -- "$@" --tag "$image:$tag"
done
"$@" .
