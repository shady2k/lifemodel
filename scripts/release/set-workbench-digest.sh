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
if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || [[ "$digest" =~ ^sha256:0{64}$ ]]; then
  echo 'invalid workbench image digest' >&2
  exit 2
fi
if [ ! -f "$file" ]; then
  echo "kustomization file not found: $file" >&2
  exit 2
fi
tmp=$(mktemp "${file}.XXXXXX")
trap 'rm -f "$tmp"' EXIT
# Node is already required by the release pipeline. Accept the single canonical
# core StatefulSet env-add operation, not a substring in comments/other targets.
# Reject unexpected formatting rather than guessing at a different YAML shape.
node - "$digest" "$file" "$tmp" <<'NODE'
const fs = require('node:fs');
const [digest, file, tmp] = process.argv.slice(2);
const image = 'ghcr.io/shady2k/lifemodel-workbench';
const placeholder = `${image}@sha256:${'0'.repeat(64)}`;
const text = fs.readFileSync(file, 'utf8');
const operation = /^(  )- target:\n\1    kind: StatefulSet\n\1    name: core\n\1  patch: \|-\n\1    - op: add\n\1      path: \/spec\/template\/spec\/containers\/0\/env\/-\n\1      value:\n\1        name: LIFEMODEL_TASK_WORKBENCH_IMAGE\n\1        value: ([^\n]+)$/gm;
const matches = [...text.matchAll(operation)];
const names = text.match(/^ *name: LIFEMODEL_TASK_WORKBENCH_IMAGE *$/gm) ?? [];
if (names.length !== 1 || matches.length !== 1 || matches[0][2] !== placeholder ||
    text.split(placeholder).length !== 2) {
  console.error('expected exactly one complete workbench image placeholder env operation');
  process.exit(1);
}
const reference = `${image}@${digest}`;
const result = text.replace(operation, (block) => block.replace(placeholder, reference));
const verified = [...result.matchAll(operation)];
if (verified.length !== 1 || verified[0][2] !== reference || result.includes(placeholder) ||
    result.replace(reference, placeholder) !== text) {
  console.error('workbench image pin verification failed');
  process.exit(1);
}
fs.writeFileSync(tmp, result);
NODE
mv "$tmp" "$file"
