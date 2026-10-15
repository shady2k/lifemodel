#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 sha256:<64 lowercase hex digits> <kustomization-file>" >&2
  exit 2
fi

digest=$1
file=$2
if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "invalid web image digest: expected sha256:<64 lowercase hex digits>" >&2
  exit 2
fi
if [ ! -f "$file" ]; then
  echo "kustomization file not found: $file" >&2
  exit 2
fi

placeholder='sha256:0000000000000000000000000000000000000000000000000000000000000000'
count=$(awk '/name: ghcr.io\/shady2k\/lifemodel-web$/{web=1; next} web && /digest:/{if ($2 == "'"$placeholder"'") count++; web=0} END{print count+0}' "$file")
if [ "$count" -ne 1 ]; then
  echo "expected exactly one web digest placeholder in $file; found $count" >&2
  exit 1
fi

tmp=$(mktemp "${file}.XXXXXX")
trap 'rm -f "$tmp"' EXIT
sed "/name: ghcr.io\/shady2k\/lifemodel-web$/,/digest:/{s|digest: $placeholder|digest: $digest|;}" "$file" > "$tmp"
mv "$tmp" "$file"
