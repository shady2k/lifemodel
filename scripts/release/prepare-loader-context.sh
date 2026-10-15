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
index=$(mktemp "${TMPDIR:-/tmp}/lifemodel-release-index.XXXXXX")
seed_ref="refs/heads/lifemodel-release-seed-$$"
context_ready=false
head_path=$(git rev-parse --git-path HEAD)
head_state=$(cat "$head_path")
head_changed=false
cleanup() {
    if [ "$head_changed" = true ]; then printf '%s\n' "$head_state" > "$head_path"; fi
    git update-ref -d "$seed_ref" 2>/dev/null || true
    rm -f "$index"
    if [ "$context_ready" != true ]; then rm -rf "$context"; fi
}
trap cleanup 0
trap 'exit 1' HUP INT TERM

source_commit=$(git rev-parse --verify HEAD^{commit})
seed_file=deploy/platform/applications/lifemodel/kustomization.yaml
if ! git ls-files --error-unmatch "$seed_file" >/dev/null 2>&1; then
    printf 'prepare-loader-context: missing tracked release seed file %s\n' "$seed_file" >&2
    exit 2
fi
if ! grep -Eq '^    digest: sha256:[a-f0-9]{64}$' "$seed_file" || grep -Eq '^    digest: sha256:0{64}$' "$seed_file"; then
    printf 'prepare-loader-context: %s must contain a non-zero pinned core digest before bundling\n' "$seed_file" >&2
    exit 2
fi

# Carry the release's digest overlay as a child of the tagged source commit.
# This keeps the original source commit and its full ancestry in the seed while
# ensuring Gitea's main branch starts from the exact release deployment tree.
GIT_INDEX_FILE="$index" git read-tree "$source_commit"
GIT_INDEX_FILE="$index" git add -- "$seed_file"
seed_tree=$(GIT_INDEX_FILE="$index" git write-tree)
seed_commit=$(printf '%s\n' 'Release seed overlay: pin the pushed core image' | git -c user.name=lifemodel-release -c user.email=lifemodel-release@invalid commit-tree "$seed_tree" -p "$source_commit")
git update-ref "$seed_ref" "$seed_commit"
git update-ref --no-deref HEAD "$seed_commit"
head_changed=true
git bundle create "$context/seed.bundle" HEAD >/dev/null
git bundle verify "$context/seed.bundle" >/dev/null
context_ready=true
printf 'prepare-loader-context: prepared full-history seed bundle at %s/%s/seed.bundle (source %s, seed %s)\n' "$root" "$context" "$source_commit" "$seed_commit"
