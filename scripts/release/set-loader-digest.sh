#!/usr/bin/env bash
set -euo pipefail

# Pin the loader image's immutable digest in every kustomization that deploys
# that image: A0 runs the loader itself, step A runs the platform's
# model-gateway from the same image (ADR-013 D1/D8), so both must name the
# same pushed digest.
if [ "$#" -lt 2 ]; then
  echo "usage: $0 sha256:<64 lowercase hex digits> <kustomization-file>..." >&2
  exit 2
fi

digest=$1
shift
if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "invalid loader image digest: expected sha256:<64 lowercase hex digits>" >&2
  exit 2
fi

placeholder='sha256:0000000000000000000000000000000000000000000000000000000000000000'
for file in "$@"; do
  if [ ! -f "$file" ]; then
    echo "kustomization file not found: $file" >&2
    exit 2
  fi
  count=$(grep -F -c "digest: $placeholder" "$file" || true)
  if [ "$count" -ne 1 ]; then
    echo "expected exactly one loader digest placeholder in $file; found $count" >&2
    exit 1
  fi
done

# Validate every file before rewriting any of them: a refused run leaves the
# platform manifests exactly as they were.
for file in "$@"; do
  tmp=$(mktemp "${file}.XXXXXX")
  trap 'rm -f "$tmp"' EXIT
  sed "s|digest: $placeholder|digest: $digest|" "$file" > "$tmp"
  mv "$tmp" "$file"
done
