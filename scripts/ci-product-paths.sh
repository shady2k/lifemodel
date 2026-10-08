#!/bin/sh
# ci-product-paths.sh — does this change owe the product checks?
#
# Reads the changed paths of one change on stdin, one path per line, exactly as
# `git diff --name-only` prints them, and prints on its last line
# "product=true" (the product checks are owed) or "product=false" (they are
# not). CI runs it into a file and reads that last line with
# scripts/ci-verdict.sh, which refuses any output that is not exactly one
# verdict on the last line, and writes it to $GITHUB_OUTPUT (lifemodel-cup).
# The paths it read are printed above it, so a surprising verdict can be read
# back against the diff it came from.
#
# A path that cannot change what the product does owes the backlog checks, not
# typecheck, lint, the format check and the suite:
#
#   * the tracker's export and store (.beads/), which is bookkeeping;
#   * the documents (docs/, and markdown at the repository root);
#   * the backlog gate and its rules (.backlog/), the same files the local
#     hooks run;
#   * the git hooks (.githooks/), which CI never executes, so a product run
#     would prove nothing about them;
#   * scripts/connect-clone.sh, which wires a clone and is never run by CI.
#
# Everything else is product: .github/ and the scripts and manifests that build
# and check the product, src/, tests/, and markdown that is not a repository
# document -- src/x.md documents the code beside it and is read with it. The
# classifier itself is product too: a change to how the checks are chosen has
# to be checked.
#
# No input at all is product: an empty diff is no evidence of safety. A caller
# that could not compute a diff (a first push, a forced update, a shallow
# clone) therefore gets "product=true" and says why it did.
#
# No network, no clock, no arguments: the same list always gets the same
# answer. Its behaviour is pinned by tests/unit/ci-product-paths.test.ts.
set -eu

if [ "$#" -ne 0 ]; then
    printf 'ci-product-paths.sh reads the changed paths on stdin, one per line; it takes no arguments, got: %s\n' "$*" >&2
    exit 2
fi

product=false
read_any=false
while IFS= read -r path || [ -n "$path" ]; do
    [ -n "$path" ] || continue
    read_any=true
    printf 'changed: %s\n' "$path"
    case "$path" in
        # Not product: nothing below the product. The first two patterns take a
        # whole tree; `*/*` below would count a nested path as product, so each
        # of these has to come first.
        .beads/*|docs/*|.backlog/*|.githooks/*|scripts/connect-clone.sh) ;;
        # Anything under a directory CI builds, tests or runs from is product.
        */*) product=true ;;
        # Markdown at the repository root is a document; markdown inside the
        # product was taken by the line above.
        *.md) ;;
        *) product=true ;;
    esac
done

# Nothing was read: no evidence of safety, so the product checks are owed.
[ "$read_any" = true ] || product=true

printf 'product=%s\n' "$product"
