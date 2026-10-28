#!/bin/sh
# Same producer contract and unknown-range fail-safe as ci-loader-paths.sh.
set -eu
selected=false
read_any=false
while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
        "changed: "*) path=${line#"changed: "} ;;
        *) continue ;;
    esac
    read_any=true
    case "$path" in
        docker/workbench/*|docker/loader/lifemodel-storage|loader/*|src/ports/task-harness-registry.json|package.json|package-lock.json|.github/workflows/ci.yml|.github/workflows/release.yml|scripts/ci-workbench-paths.sh|scripts/smoke-image-modules.sh|scripts/task-agent-provision.mjs|scripts/task-agent-paths.mjs|scripts/task-start-manifest.mjs|src/ports/task-agent-validation.*|scripts/release/set-workbench-digest.sh)
            selected=true ;;
    esac
done
[ "$read_any" = true ] || selected=true
printf 'workbench_image=%s\n' "$selected"
