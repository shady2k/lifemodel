#!/bin/sh
# connect-clone.sh — connect this clone to the repository's hooks and backlog.
#
# `npm run connect` runs it. It is the one command a fresh clone needs before
# its first commit: it checks every local input a hook reads, points git at
# .githooks, and imports the tracked backlog into br's database. Everything
# missing is reported in one run, and nothing is connected until nothing is
# missing: a clone with hooks and no `br` would refuse every commit-link check
# with a reason nobody set out to learn.
#
# It also appends the backlog gate to .husky/pre-commit and .husky/commit-msg,
# marked and idempotently: husky (npm ci) sets core.hooksPath=.husky/_ and
# would otherwise run only the product checks, leaving the gate out. With the
# blocks in place, the gate runs whichever hooks directory is active.
#
# The product checks (lint-staged, tsc, vitest) need node_modules. When it is
# absent, connect still succeeds — the gate hooks run on node and git alone —
# and says plainly that the product checks are skipped until `npm ci`.
#
# Safe to rerun.
set -u

missing=0
need() {
    printf 'connect: %s\n' "$1" >&2
    missing=1
}

command -v git >/dev/null 2>&1 || need "git is not on PATH"
command -v node >/dev/null 2>&1 ||
    need "node is not on PATH — the backlog and commit-link hooks run on it; install Node.js 24+ (see README.md)"
command -v br >/dev/null 2>&1 ||
    need "br is not on PATH — the commit-link hook resolves tasks through it; install beads_rust (github.com/Dicklesworthstone/beads_rust)"

for f in .githooks/pre-commit .githooks/commit-msg .githooks/pre-push .githooks/pre-merge-commit; do
    [ -f "$f" ] || need "$f is missing from this checkout"
done
for f in adapter.mjs commits.mjs gate.mjs merge-gate.mjs config.json; do
    [ -f ".backlog/$f" ] || need ".backlog/$f is missing from this checkout"
done
for f in check.mjs time-format.mjs check-commits.mjs check-docs.mjs check-present.mjs document-format.mjs; do
    [ -f ".backlog/rules/$f" ] || need ".backlog/rules/$f is missing from this checkout"
done
[ -f .beads/issues.jsonl ] || need ".beads/issues.jsonl is missing from this checkout"

if [ "$missing" = 1 ]; then
    printf 'connect: nothing was connected; supply the above and run npm run connect again\n' >&2
    exit 1
fi

node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' .backlog/config.json || {
    printf 'connect: .backlog/config.json is not readable JSON\n' >&2
    exit 1
}

git config core.hooksPath .githooks

# The tracker first: a fresh clone has the committed export but no database,
# and the commit-link hook reads br's own view. br builds it from the export; a
# connected clone already has one and is left alone. br never runs git.
br count >/dev/null 2>&1 || br sync --import-only --quiet >/dev/null \
    || { printf 'connect: br could not build its database from .beads/issues.jsonl\n' >&2; exit 1; }

# The gate blocks in the husky hooks, so the gate runs whichever hooks
# directory ends up active (ours now, husky's after an npm ci).
mark='# --- BEGIN LIFEMODEL BACKLOG GATE ---'
append_block() {
    hook=$1; block=$2
    [ -e "$hook" ] || printf '%s\n' '#!/usr/bin/env sh' > "$hook"
    if ! grep -Fq "$mark" "$hook"; then
        if grep -qE '^[[:space:]]*exec[[:space:]]' "$hook"; then
            printf 'connect: %s ends in an exec; a block appended after it would never run.\n' "$hook" >&2
            exit 1
        fi
        printf '\n%s\n' "$block" >> "$hook"
    fi
    chmod +x "$hook"
    sh -n "$hook" || { printf 'connect: %s is not a valid shell script\n' "$hook" >&2; exit 1; }
}

PRE_BLOCK='
# --- BEGIN LIFEMODEL BACKLOG GATE ---
# Managed by scripts/connect-clone.sh. The tracker export lands only through a
# session landing branch (land/<name>) and its pull request; refuse it staged on
# any other branch but main (the seeding commit of the installation itself is
# the exception).
if git diff --cached --name-only -- .beads/issues.jsonl 2>/dev/null | grep -q .; then
    _branch=$(git symbolic-ref --quiet --short HEAD || echo "a detached HEAD")
    case "$_branch" in
        main|land/*) ;;
        *)
            if git rev-parse -q --verify HEAD:.backlog/config.json >/dev/null 2>&1; then
                printf "TRACKER: the tracker export is staged on %s; it lands only through a land/<name> branch and its pull request. Unstage it: git restore --staged .beads/issues.jsonl\n" "$_branch" >&2
                exit 1
            fi
            ;;
    esac
fi
node .backlog/gate.mjs || exit 1
# --- END LIFEMODEL BACKLOG GATE ---'

MSG_BLOCK='
# --- BEGIN LIFEMODEL BACKLOG GATE ---
# Managed by scripts/connect-clone.sh. Every commit names its leaf task.
if command -v node >/dev/null 2>&1 && [ -f .backlog/commits.mjs ]; then
    node .backlog/commits.mjs --message-file "$1" || exit 1
else
    printf "commit-msg: the commit-link check cannot run here; run npm run connect\n" >&2
    exit 1
fi
# --- END LIFEMODEL BACKLOG GATE ---'

append_block .husky/pre-commit "$PRE_BLOCK"
append_block .husky/commit-msg "$MSG_BLOCK"

# Prove the gate runs here, now. A red verdict is the gate working; only an
# inability to run (exit 2) is a failed connection.
rc=0
node .backlog/gate.mjs --worktree >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 2 ]; then
    printf 'connect: the backlog gate cannot run in this clone (exit 2); the hooks were left in place:\n' >&2
    node .backlog/gate.mjs --worktree >&2 || true
    exit 1
fi
[ "$rc" -eq 0 ] || printf 'note: the backlog gate currently reports NEW problems; run: node .backlog/gate.mjs\n' >&2

if [ ! -d node_modules ]; then
    printf 'note: node_modules is absent — the product checks (lint-staged, tsc, vitest) are skipped until you run: npm ci\n' >&2
fi
printf 'connect: hooks from .githooks, backlog imported, every hook input present\n'
