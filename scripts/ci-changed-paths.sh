#!/bin/sh
# ci-changed-paths.sh — the paths one revision range changed, classified.
#
# usage: ci-changed-paths.sh <git-range>
#
# Prints what the classifier prints for the paths of <git-range>: one
# "changed: <path>" line per path, and the verdict on the last line, which CI
# writes to $GITHUB_OUTPUT (lifemodel-cup). This is the only place CI reads a
# diff, so the same answer can be read by hand in a checkout:
#
#   scripts/ci-changed-paths.sh "$base...$head"    # a pull request
#   scripts/ci-changed-paths.sh "$before..$after"  # a push
#
# `--no-renames` is the point of this script. `git diff --name-only` reports a
# detected rename by its destination alone, so moving product code into docs/
# would reach the classifier as one document path and answer product=false —
# a deletion that breaks imports could then merge without typecheck, lint or
# the suite. With `--no-renames` both sides of the move are paths of the
# change, and a move out of product code is also a deletion in it.
#
# The diff and the classifier run one after the other, each into a file, with
# its own exit status: through a pipe a failure would be swallowed and an empty
# output would look like an answer, which is exactly how a green job once came
# out of a broken classifier. Called by the `changes` job of
# .github/workflows/ci.yml and by tests/unit/ci-product-paths.test.ts.
set -eu

if [ "$#" -ne 1 ]; then
    printf 'usage: %s <git-range>  (for example <base>...<head> or <before>..<after>)\n' "$0" >&2
    exit 2
fi

range="$1"
here=$(dirname "$0")
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM

# A range this checkout cannot read is not an answer: the failure is named
# here and the script leaves non-zero instead of classifying nothing.
if ! git diff --no-renames --name-only "$range" > "$scratch/changed-paths.txt"; then
    printf 'git could not read the range %s in this checkout: no diff, so no verdict\n' "$range" >&2
    exit 2
fi

# The classifier on its own, its exit status read by this script and a failure
# named rather than passed on as an empty answer.
if ! "$here/ci-product-paths.sh" < "$scratch/changed-paths.txt"; then
    printf 'the classifier %s failed on the paths of %s: no verdict is trusted from it\n' "$here/ci-product-paths.sh" "$range" >&2
    exit 2
fi
