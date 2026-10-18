#!/bin/sh
# Versioned installer assets are write-once. Retry only with the original pin.
set -eu
[ "$#" -eq 3 ] || { echo 'usage: publish-installer-bundle.sh TAG DIGEST ARCHIVE' >&2; exit 2; }
tag=$1
digest=$2
archive=$3
case "$tag" in v[0-9]*) ;; *) echo 'invalid release tag' >&2; exit 2;; esac
case "$tag" in *[!A-Za-z0-9._-]*) echo 'invalid release tag' >&2; exit 2;; esac
case "$digest" in sha256:*) hex=${digest#sha256:};; *) echo 'invalid platform digest' >&2; exit 2;; esac
case "$hex" in *[!0-9a-f]*|'') echo 'invalid platform digest' >&2; exit 2;; esac
[ "${#hex}" -eq 64 ] || { echo 'invalid platform digest' >&2; exit 2; }
asset="lifemodel-installer-$tag.tar.gz"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
check_pin() {
  tar -xOzf "$1" scripts/install.sh > "$work/install.txt" || return 1
  # Never source the downloaded script, or run any bytes from an existing asset.
  [ "$(grep -c '^PLATFORM_DIGEST=' "$work/install.txt")" -eq 1 ] || return 1
  grep -Fx "PLATFORM_DIGEST=\"$digest\"" "$work/install.txt" >/dev/null || return 1
  grep -Fx 'PLATFORM_URL="oci://ghcr.io/shady2k/lifemodel-platform"' "$work/install.txt" >/dev/null || return 1
}
check_pin "$archive" || { echo 'candidate installer has a different platform pin' >&2; exit 1; }
if ! gh release view "$tag" >/dev/null 2>&1; then
  # Creation races and API errors fail closed, not an overwrite path.
  gh release create "$tag" --verify-tag --generate-notes
fi
assets=$(gh release view "$tag" --json assets --jq '.assets[].name')
if printf '%s\n' "$assets" | grep -Fx "$asset" >/dev/null; then
  gh release download "$tag" --pattern "$asset" --dir "$work"
  check_pin "$work/$asset" || { echo 'existing installer has a different platform pin; refusing upload' >&2; exit 1; }
  printf '%s\n' 'Installer already published with the same verified pin; keeping original asset.'
  exit 0
fi
# No --clobber: if a concurrent publisher wins, gh refuses rather than replacing.
gh release upload "$tag" "$archive"
