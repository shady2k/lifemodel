#!/bin/sh
# Publish the exact local image already smoke checked, without rebuilding it.
set -eu
[ "$#" = 1 ] || { echo 'usage: push-checked-image.sh IMAGE' >&2; exit 2; }
docker push "$1"
reference=$(docker image inspect --format '{{index .RepoDigests 0}}' "$1")
digest=${reference##*@}
printf '%s\n' "$digest" | grep -Eq '^sha256:[a-f0-9]{64}$' || {
    echo 'pushed image has no valid repository digest' >&2; exit 1;
}
printf 'digest=%s\n' "$digest" >> "$GITHUB_OUTPUT"
