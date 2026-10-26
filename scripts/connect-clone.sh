#!/bin/sh
# connect-clone.sh — connect this clone to the repository's hooks and backlog.
#
# `npm run connect` runs it. It is the one command a fresh clone needs before
# its first commit: it checks every local input a hook reads, points git at
# .githooks and connects the checkout to this machine's tracker store.
# Everything missing is reported in one
# run, and nothing is connected until nothing is missing: a clone with hooks and
# no `br` would refuse every commit-link check with a reason nobody set out to
# learn.
#
# The tracker lives outside the code branches (docs/backlog-integration.md,
# Tracker layout): one store per machine, a worktree detached at
# refs/tracker/state under $XDG_STATE_HOME/<main checkout name>/tracker, which
# .backlog/sync/tracker-sync.mjs keeps in step with the remote. connect creates
# it from the remote's ref where this machine has none, and links this
# checkout's .beads to it. The store is published at each recorded commit and
# before each push; no background sync is required (owner, 2026-10-20: one
# person, one machine). scripts/tracker-sync-service.sh can add one later.
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

for f in .githooks/pre-commit .githooks/commit-msg .githooks/pre-push .githooks/pre-merge-commit \
    .githooks/post-commit .githooks/post-merge .githooks/post-checkout; do
    [ -f "$f" ] || need "$f is missing from this checkout"
done
for f in adapter.mjs commits.mjs gate.mjs merge-gate.mjs recorded.mjs claim.mjs ready.mjs config.json br-policy.yaml \
    sync/tracker-sync.mjs sync/tracker-sync.version sync/argv.mjs sync/regular-file.mjs sync/trackers/br.mjs sync/supervisors/systemd-user/tracker-sync.service; do
    [ -f ".backlog/$f" ] || need ".backlog/$f is missing from this checkout"
done
for f in check.mjs time-format.mjs check-commits.mjs check-docs.mjs check-present.mjs check-product.mjs document-format.mjs regular-file.mjs argv.mjs; do
    [ -f ".backlog/rules/$f" ] || need ".backlog/rules/$f is missing from this checkout"
done
if [ -d .beads ] && [ ! -L .beads ] && [ -f .beads/issues.jsonl ]; then
    need ".beads here is a real tracker folder from before the tracker moved out of the branches; move it aside (mv .beads .beads.pre-move) and run npm run connect again — the store holds the tracker now"
fi

if [ "$missing" = 1 ]; then
    printf 'connect: nothing was connected; supply the above and run npm run connect again\n' >&2
    exit 1
fi

node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' .backlog/config.json || {
    printf 'connect: .backlog/config.json is not readable JSON\n' >&2
    exit 1
}


# The tracker first: this checkout's .beads becomes the link to this machine's
# store, which is made from the remote's refs/tracker/state where the machine
# has none yet. Safe to rerun: a connected checkout is left as it is. The hooks
# folder is set first, so the mechanism finds its record and relink steps
# already in .githooks (marked) and writes no hook of its own.
git config core.hooksPath .githooks
top=$(git rev-parse --show-toplevel)
node .backlog/sync/tracker-sync.mjs connect --checkout "$top" --recipe "$top/.backlog/sync/trackers/br.mjs" --prefix lifemodel \
    || { printf 'connect: the checkout could not be connected to the tracker store (lines above)\n' >&2; exit 1; }
# The project's own statuses (submitted, implemented) are br's policy file in
# the store; the recipe carries only the items and br's settings between
# machines, so every clone installs the project's copy.
store=$(cd .beads && pwd -P)
cmp -s .backlog/br-policy.yaml "$store/policy.yaml" || cp .backlog/br-policy.yaml "$store/policy.yaml"
br --no-color count >/dev/null 2>&1 || { printf 'connect: br cannot read the store at %s\n' "$store" >&2; exit 1; }

# The gate blocks in the husky hooks, so the gate runs whichever hooks
# directory ends up active (ours now, husky's after an npm ci).
mark='# --- BEGIN LIFEMODEL BACKLOG GATE ---'
append_block() {
    hook=$1; block=$2
    [ -e "$hook" ] || printf '%s\n' '#!/usr/bin/env sh' > "$hook"
    node --input-type=module - "$hook" "$block" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const [hook, block] = process.argv.slice(2);
const text = readFileSync(hook, 'utf8');
const begin = '# --- BEGIN LIFEMODEL BACKLOG GATE ---';
const end = '# --- END LIFEMODEL BACKLOG GATE ---';
const starts = text.split(begin).length - 1;
const ends = text.split(end).length - 1;
if (starts !== ends || starts > 1 || (starts && text.indexOf(end) < text.indexOf(begin))) {
    console.error(`connect: ${hook} has broken managed markers`);
    process.exit(1);
}
const prefix = starts ? text.slice(0, text.indexOf(begin)) : text;
if (/^\s*exec\s/m.test(prefix)) {
    console.error(`connect: ${hook} has an exec before its managed block`);
    process.exit(1);
}
const next = starts
    ? prefix + block.trim() + text.slice(text.indexOf(end) + end.length)
    : text + '\n' + block.trim() + '\n';
writeFileSync(hook, next);
NODE
    [ "$?" -eq 0 ] || exit 1
    chmod +x "$hook"
    sh -n "$hook" || { printf 'connect: %s is not a valid shell script\n' "$hook" >&2; exit 1; }
}

PRE_BLOCK='
# --- BEGIN LIFEMODEL BACKLOG GATE ---
if ! command -v node >/dev/null 2>&1 || [ ! -f .backlog/rules/check-product.mjs ]; then
    printf "pre-commit: the product-document check cannot run; run npm run connect\n" >&2
    exit 1
fi
node .backlog/rules/check-product.mjs --staged || exit 1
# Managed by scripts/connect-clone.sh. The tracker lives outside the code
# branches: .beads is the link to the store of this machine, never committed.
if git diff --cached --name-only --diff-filter=d -- .beads 2>/dev/null | grep -q .; then
    printf "TRACKER: a tracker file is staged; the tracker lives in the store of this machine, outside every branch. Unstage it: git restore --staged .beads\n" >&2
    exit 1
fi
node .backlog/gate.mjs --offline || exit 1
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

# No background sync is required (owner, 2026-10-20: one person, one machine).
# The store reaches the remote when a commit is recorded and before every push
# (.githooks/pre-push publishes it), which is what CI reads. A background sync,
# where one runs, only publishes sooner; say which it is.
if command -v systemctl >/dev/null 2>&1 && sh scripts/tracker-sync-service.sh status >/dev/null 2>&1; then
    printf 'connect: the tracker store is also published in the background (lifemodel-tracker-sync.service)\n'
else
    printf 'connect: the tracker store is published at each commit and push; no background sync runs\n'
fi

# Prove the gate runs here, now. A red verdict is the gate working; only an
# inability to run (exit 2) is a failed connection.
rc=0
node .backlog/gate.mjs --offline >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 2 ]; then
    printf 'connect: the backlog gate cannot run in this clone (exit 2); the hooks were left in place:\n' >&2
    node .backlog/gate.mjs --offline >&2 || true
    exit 1
fi
[ "$rc" -eq 0 ] || printf 'note: the backlog gate currently reports NEW problems; run: npm run backlog\n' >&2

if [ ! -d node_modules ]; then
    printf 'note: node_modules is absent — the product checks (lint-staged, tsc, vitest) are skipped until you run: npm ci\n' >&2
fi
printf 'connect: hooks from .githooks, .beads linked to the tracker store %s, every hook input present\n' "$store"
