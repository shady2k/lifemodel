#!/bin/sh
# Assemble a filtered source-only context for the standalone web image.
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
context=${1:-"$root/.docker-web-context"}
case "$context" in /*) ;; *) context="$root/$context" ;; esac
if [ -e "$context" ]; then
    printf '%s\n' "prepare-web-image-context: $context already exists; remove the stale context yourself" >&2
    exit 2
fi
mkdir -p "$context/docker/web" "$context/web"
copy_tree() {
    source=$1
    destination=$2
    # Reject links that escape their source tree. Internal symlinks are retained.
    find "$source" -type l -print | while IFS= read -r link; do
        target=$(readlink -f "$link")
        case "$target" in
            "$source"/*) ;;
            *) printf 'prepare-web-image-context: symlink escapes source tree: %s -> %s\n' "$link" "$target" >&2; exit 2 ;;
        esac
    done
    mkdir -p "$destination"
    tar -C "$source" \
        --exclude='*/.env*' --exclude='.env*' \
        --exclude='*/.git' --exclude='.git' \
        --exclude='*/node_modules' --exclude='node_modules' \
        --exclude='*/dist' --exclude='dist' \
        --exclude='*/coverage' --exclude='coverage' \
        --exclude='*/.cache' --exclude='.cache' \
        --exclude='*/data' --exclude='data' \
        --exclude='*/logs' --exclude='logs' \
        --exclude='*/motor-runs' --exclude='motor-runs' \
        --exclude='*/models' --exclude='models' \
        -cf - . | tar -C "$destination" -xf -
}
cp "$root/package.json" "$root/package-lock.json" "$root/.npmrc" "$context/"
copy_tree "$root/src" "$context/src"
copy_tree "$root/web/app" "$context/web/app"
copy_tree "$root/web/kit" "$context/web/kit"
cp "$root/docker/web/Dockerfile" "$context/docker/web/Dockerfile"
