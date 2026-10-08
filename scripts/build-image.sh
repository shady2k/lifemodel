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

# The bundle is written into the build context because a docker build can read
# nothing else; .dockerignore keeps the rest of the repository out of it, and
# it is removed on the way out whatever happens.
context=.docker-context
mkdir -p "$context"
trap 'rm -rf "$context"' EXIT INT TERM

commit=$(git rev-parse HEAD)
git bundle create "$context/seed.bundle" HEAD >/dev/null
git bundle verify "$context/seed.bundle" >/dev/null

printf 'build-image: building %s at %s, tags %s\n' "$image" "$commit" "$tags"

set -- docker build \
    --file docker/instance/Dockerfile \
    --label "org.opencontainers.image.revision=$commit"
for tag in $tags; do
    set -- "$@" --tag "$image:$tag"
done
"$@" .
