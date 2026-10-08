#!/bin/sh
# ci-verdict.sh — the one verdict of a classification file, or a clear failure.
#
# usage: ci-verdict.sh <classification-file>
#
# Reads the classifier's output from <file> and prints its verdict, exactly
# "product=true" or "product=false", on stdout: the line CI appends to
# $GITHUB_OUTPUT. Anything else is an error, never a pass — a job whose
# `product` output is empty is skipped as if the change owed nothing, and a
# skipped job reports success to a required check (lifemodel-cup). It fails
# when the file is absent, when the classifier printed nothing, when nothing it
# printed is a verdict, when the last line is not exactly one, and when more
# than one was printed. Run on its own, never in a pipe, so its exit status is
# the step's.
set -eu

if [ "$#" -ne 1 ]; then
    printf 'usage: %s <classification-file>\n' "$0" >&2
    exit 2
fi

file="$1"

[ -f "$file" ] || {
    printf 'no classification file at %s: the classifier did not run\n' "$file" >&2
    exit 2
}
[ -s "$file" ] || {
    printf 'the classifier printed nothing in %s: no verdict to read\n' "$file" >&2
    exit 2
}

verdicts=$(grep -c '^product=' "$file" || true)
if [ "$verdicts" -eq 0 ]; then
    printf 'no verdict in %s: nothing of what the classifier printed is product=true or product=false\n' "$file" >&2
    exit 2
fi

last=$(tail -n 1 "$file")
case "$last" in
    product=true | product=false) ;;
    *)
        printf 'the last line of %s is not a verdict: %s\n' "$file" "$last" >&2
        printf 'the verdict has to be the last line and exactly product=true or product=false\n' >&2
        exit 2
        ;;
esac

if [ "$verdicts" -ne 1 ]; then
    printf 'the classifier printed %s verdict lines in %s: exactly one is expected, as the last line\n' "$verdicts" "$file" >&2
    exit 2
fi

printf '%s\n' "$last"
