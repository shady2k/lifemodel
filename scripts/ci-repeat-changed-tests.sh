#!/usr/bin/env bash
# ci-repeat-changed-tests.sh — repeat a pull request's new and changed tests.
#
# CI runs this once, on a pull request, after the full check (lifemodel-hbsi).
# It diffs the merge base of the pull request's base branch and its head
# commit, selects the added or changed test files, and runs them five times in
# one disposable container through the isolated launcher.
#
#   BASE_REF   the pull request's base branch name (github.base_ref)
#   HEAD_SHA   its head commit (github.event.pull_request.head.sha)
#
# Both are required. Without them there is no change to repeat, and saying
# "nothing to repeat" would skip the check; a refusal is exit 2. A diff that
# cannot be computed is an error with exit 2, never a skip. Paths travel
# NUL-delimited end to end (`git diff -z`), so a name with a space, a tab or a
# quote reaches the launcher unchanged.
#
# No arguments, no network beyond the launcher's own boundary.
set -eu

if [ "${BASE_REF+set}" != set ] || [ -z "$BASE_REF" ]; then
    printf 'ci-repeat-changed-tests.sh needs BASE_REF (the pull request base branch)\n' >&2
    exit 2
fi
if [ "${HEAD_SHA+set}" != set ] || [ -z "$HEAD_SHA" ]; then
    printf 'ci-repeat-changed-tests.sh needs HEAD_SHA (the pull request head commit)\n' >&2
    exit 2
fi

root=$(git rev-parse --show-toplevel) || {
    printf 'ci-repeat-changed-tests.sh must run inside the checked-out repository\n' >&2
    exit 2
}
cd "$root"

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM

base=$(git merge-base "origin/$BASE_REF" "$HEAD_SHA") || {
    printf 'no merge base of origin/%s and %s in this checkout: the diff cannot be computed\n' "$BASE_REF" "$HEAD_SHA" >&2
    exit 2
}
git diff -z --no-renames --name-only "$base...$HEAD_SHA" > "$scratch/changed" || {
    printf 'git could not read %s...%s in this checkout: the diff cannot be computed\n' "$base" "$HEAD_SHA" >&2
    exit 2
}
scripts/ci-repeat-test-paths.sh < "$scratch/changed" > "$scratch/files" || exit $?

if [ ! -s "$scratch/files" ]; then
    echo 'no added or changed test file to repeat'
    exit 0
fi

printf 'repeating:\n'
tr '\0' '\n' < "$scratch/files"
set --
while IFS= read -r -d '' file || [ -n "$file" ]; do set -- "$@" "$file"; done < "$scratch/files"
start=$(date +%s)
status=0
node scripts/test-isolated.mjs repeat -- "$@" || status=$?
printf 'repeat run took %ss\n' "$(( $(date +%s) - start ))"
exit "$status"
