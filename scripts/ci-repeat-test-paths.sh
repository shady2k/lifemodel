#!/bin/sh
# ci-repeat-test-paths.sh — which test files a change makes worth repeating.
#
# Reads the changed paths of one change on stdin, one path per line, exactly as
# `git diff --name-only` prints them, and prints on stdout the test files the
# repeat mode runs: added or changed files under tests/ that are still there
# when the list is made (lifemodel-hbsi). CI passes that list to
# `node scripts/test-isolated.mjs repeat -- <files>`; an empty list means the
# change brought no new or changed test file, and the step says so and stops.
#
#   * only `tests/**/*.test.ts` is repeated: a helper, a fixture or a document
#     under tests/ changes what these files do but is not itself a test, and a
#     test file can be deleted under tests/ and now fail to load;
#   * a path that is no longer in the working tree is not repeated: `git diff`
#     reports a deletion as a changed path, and the launcher would be given a
#     file that cannot run;
#   * the output is sorted and deduplicated, so an unchanged input always
#     yields an unchanged list, whatever order git printed the paths in;
#   * no input prints nothing on stdout and says so on stderr: "nothing to
#     repeat" is an answer here, not an error, because a change that added no
#     test file owes no repetition.
#
# No arguments, no network, no clock: the same paths over the same tree always
# print the same list. Its behaviour is pinned by
# tests/unit/ci-repeat-test-paths.test.ts.
set -eu

if [ "$#" -ne 0 ]; then
    printf 'ci-repeat-test-paths.sh reads the changed paths on stdin, one per line; it takes no arguments, got: %s\n' "$*" >&2
    exit 2
fi

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
: > "$scratch/files"

while IFS= read -r path || [ -n "$path" ]; do
    [ -n "$path" ] || continue
    case "$path" in
        # `*` matches a slash in a shell pattern, so this covers every depth
        # under tests/, as tests/**/*.test.ts does.
        tests/*.test.ts) ;;
        *) continue ;;
    esac
    # A deleted test file is a changed path with no file behind it.
    [ -f "$path" ] || continue
    printf '%s\n' "$path" >> "$scratch/files"
done

if [ -s "$scratch/files" ]; then
    sort -u "$scratch/files"
else
    printf 'no added or changed test file under tests/ to repeat\n' >&2
fi
