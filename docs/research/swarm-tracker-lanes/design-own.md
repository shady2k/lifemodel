# Design lane: our own thin tracker on Postgres (INFERENCE — no external sources)

Status: INFERENCE throughout. This lane is our own design reasoning, grounded in
the local facts below; no web sources are cited in it. Read date 2026-10-13.

## Local facts it stands on (all read 2026-10-13 in this worktree)

- **The platform already adopted Postgres.** ADR-010 (`docs/adr/010-container-generations.md`,
  branch design/b0r-containers-simplify) moves the instance onto k3s with
  Flux, CloudNativePG Postgres, Valkey, Traefik and OpenBao. "Postgres with
  pgvector holds memory and configuration — now as a CloudNativePG cluster."
  A tracker on Postgres adds ONE schema to a store already present, no new
  control plane. Per-module Postgres credentials on their own schema are the
  adopted isolation pattern; NetworkPolicy namespaces are default-deny, so a
  tracker pod reachable by task pods needs an explicit allow (design work, small).
- **Pods share no filesystem.** Each task runs as a Kubernetes Job in its own
  pod (ADR-010, charter outcome 6). Any tracker state that lives in pod-local
  files syncs only by shipping files around — exactly the merge problem.
- **The adapter is the compatibility surface** (` .backlog/adapter.mjs`,
  read 2026-10-13). It reads ONLY a beads-format JSONL export — never the
  database: rows need `id`, `title`, `description`, `issue_type` in
  {epic, task, bug, chore}, `status` in {open, blocked, in_progress,
  submitted, implemented, deferred, closed} (+ `tombstone` rows, dropped),
  `labels` (array), `assignee`, `created_at`, `updated_at`,
  `acceptance_criteria` (optional), `dependencies` as
  `[{type: 'parent-child'|'blocks', depends_on_id}]`, and `comments` as
  `[{id, created_at, author, text}]`. Marker comments:
  `submitted: <rev> -- <evidence>`, `implemented: ...`, `accepted: ...`
  (latest by created_at then id counts), work records start `[shady2k-time`.
  A status the adapter does not map is refused with exit 2, so an exporter
  that invents a status breaks the adapter — keep the exact vocabulary.
- **The local claim is already CAS-shaped** (`.backlog/claim.mjs`,
  read 2026-10-13): `br sync --flush-only --export-parallelism 1` →
  `br where --json` → readiness from the export →
  `br update <id> --claim --actor <actor> --if-unchanged <updated_at>`.
  The CAS guard is br's own (`--if-unchanged`, br>=0.7.0), and the readiness
  check itself is racing (read-then-write over flush+update), which a single
  Postgres UPDATE makes atomic for free.
