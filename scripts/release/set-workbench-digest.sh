#!/usr/bin/env bash
set -euo pipefail
# The workbench is a launch input, not a running container in this manifest.
# Pin the core env overlay in the SAME file carried by the loader seed bundle.
if [ "$#" -ne 2 ]; then
  echo "usage: $0 sha256:<64 lowercase hex digits> <core-kustomization-file>" >&2
  exit 2
fi
digest=$1
file=$2
if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo 'invalid workbench image digest' >&2
  exit 2
fi
placeholder='ghcr.io/shady2k/lifemodel-workbench@sha256:0000000000000000000000000000000000000000000000000000000000000000'
if [ ! -f "$file" ]; then
  echo "kustomization file not found: $file" >&2
  exit 2
fi
count=$(grep -oF "$placeholder" "$file" | wc -l || true)
if [ "$count" -ne 1 ]; then
  echo "expected exactly one workbench image placeholder in $file; found $count" >&2
  exit 1
fi
tmp=$(mktemp "${file}.XXXXXX")
trap 'rm -f "$tmp"' EXIT
sed "s|ghcr\.io/shady2k/lifemodel-workbench@sha256:0000000000000000000000000000000000000000000000000000000000000000|ghcr.io/shady2k/lifemodel-workbench@$digest|" "$file" > "$tmp"
mv "$tmp" "$file"
