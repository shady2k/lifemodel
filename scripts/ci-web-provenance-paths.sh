#!/bin/sh
# Select the pinned shadcn provenance check for changes that can affect its inputs.
#
# No record at all is no evidence of safety either: when the producer emits no
# "changed:" line -- ci.yml's unknown-range fallback feeds it
# `ci-product-paths.sh < /dev/null`, which answers product=true with no
# records -- no path was readable, so the check is selected, the way the
# producer itself answers product=true on no input. No network, no clock, no
# arguments: the same list always gets the same answer. Its behaviour is
# pinned by tests/unit/ci-web-provenance-paths.test.ts.
set -eu
selected=false
read_any=false
while IFS= read -r line || [ -n "$line" ]; do
    # The producer emits `changed: <path>` lines followed by its own verdict.
    # Ignore the verdict and classify only paths from the producer's contract.
    case "$line" in
        "changed: "*) path=${line#"changed: "} ;;
        *) continue ;;
    esac
    read_any=true
    case "$path" in
        web/kit/*|web/app/*|scripts/shadcn-add.sh|web/app/components.json|web/kit/components.json|web/app/vite.config.*|web/app/vitest.config.*|web/app/tsconfig*.json|vitest.config.*)
            selected=true ;;
    esac
done
# Nothing was read: the range was unreadable, so the check runs.
[ "$read_any" = true ] || selected=true
printf 'web_app=%s\n' "$selected"
