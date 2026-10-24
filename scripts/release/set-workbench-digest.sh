#!/usr/bin/env bash
set -euo pipefail
# Jobs pull only from local zot. The loader imports these exact release bytes
# from the configured source before core can launch a Job. Pin both inputs together.
if [ "$#" -ne 3 ]; then
  echo "usage: $0 sha256:<64 lowercase hex digits> <core-kustomization-file> <origin-env-file>" >&2
  exit 2
fi
digest=$1
file=$2
origin_file=$3
if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || [[ "$digest" =~ ^sha256:0{64}$ ]]; then
  echo 'invalid workbench image digest' >&2
  exit 2
fi
if [ ! -f "$file" ] || [ ! -f "$origin_file" ]; then
  echo 'workbench release pin file not found' >&2
  exit 2
fi
tmp=$(mktemp "${file}.XXXXXX")
origin_tmp=''
trap 'rm -f "$tmp" "$origin_tmp"' EXIT
origin_tmp=$(mktemp "${origin_file}.XXXXXX")
# Node is already required by the release pipeline. Accept the single canonical
# core StatefulSet env-add operation, not a substring in comments/other targets.
# Validate BOTH placeholders before writing either output; reject an unexpected
# YAML or env shape rather than guessing at a different release configuration.
node - "$digest" "$file" "$origin_file" "$tmp" "$origin_tmp" <<'NODE'
const fs = require('node:fs');
const [digest, file, originFile, tmp, originTmp] = process.argv.slice(2);
const image = 'zot.lifemodel-system.svc:5001/lifemodel/workbench';
const placeholder = `${image}@sha256:${'0'.repeat(64)}`;
const originPlaceholder = `LIFEMODEL_WORKBENCH_DIGEST=sha256:${'0'.repeat(64)}\n`;
const text = fs.readFileSync(file, 'utf8');
const originText = fs.readFileSync(originFile, 'utf8');
const operation = /^(  )- target:\n\1    kind: StatefulSet\n\1    name: core\n\1  patch: \|-\n\1    - op: add\n\1      path: \/spec\/template\/spec\/containers\/0\/env\/-\n\1      value:\n\1        name: LIFEMODEL_TASK_WORKBENCH_IMAGE\n\1        value: ([^\n]+)$/gm;
const matches = [...text.matchAll(operation)];
const names = text.match(/^ *name: LIFEMODEL_TASK_WORKBENCH_IMAGE *$/gm) ?? [];
if (names.length !== 1 || matches.length !== 1 || matches[0][2] !== placeholder ||
    text.split(placeholder).length !== 2) {
  console.error('expected exactly one complete workbench image placeholder env operation');
  process.exit(1);
}
if (originText !== originPlaceholder) {
  console.error('expected exactly one complete workbench digest placeholder env entry');
  process.exit(1);
}
const reference = `${image}@${digest}`;
const originReference = `LIFEMODEL_WORKBENCH_DIGEST=${digest}\n`;
const result = text.replace(operation, (block) => block.replace(placeholder, reference));
const verified = [...result.matchAll(operation)];
if (verified.length !== 1 || verified[0][2] !== reference || result.includes(placeholder) ||
    result.replace(reference, placeholder) !== text) {
  console.error('workbench image pin verification failed');
  process.exit(1);
}
fs.writeFileSync(tmp, result);
fs.writeFileSync(originTmp, originReference);
NODE
mv "$tmp" "$file"
mv "$origin_tmp" "$origin_file"
