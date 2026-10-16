#!/bin/sh
# Select the pinned shadcn provenance check for changes that can affect its inputs.
set -eu
selected=false
while IFS= read -r path || [ -n "$path" ]; do
    case "$path" in
        web/kit/*|web/app/*|scripts/shadcn-add.sh|web/app/components.json|web/kit/components.json|web/app/vite.config.*|web/app/vitest.config.*|web/app/tsconfig*.json|vitest.config.*)
            selected=true ;;
    esac
done
printf 'web_app=%s\n' "$selected"
