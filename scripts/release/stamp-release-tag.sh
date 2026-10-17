#!/bin/sh
# Run without --check-source while preparing a release commit, before tagging it.
# CI checks the tagged tree itself: stamping CI output alone cannot change what
# github:shady2k/lifemodel/vX flake consumers evaluate.
set -eu
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || { echo 'usage: stamp-release-tag.sh TAG [--check-source]' >&2; exit 2; }
tag=$1
case "$tag" in v[0-9]*) ;; *) echo 'invalid release tag' >&2; exit 2;; esac
case "$tag" in *[!A-Za-z0-9._-]*) echo 'invalid release tag' >&2; exit 2;; esac
mode=${2:-}
case "$mode" in ''|--check-source) ;; *) echo 'unknown stamp mode' >&2; exit 2;; esac
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
file="$root/deploy/nixos/release-tag"
if [ "$mode" = --check-source ] && [ "$(cat "$file")" != "$tag" ]; then
  echo 'release tag must match the tagged source deploy/nixos/release-tag; stamp it before tagging' >&2
  exit 1
fi
printf '%s\n' "$tag" > "$file"
