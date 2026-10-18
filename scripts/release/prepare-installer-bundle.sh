#!/bin/sh
# Build the external release asset only after the signed platform is verified.
# Never put this digest-stamped output in the platform OCI artifact itself.
set -eu
[ "$#" -eq 3 ] || { echo 'usage: prepare-installer-bundle.sh TAG DIGEST OUTPUT' >&2; exit 2; }
tag=$1
digest=$2
out=$3
case "$tag" in v[0-9]*) ;; *) echo 'invalid release tag' >&2; exit 2;; esac
case "$tag" in *[!A-Za-z0-9._-]*) echo 'invalid release tag' >&2; exit 2;; esac
case "$digest" in sha256:*) hex=${digest#sha256:};; *) echo 'invalid platform digest' >&2; exit 2;; esac
case "$hex" in *[!0-9a-f]*|'') echo 'invalid platform digest' >&2; exit 2;; esac
[ "${#hex}" -eq 64 ] || { echo 'invalid platform digest' >&2; exit 2; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
# Do not recursively delete a caller-selected directory. Stage privately and
# fail rather than silently overwriting an existing published asset.
mkdir -p "$out"
out=$(CDPATH= cd -- "$out" && pwd)
archive="$out/lifemodel-installer-$tag.tar.gz"
[ ! -e "$archive" ] || { echo 'installer asset already exists' >&2; exit 1; }
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT HUP INT TERM
mkdir -p "$stage/scripts" "$stage/deploy/root" "$stage/deploy/mdns" "$stage/deploy/cli" \
  "$stage/deploy/k3s/config.yaml.d"
sed -e 's|^PLATFORM_URL=.*|PLATFORM_URL="oci://ghcr.io/shady2k/lifemodel-platform"|' \
    -e 's|^PLATFORM_TAG=.*|PLATFORM_TAG=""|' \
    -e "s|^PLATFORM_DIGEST=.*|PLATFORM_DIGEST=\"$digest\"|" "$root/scripts/install.sh" > "$stage/scripts/install.sh"
chmod 0755 "$stage/scripts/install.sh"
cp "$root/deploy/root/"*.yaml "$stage/deploy/root/"
cp "$root/deploy/mdns/publish-name" "$root/deploy/mdns/publisher.service.in" "$stage/deploy/mdns/"
cp "$root/deploy/cli/lifemodel.mjs" "$root/deploy/cli/wait-ready.mjs" "$stage/deploy/cli/"
cp "$root/deploy/k3s/resolv-conf.mjs" "$root/deploy/k3s/k3s-resolv.sh" \
  "$root/deploy/k3s/lifemodel-k3s-resolv.service.in" "$root/deploy/k3s/lifemodel-k3s-resolv.path.in" "$stage/deploy/k3s/"
cp "$root/deploy/k3s/config.yaml.d/lifemodel-resolv-conf.yaml" "$stage/deploy/k3s/config.yaml.d/"
tar -czf "$archive" -C "$stage" scripts deploy
printf '%s\n' "$archive"