- **What the skills call on the CLI today** (grep of .backlog/, 2026-10-13):
  `br --version`, `br where --json`, `br sync --flush-only`,
  `br update <id> --claim --actor --if-unchanged [--force]`,
  `br comments add <id> -f <file> --actor <actor>`
  (docs/backlog-integration.md), plus the standard create/update/list/ready
  the skills' own prompts assume. A drop-in must replicate the OUTPUT fields
  those commands read (see the adapter's field list), not br's internals.
- **Write rate is small.** beads' own sizing: "typical orchestrator rig:
  6-12 concurrent agents ... ~60-120 writes/minute, ~600-1200 reads/minute at
  peak" (engdocs/design/dolt-concurrency.md, 2026-02-22). Our swarm is the
  same scale. This is comfortable for plain Postgres — no exotic machinery.

## The minimal shape

**Storage: one Postgres schema** (CloudNativePG cluster, new database or the
existing one with its own role+schema). Five tables:

- `issues`: `id TEXT PK` (hash-suffixed, e.g. `lm-<node>-a1b2` or plain
  `lm-a1b2` — beads' hash-IDs rationale applies:
  https://github.com/gastownhall/beads README "Zero Conflict"),
  `title`, `description`, `acceptance_criteria TEXT NULL`,
  `issue_type` enum(epic,task,bug,chore), `status`
  enum(open,in_progress,submitted,implemented,deferred,closed,deleted) —
  no `blocked` column: blocked is DERIVED from dependencies at read time
  (the adapter maps blocked→open anyway), `assignee TEXT NULL`,
  `labels TEXT[]`, `created_at`, `updated_at` (the CAS witness),
  `version BIGINT NOT NULL` — a monotonic row version bumped on every write,
  used as the export's `updated_at` clock and the claim guard.
- `issue_deps`: `dependent_id`, `depends_on_id`, `type`
  enum(parent-child, blocks, related, discovered-from), PK
  (dependent_id, depends_on_id, type), FK both sides ON DELETE CASCADE.
- `comments`: `id UUID`, `issue_id` FK, `created_at`, `author`, `text`,
  PK issue_id+id ordering by created_at (adapter sorts by created_at then id).
- `events` (optional, small): append-only audit for later replay/debugging —
  Postgres-only, nothing syncs to machines.
- `attachments`/files: NOT in v1; evidence lives in comments.

**Atomic claim.** A claim is ONE statement inside one transaction:

```sql
UPDATE issues SET assignee=$actor, status='in_progress', version=version+1, updated_at=now()
WHERE id=$id AND (assignee IS NULL OR assignee='') AND status='open';
```

READ COMMITTED row locking: concurrent claimers serialize on the row; exactly
one UPDATE matches (1 row) and the loser matches 0 rows → mapped to the same
shape as beads serve's 409 `already_claimed` with the current assignee read
inside the losing transaction (engdocs/design/bd-serve-v0.md, the claim —
we adopt the same posture). The `--if-unchanged` CAS variant the current
claim.mjs passes (guard on updated_at) stays available: it is one more
predicate on the same UPDATE. The claim's readiness gate (leaf, no open
blocker, not implemented-dependency) STAYS in the calling script
(.backlog/claim.mjs logic is ported unchanged); advisory override semantics
keep working because readiness lives outside the store.

**Ready queue.** One CTE query, no daemon:

```sql
WITH open_blockers AS (
  SELECT d.dependent_id FROM issue_deps d JOIN issues b ON b.id = d.depends_on_id
  WHERE d.type = 'blocks' AND b.status NOT IN ('closed','implemented')
)
SELECT * FROM issues i WHERE i.status='open' AND i.assignee IS NULL
  AND i.id NOT IN (SELECT dependent_id FROM open_blockers);
```

ready.mjs's leaf rule and the implemented-advisory override are project
policy in the calling script, as today. Indexes: (status, updated_at) on
issues; (depends_on_id, type), (dependent_id, type) on issue_deps — the
same composite the beads CHANGELOG added for its own ready query
(CHANGELOG 1.1.0-rc.1, migration 0052).

**Events.** The write path appends the event to a Valkey stream (the adopted
bus) after commit — the same event shape any core module already publishes;
NOTIFY inside Postgres is available later, but pods that care about the
tracker are the same pods running the bus anyway, and one bus avoids two
event mechanisms. If nobody needs live push, v1 can skip events entirely and
keep a `version`/`updated_at` poll — the write rate makes a 1-3 s poll cheap
(INFERENCE).

**Interfaces.**

- `br`-COMPATIBLE CLI first (a Node/TS binary in the deploy image; it talks
  to Postgres over the pod's own credential): the exact subcommands above —
  `where --json`, `sync --flush-only`, `update --claim --if-unchanged`,
  `comments add -f`, `create`, `list --json`, `show`, `close`, `dep add`,
  `ready`. Fields in JSON output match the export's per-row shape (the
  adapter's reading list) so nothing downstream changes.
- Export command (`sync --flush-only`): one transaction snapshot serialized
  to `.beads/issues.jsonl` in the EXACT adapter vocabulary
  (statuses/types/deps/comments as above; deleted issues exported as
  `tombstone`; `blocked` never emitted). The landing-PR flow
  (docs/backlog-integration.md, "Landing a session") keeps working unchanged;
  a fresh clone boots with `--import-only` into Postgres.
- MCP server LATER; v0 HTTP LATER. Nothing in the current toolchain needs
  them (the adapter and rules read the export; the run script reads the
  adapter; only claim/comments/where touch the CLI).

**Concurrency across pods and machines.** Every pod opens ONE shared
Postgres cluster — no per-machine database, no merge, no tombstones, no
counters to reconcile. Two pods claiming one task: one UPDATE wins
(row-lock serialization); both listing: consistent reads. Two machines
later: they reach the same Postgres (CloudNativePG is already the adopted
stateful layer; if machines split, the Postgres cluster still lives where
it does and stays ONE). That deletes the whole sync problem instead of
managing it — the reason a shared server beats per-machine stores for this
swarm shape (INFERENCE).

## Migration / adoption path (deliberate)

1. Stand up the schema + CLI; `br sync --import-only` from the current
   export one time (statuses/types/comments carry over verbatim).
2. Point `.backlog/claim.mjs` PATH/env at the new CLI first (same flags);
   run both in parallel one session, gate on the export diff.
3. Keep the landing-PR export flow; review whether a session still needs to
   land bookkeeping PRs once the tracker is live-backed — that flow exists
   ONLY because the database is machine-local. That is a decision for later,
   not in this research.

## Rough size

- Schema + migrations: a few hundred lines of SQL.
- CLI (Node/TS, Postgres driver): ~2-3k LOC for the ten subcommands and the
  exporter; testable against an ephemeral Postgres container, no
  serialization puzzle.
- Exporter/adapter conformance tests: re-run adapter.mjs against our export
  and diff against br's export — the conformance definition is ALREADY a
  byte-readable artifact (.backlog/adapter.test.mjs).
- Order: 1-2 weeks part-time for one engineer including tests (INFERENCE,
  no benchmark behind it).

## Deliberately left out

- Any merge machinery (two-sided export/import, tombstone recovery, base
  snapshots) — one Postgres deletes the problem.
- Any Dolt/versioned SQL layer, per-write history, compaction ("memory
  decay"), wisps/molecules, federation peers, hooks, auto-commit, daemon
  process management. Comments + events + git-landed exports cover audit.
- Multi-instance per-pod databases (beads' per-rig model).
- A web UI; readiness/claims stay CLI/agent-facing (Plane/Gitea exist if a
  human dashboard is ever needed — see the api-trackers lane).
- Renaming fields away from the adapter vocabulary — the gate and the skills
  read it byte-for-byte; ANY change to statuses/types/deps shapes must land
  as an adapter update in the SAME change, or the backlog gate refuses.

## Risks specific to this design

- **We own a tracker forever.** No upstream fixes arrive; the adapter
  conformance suite is the only guard. Mitigation: keep the CLI surface at
  the ten commands; conformance tests against adapter.mjs.
- **Two CLI dialects in the house** (beads_rust for old sessions, own CLI
  for pods) until adoption completes — the gate reads exports from both, so
  both must emit identical JSONL shapes; conformance tests cover it.
- **Postgres is a single dependency** for claims (a tracker outage pauses
  all claims). Mitigation: CloudNativePG is already an adopted, running
  layer; the tracker is one schema on it, and claims fail closed (a pod
  that cannot claim, does not start work) — the same failure the current
  git-landing flow already produces, minus the merge surprises.
