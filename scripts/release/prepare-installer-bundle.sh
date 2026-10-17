#!/bin/sh
set -eu
[ "$#" -eq 3 ] || { echo "usage: prepare-installer-bundle.sh TAG DIGEST OUTPUT" >&2; exit 2; }
tag=$1
digest=$2
out=$3
case "$tag" in v*) ;; *) echo 'tag must begin with v' >&2; exit 2;; esac
case "$digest" in sha256:*) hex=${digest#sha256:};; *) echo 'invalid platform digest' >&2; exit 2;; esac
case "$hex" in *[!0-9a-f]*|'') echo 'invalid platform digest' >&2; exit 2;; esac
[ "${#hex}" -eq 64 ] || { echo 'invalid platform digest' >&2; exit 2; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
rm -rf "$out"
mkdir -p "$out/scripts" "$out/deploy/root" "$out/deploy/mdns" "$out/deploy/cli"
sed -e "s|^PLATFORM_URL=.*|PLATFORM_URL=\"oci://ghcr.io/shady2k/lifemodel-platform\"|" \
    -e "s|^PLATFORM_TAG=.*|PLATFORM_TAG=\"$tag\"|" \
    -e "s|^PLATFORM_DIGEST=.*|PLATFORM_DIGEST=\"sha256:$hex\"|" "$root/scripts/install.sh" > "$out/scripts/install.sh"
chmod 0755 "$out/scripts/install.sh"
cp "$root/deploy/root/"*.yaml "$out/deploy/root/"
cp "$root/deploy/mdns/publish-name" "$root/deploy/mdns/publisher.service.in" "$out/deploy/mdns/"
cp "$root/deploy/cli/lifemodel.mjs" "$out/deploy/cli/"
