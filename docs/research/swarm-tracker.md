# Research: a work tracker for a swarm of agents (lifemodel-653.3)

Date: 2026-10-13. Method: desk research over primary sources only — the
candidates' repositories (code, docs, CHANGELOGs, release notes), their issue
trackers fetched via the GitHub API at named commits, licence files and
raw.githubusercontent files. Read date for every external claim: 2026-10-13.
The project's side was read from this branch (the tracker layout in
`docs/backlog-integration.md`, the adapter and claim code under `.backlog/`,
and ADR-010's platform on `design/b0r-containers-simplify`). Facts from
sources carry their URL; author/vendor claims are marked; the design of our
own tracker is marked as inference throughout. No installs, no builds, no
test runs; `br` and the issue tracker were not touched.

## 1. The question and the recommendation

**Question.** lifemodel's tasks will run as a swarm: one prime-agent per task,
each a Kubernetes Job in its own pod, several at once, one node now, several
machines possibly later (ADR-010: k3s, Flux, CloudNativePG Postgres, Valkey,
OpenBao — `docs/adr/010-container-generations.md`, read 2026-10-13). They need
one shared tracker (issues, dependencies, claims, comments, statuses) that all
pods write to often and that STAYS consistent — today it is beads_rust 0.7 on
one SQLite file per machine with a JSONL export landed through git, which
works for one and cannot serve many pods. The owner reports that beads' server
mode gives a lot of merge headaches (§2 finds the mechanism). madarch has the
same need, so the answer may be a shared product.

**Recommendation: build the thin tracker — Postgres-backed, br-compatible CLI,
beads-format JSONL export — as a separate small product shared with madarch.**
Do NOT adopt upstream beads for the swarm: its storage is Dolt-only since
v0.51 (its SQLite, its JSONL sync pipeline and its daemon are all removed),
its cross-machine story merges replica databases cell-by-cell and carries a
documented class of merge breakdowns (schema forks, primary-key collisions
between two machines creating children under one parent, FK-vs-delete refusals,
stale denormalized state), and its own tracker still carries open reports of
double-claims under load. It would add a second stateful platform (a Dolt
sql-server or per-pod embedded databases) beside the Postgres ADR-010 already
runs, to solve a problem Postgres row locks solve directly (§2, §4.1). Our
own tracker is small because the adapter has kept the compatibility surface
tiny — one JSONL export file and ten CLI verbs (§6) — and the export keeps the
shady2k-skills adapter, gate and time records working unchanged.

Size of the build: one Postgres schema (5 tables), ~10 CLI verbs, an exporter,
and the adapter-conformance tests that already define correctness
(`.backlog/adapter.test.mjs`); one to two part-time weeks (§5, inference).

**A SEPARATE small product, shared with madarch.** madarch runs the same
shady2k-skills adapter over the same beads-format export, so BOTH projects
consume the same contract; a tracker that speaks beads-JSONL in and out
serves both, and each project's own policy layer (statuses beyond the
adapter vocabulary, per-project guard rules) stays configurable per
installation the way `.beads/policy.yaml` is today. Sharing also buys a
second user for every bug. Separateness keeps the tracker's storage and
releases independent of lifemodel's product code. Two supporting signals:
bead-forge's existence shows the br-compatible CLI is a stable contract
others already implement (§4.5), and beads_rust's MIT carries a rider
revoking OpenAI/Anthropic rights — a small friction for a product that may
later be developed with any vendor's agent (§4.2).

**What would change the recommendation:**

- beads turns its merge-failure classes into REAL fixes underneath the
  merge-settle patches (#4259/#4796/#6727 families) and lands
  transactional ready-claim (#5998, #3575); then adopting beads in server
  mode on one node becomes credible and should be re-tested hands-on.
- beads_rust ships a shared-server/network backend (#182, its top-P0 gap):
  then adopting it means adopting the frozen-classic design our skills
  already fit — re-evaluate immediately; it is the closest existing fit.
- the swarm stays one machine with few workers and the owner declines a
  second Postgres schema and a small build — then today's arrangement
  (beads_rust 0.7, landing-PR flow, `br sync --merge` never run) survives
  the swarm at ONE pod scale, but not many (§4.2, §6).
- contrary evidence about Plane/Gitea turns up (§4.4/§4.5: none expected —
  they solve human dashboards, not agent claims).

## 2. Why beads' server mode causes merge trouble

**What beads is today (facts, all read 2026-10-13).** beads (`bd`,
`github.com/gastownhall/beads`, MIT, Go; moved from `steveyegge/beads`) stores
issues in **Dolt** — a MySQL-wire-compatible SQL database with version control
built in. SQLite was the sole backend until v0.47.2 (Dolt "experimental",
2026-01-14), default for new projects in v0.50.0, removed entirely in v0.51.0
and v0.58.0 ("the SQLite storage layer and all migration infrastructure have
been removed. Dolt is the only backend." — CHANGELOG). **The JSONL sync
pipeline the npm-world knows — `bd sync` committing `.beads/issues.jsonl` to
git — was removed in v0.56.0 (2026-02-23)**: "the entire JSONL-based sync
system (`bd sync`, git-portable mode, belt-and-suspenders mode) has been
removed. Dolt-native sync only" (CHANGELOG). Today
`.beads/issues.jsonl` is "an export for viewers, interchange, migration, and
backup. It is not the canonical cross-machine sync channel"
(`docs/core-concepts/sync-concepts.md`, https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md).
Cross-machine sync is `bd dolt push` / `bd dolt pull` moving Dolt commits
through a remote — which may be the same git origin — under
`refs/dolt/data`, and pull performs a cell-level three-way merge into the
local replica (same page; `docs/getting-started/sync-setup.md`).

Two different things are called "server mode" in 2026:

1. **A Dolt sql-server** — `bd init --server`, `gt dolt start` /
   `dolt sql-server --port 3307` (or a shared multi-project server) — which
   several agents on ONE machine connect to as SQL clients
   (`docs/architecture/dolt.md`). It answers multi-writer concurrency on one
   host; it does NOT remove the per-replica merge problem across hosts: each
   clone still has its own Dolt database and still pushes/pulls to the
   remote.
2. **`bd serve`** — an HTTP surface over `/v0` shipped in v1.2.1 (2026-08-11),
   loopback-only by default, optional bearer token, no TLS, which refuses
   embedded-Dolt workspaces outright
   (`engdocs/design/bd-serve-v0.md`,
   https://github.com/gastownhall/beads/blob/main/engdocs/design/bd-serve-v0.md).
   `bd serve` is a front door in front of the same Dolt store; it does not
   change how replicas merge.

### The mechanism

The trouble is structural: every writer works on its OWN copy of a
version-controlled database, and consistency comes from repeating pull→merge→push
against a shared remote. Each of the three layers of that design produces its
own class of breakdown. (All quoted titles are beads' own issue tracker;
issue bodies were read on 2026-10-13.)

**(a) The merge layer — Dolt's three-way merge refuses or silently welds.**
Dolt merges SCHEMA changes and ROW changes, not logical operations, so a legal
concurrent edit can be un-mergeable or wrong:

- **Parallel schema forks make replicas permanently un-mergeable.** Two clones
  that upgraded bd independently applied migrations of the same version with
  different content; "their histories become permanently un-mergeable — Dolt
  refuses the merge outright (`cannot merge because table dependencies has
  different primary keys in its common ancestor`)" and the recovery is a
  bootstrap-from-canonical-clone recipe (CHANGELOG 1.1.0-rc.1, which built a
  designated-migrator gate `BD_ALLOW_REMOTE_MIGRATE=1` and per-migration
  SHA-256 hashes for issue #4259,
  https://github.com/gastownhall/beads/issues/4259).
  A LATER hole in the same class is still open: migration 0062 dropped the
  `events` table while an un-pulled clone still modified it
  — "the merge can only be aborted. The migrator is then permanently unable to
  absorb that clone's work, and the clone cannot adopt the new schema either"
  (#6727, https://github.com/gastownhall/beads/issues/6727, open).
- **Two machines creating children under one parent collide on ids.** Both
  allocate `pa-vubk.71` for DIFFERENT work; the pull then aborts on an
  add/add primary-key collision on `issues` plus a both-changed conflict on
  the parent's `child_counters` row — neither auto-resolvable, "sync is
  blocked indefinitely", recovery is a manual SQL-renumber runbook (#4796,
  https://github.com/gastownhall/beads/issues/4796, open).
- **Merge does not re-run foreign-key cascades**, so clone A deleting an issue
  while clone B comments on it makes the pull "fail outright with a
  foreign-key constraint violation ... and could never converge on retry"
  (CHANGELOG 1.1.0-rc.1, fixed by shipping an explicit cascade-repair
  auto-resolver); machine-local rows are versioned with the data and conflict
  on every pull (#2466, closed with auto-resolve,
  https://github.com/gastownhall/beads/issues/2466); a merge commit could
  silently REVERT concurrent writers' committed writes (CHANGELOG 1.3.0
  fixed the commit-time-merge case); and the denormalized `is_blocked`
  column goes stale after every merge until a recompute runs (CHANGELOG
  1.1.0-rc.1 — otherwise "hiding [the task] from `bd ready`").
- **Merge-path brittleness is patched case by case.** The pull auto-resolver
  ("`internal/storage/versioncontrolops/mergesettle.go`") special-cases
  metadata, audit tables and `schema_migrations` (#4796 quotes it); a
  tracked `dolt_ignore`d table deadlocks `bd sync` (#6368, open); one
  transport timeout aborts push/pull with a possible partial write and no
  retry (#6034, open); federation sync still uses a bare `CALL DOLT_MERGE`
  the fixed paths abandoned, so conflict-strategy resolution can hard-fail
  (#5564, open); table files can grow unbounded against a git+ssh remote,
  degrading pulls (#6359, open).

**(b) The transaction layer — no row locks, cell-level merge, lost updates.**
Dolt has explicitly no row-level locking: "Because Dolt has no row locking and
merges concurrent commits cell-by-cell, every status/ownership/lease-mutating
path also rewrites a shared `row_lock` cell" (CHANGELOG v1.2.1 — the fix for
a class where concurrent writes cell-merge into a state neither writer
intended, e.g. a heartbeat vs a reclaim producing a zombie claim, #6903,
https://github.com/gastownhall/beads/issues/6903). In the same spirit the
claim was OPENLY not-single-winner until the fix tracked in #7243 (guarded
delete, closed), and the ready-claim race is STILL open:

- "`bd ready` followed by `bd update <id> --claim` is not atomic. When
  multiple agent processes poll `bd ready` concurrently and both attempt to
  claim the same bead, both succeed — leading to duplicate work." (#3575,
  https://github.com/gastownhall/beads/issues/3575, open)
- "the claim is NOT a hard single-writer CAS under true sub-second
  concurrency" — both racers succeeded 5/5 (#4657,
  https://github.com/gastownhall/beads/issues/4657, open)
- "'bd ready --claim' is not transactional: two concurrent invocations both
  receive the same bead" — reproduced twice on 1.2.2 against a shared Dolt
  sql-server; the ask ("make claim a compare-and-swap on
  `(status=open, assignee unset)` inside one transaction") is EXACTLY what
  Postgres UPDATE ... WHERE gives for free (#5998,
  https://github.com/gastownhall/beads/issues/5998, open)

**(c) The server layer — it multiplies the surface without removing it.**
A Dolt sql-server arbitrates SQL access on one host, but every OTHER clone
(the laptop, the next node, the next pod) still has its own copy and still
pushes/pulls; and the server itself carries its own open problems: reads up
to days stale across concurrent sessions (#4746, open — "possible
long-lived dolt sql-server snapshot/transaction issue"), pooled connections
answering 503 after idle (`wait_timeout` expiry, #6737, closed post-fix),
unbounded memory growth with many databases (#7287, open, GOMEMLIMIT
workaround), 400-550% CPU at idle for a managed 4-agent town (#3760, open).
The HTTP door (`bd serve`) is refused on embedded-Dolt workspaces because
"its commit protocol runs outside the SQL transaction on a separate
connection" (bd-serve-v0.md) — i.e. the one default mode cannot even be
served transactionally.

**Minimum spin on "why merge trouble"** (the two-sentence answer the
report carries): every writer lives in its own versioned SQL replica and
stays consistent only by repeating pull→merge→push against a remote, so two
machines or pods doing ordinary concurrent work — migrating, creating sibling
children under one parent, deleting a parent, editing the same row — produce
schema forks, primary-key add/add collisions, cascade violations, stale
denormalized flags and plain conflict refusals, which beads has spent its
year of Dolt life patching case by case in an auto-resolver (#4259, #4796,
#6727, #2466, #5564). And because Dolt merges CELLS rather than row-locking
concurrent writers, CAS-shaped claims survive only inside single-server
transaction paths, which is exactly the layer the doubles slipped through
(#3575, #4657, #5998, #7243).

**Why this bites us specifically.** (1) We do not run their infra: we are a
git repo whose export `.beads/issues.jsonl` IS landed via PRs — the exact
pattern upstream deleted and now warns against ("It is not the source of
truth, not a full database backup, and cannot safely reconcile deletes or
pruning" — sync-setup.md). (2) The k3s pod swarm multiplies writers on a
shape (many short-lived replicas starting/stopping) where every pull must
merge and #4796's family converts the ordinary "two tasks created under one
feature in parallel" into a sync outage. (3) Keeping the shady2k-skills skills
adapter working against upstream means tracking the export shape of a storage
platform that swapped its backend twice in five months, against a project
whose own docs now say the export is not to be used for sync.

Wait — one correction to this section: beads_rust's `--merge` tombstone bug
(#541) is the beads_rust analogue; it lives in §4.2.

## 3. Comparison at a glance

| Criterion | beads (bd, Dolt) | beads_rust (br) | Backlog.md | Claude Task Master | Plane (self-host) | Gitea Issues | Our own (§5) |
|---|---|---|---|---|---|---|---|
| **Many pods/machines writing concurrently** | One Dolt server serves one machine (server mode); across machines every pod is its own replica doing pull-merge-push — schema forks, PK add/add collisions, FK-vs-delete refusals, stale denormalized state (#4259, #4796, #6727, §2) | One SQLite file per machine, file-lock serialized; across machines correctness rests on git+JSONL exchange; no shared-anything (#242, #457 history; README Limitations) | Per-checkout lockfile fail-fast (PR #860); across machines = users' own git push/pull, claims race (open #937) | Single tasks.json with proper-lockfile + atomic writes (PRs #1566/#1569); multi-machine NOT documented (#1637 open) | Server-mediated Postgres; optimistic locking at row level in-app; web/API concurrent edits normal-case OK (vendor claims; §4.4) | Server-mediated; one binary + Postgres; HTTP API CAS-free but server-mediated writes are last-write-wins per row (§4.5) | One Postgres cluster for all pods: row-lock serialization, single authoritative copy — the merge layer DOES NOT EXIST |
| **Atomic claim of a task** | Documented atomic; measured double-claims remain open (#3575, #4657, #5998; `--if-revision` CAS landed 1.2.x #7243) | `br update --claim --if-unchanged` (CAS on updated_at) works within one machine's store | None (custom-refs CAS proposed, open #937) | No claim primitive at all (inference from 36-tool set) | Issue assignment races possible; no claim primitive designed for agents (§4.4) | One assignee per issue; assignment is an ordinary API write, no claim CAS (§4.5) | One UPDATE with `assignee IS NULL AND status='open'` predicates inside a transaction; losers read the winner's assignee — #5998's exact ask |
| **Sync without git merges** | Dolt remotes only; `refs/dolt/data`; JSONL declared "not the canonical sync channel" (sync-concepts.md) | None — JSONL via git is the only cross-machine channel; `--merge` tombstone bug confirmed open (#541) | None designed; users' own git | None documented | Native: the server IS the shared state, no sync needed | Native: same | Native: same |
| **Dependencies + ready queue** | `bd ready` blocker-aware + `--claim`; typed deps; hierarchical ids | `br ready`/`br dep`; blocked cache | Frontmatter `dependencies`; no ready-queue query (inference) | `dependencies[]` + `task-master next` ready queue | Native issue relations; no agent-ready queue concept (§4.4) | Labels/assignee only; no dependency graph (§4.5 to verify lane) | Recursive/CTE over `blocks` edges; ready semantics kept EXACTLY where they are today (`ready.mjs` + claim guard) |
| **Interfaces** | CLI (primary), HTTP `bd serve` v0, MCP wrapper PyPI (beads-mcp), Go lib | CLI + MCP-over-stdio (`br serve`, non-default feature) | CLI, MCP (`backlog mcp start`), web UI, JSON reads | CLI + MCP server (npx task-master-ai, 36 tools) | REST API; CLI?; MCP? (§4.4) | REST API; first-class CLI admin/UI (§4.5) | br-compatible CLI (the 10 verbs), export file; HTTP/MCP deliberately later |
| **Footprint + licence** | Go binary with in-process Dolt (embedded) or Dolt server opt-in; dolt CLI pinned 2.2.0 for server mode; MIT | Single Rust binary, machine-local files; MIT + rider revoking OpenAI/Anthropic rights (GitHub: NOASSERTION) | Node CLI on user's tree; MIT | Node CLI; needs an LLM key for task generation; MIT + Commons Clause (no selling/hosting) | Server + Postgres + multiple containers (helm/chart); AGPL-3.0? (§4.4 to verify) | Single static binary + Postgres; MIT (§4.5) | One Postgres schema on the ALREADY-RUNNING CloudNativePG cluster + a small CLI binary; MIT |
| **Fit with shady2k-skills adapter (beads-format JSONL)** | Format provenance: upstream's export shape now DRIFTS (Dolt-era; 0.46-era compat frozen in br); upstream says do not use JSONL as sync | THE adapter's native input; v0.46-frozen conformance | No | No (JSON, not beads JSONL) | No | No | Very high by construction: emits the exact vocabulary `.backlog/adapter.mjs` maps (§5) |


## 4. The candidates, one section each

### 4.1 beads — `bd`, Dolt-backed (github.com/gastownhall/beads)

**Sources and commit read.** Lane: `swarm-tracker-lanes/beads.md`. Main @
85464f567aecc736059602dd0eab561bde7612b9, latest stable v1.3.1 (2026-09-30),
rc 1.3.2 (2026-10-10). MIT, Go. 108 top-level commands
(docs/cli-reference/index.md).

**Where it is now (facts).** Dolt-only backend (embedded in-process Dolt is
the DEFAULT since v0.63.3/1.0.0 — "embedded Dolt default on all platforms",
data under `.beads/embeddeddolt/`; server mode `.beads/dolt/` with a dolt
sql-server, shared-server at `~/.beads/shared-server/`, and proxied variants
opt-in for multi-writer — CHANGELOG, docs/architecture/dolt.md). The SQLite
stage of its life is gone, and with it the JSONL sync the world's docs still
describe. Hash-based top-level ids (`bd-a1b2`) "prevent merge collisions";
hierarchical epic ids (`pa-vubk.71`) collide EXACTLY as #4796 shows.

**Concurrency (facts).** Multi-writer = sql-server with
`BEGIN ... CALL DOLT_COMMIT()` transaction discipline (implemented 2026-02-24,
engdocs/design/dolt-concurrency.md); branch-per-worker (`BD_BRANCH`) retired
2026-02. Claim CAS: `--if-revision` shipped across five verbs in 1.2.x
(#7243 closed); claimed-lease semantics (TTL 5 m, `bd heartbeat`, `bd
reclaim`, schema v54) and merge slots (`bd merge-slot acquire/release`) to
serialize conflict-prone work. Still open: #3575, #4657, #5998 (claim races,
§2(b)), #6903 (no generation guard).

**Ready queue / deps (facts).** `bd ready` is blocker-aware with sort
policies and `--claim`; typed dependency edges with hierarchy; the ready
query got dedicated (status, updated_at) indexes for rigs >10K issues
(CHANGELOG 1.1.0-rc.1).

**Interfaces (facts).** CLI primary; HTTP `bd serve` v0 (loopback, bearer
token, typed conflicts 409 `already_claimed`, refuses embedded-Dolt
workspaces); MCP via separate `beads-mcp` PyPI wrapper that SHELLS the CLI —
the project itself recommends CLI+hooks over MCP ("uses ~1-2k tokens vs
10-50k for MCP schemas"; integrations/beads-mcp/README.md).

**Footprint + licence (facts).** One Go binary that link-includes the Dolt
engine; the standalone `dolt` CLI pinned 2.2.0 for server mode (2.3.x
regressed `DOLT_RESET('--hard')` on a measurable fraction of fresh
databases — docs/architecture/dolt.md). MIT (GitHub API).

**Verdict for our swarm.** On ONE node, `bd init --server` against a Dolt
sql-server genuinely answers "several pods claim work at once" — EXCEPT that
its own ready-claim race (#5998) is open, the server has its own
staleness/memory footguns (#4746, #7287), and every additional machine or an
embedded-per-pod shape brings back the pull-merge-push failure classes of
§2. Our adapter keeps reading the JSONL export, which upstream now calls
"not the canonical cross-machine sync channel" — we would adopt a product AT
ODDS with our landing flow. This is the strongest existing option and still
not the right one (§1).


### 4.2 beads_rust — `br` (github.com/Dicklesworthstone/beads_rust)

**Sources and commit read.** Lane: `swarm-tracker-lanes/beads_rust.md`. main @
8f26d4211e7a (pushed 2026-10-12), releases through v0.7.4 (2026-10-01).
We run br 0.7 here (`.backlog/config.json`, docs/backlog-integration.md).

**What it is (facts).** A RUST port deliberately frozen at the "classic
SQLite + JSONL" architecture of upstream beads ~v0.46 "rather than ask Steve
to maintain a legacy mode" (README, "Why This Project Exists"), with Steve's
endorsement. Storage: `.beads/beads.db` (FrankenSQLite — a pure-Rust SQLite
clone pinned `=0.4.10` in Cargo.toml), WAL mode, writers serialized by a
`.beads/.write.lock` with a 30 s default. MCP surface is stdio-only behind a
non-default `mcp` cargo feature; "br never runs a daemon"; Limitations table:
no Dolt backend, no real-time collaboration, no automatic multi-repo sync
(README).

**Concurrency (facts).** Within one machine: WAL + write lock + a mutation
retry loop; multi-process safety broke more than once — #242 ("recurring
SQLite corruption / DB-vs-JSONL drift under concurrent multi-agent br
writes", 0.1.38) and #457 (v0.5.3 malformed migrated databases under
concurrent writes, reproducible in 60 s; fixed in v0.5.5 via fsqlite
0.3.12). Across pods/machines: NOTHING shared — no network mode, no server
(#182, the top-gap P0 "remote sync backend", closed by the author as
"tracked internally" with no timeline).

**The merge story (facts).** Sync = `br sync` with a REQUIRED mode:
`--flush-only` DB→JSONL, `--import-only` JSONL→DB, `--merge` three-way vs
`.beads/beads.base.jsonl`, `--reconcile*` plan/apply, `--status`,
`--witness`. Sync never runs git. The tombstone danger the owner hit is a
CONFIRMED OPEN BUG: #541 — "`br sync --merge` reverts and deletes this
workspace's exported edits when the JSONL predates `beads.base.jsonl`
(reports `conflicts: 0`)"; an issue created and exported on a branch is
TOMBSTONED by a merge that reports success. It violates the merge-guard
invariant set (docs/SYNC_SAFETY.md, SYNC_SAFETY_INVARIANTS.md DL-6:
"absence from incoming JSONL never deletes a local record without
`--force-jsonl`"). Companion #543 (`--base <PATH>` for sync tooling) is open.
`--import-only --force` has its own history of dropping
labels/deps/comments of preserved tombstones (#268, fixed on main).

**Compatibility (facts).** br imports classic beads JSONL; conformance is
checked against bd v0.46.0; the two tools' live schemas and hashes DELIBERATELY
diverge — "Use JSONL interchange rather than assuming the two tools can share
an identical live database schema" (README FAQ). Upstream beads has moved to
Dolt-era shapes since; whether today's bd export still round-trips into br is
NOT verified (lane).

**Vocabularies (facts).** Claims are `br update <id> --claim --actor
--if-unchanged <updated_at>`; a CAS guard on the version witness. br>=0.7
introduced `--if-unchanged` (claim.mjs). Postgres: no abstraction point; a
Postgres backend would be a new storage port, not a configuration change
(INFERENCE, lane).

**Licence (facts).** MIT WITH a rider revoking rights for OpenAI and
Anthropic affiliates (GitHub shows `NOASSERTION`) — notable for a project a
company such as ours shares with agents that may be driven by any vendor.

**Verdict for our swarm.** Exactly what we have: excellent single-machine,
git-exchange across machines, known tombstone hazard on `--merge` (open),
and no network story. It is the direct ancestor of the design our skills
already fit — the cleanest thing we could adopt the DAY it gains a
shared/network backend (#182 reopened or shipped) or the day Postgres
dust-settles via a port someone else writes. Until then: keep the working
arrangement, avoid `--merge`, watch #541.


### 4.3 File-based trackers — Backlog.md and Claude Task Master

**Sources and read.** Lane: `swarm-tracker-lanes/file-based.md`; both repos read
at `main`, 2026-10-13.

### Backlog.md (MrLesk/Backlog.md)

(MrLesk, author handle in-repo; the lane brief's guess "by tobi" did NOT
resolve: the GitHub API 404s `tobi/backlog.md` and no backlog repo is in
tobi's public list — NOT VERIFIED/incorrect.)

- **Model:** ONE markdown file per task (`backlog/tasks/<prefix>-<n> - Title.md`)
  with YAML frontmatter (id, status, assignee, labels, dependencies,
  priority); no server; optional git; MIT. 7,014 stars, release v1.53.0
  (2026-09-24). https://github.com/MrLesk/Backlog.md
- **Concurrent writers (facts):** same-task edits used to LOSE silently
  (12/12 lost, both processes exit 0; #843, closed); the fix is a
  per-task filesystem lock with fail-fast contention and web/MCP 409
  (PR #860). Locks are per-checkout ("sibling worktrees never falsely
  contend"). ID allocation has its own lock (PR #565) with an open reuse
  bug (#997 — archived ids get reused).
- **Across machines:** the tool does no push at all (git layer = fetch/commit
  only); sync is the users' own push/pull; task files are merge-low-friction
  but NOTHING makes cross-machine claims atomic. A git-refs CAS design is an
  OPEN proposal: "Fetch-before-edit cannot close this distributed race"
  (#937, open). https://github.com/MrLesk/Backlog.md/issues/937
- **Deps/ready queue:** dependencies in frontmatter; no ready-queue query
  beyond status/dependency filtering (inference from CLI docs).
- **Interfaces:** CLI, MCP (`backlog mcp start`), local web UI, `--json`.
- **Fit:** a git-committed markdown tree could ride our landing-PR flow, but
  pods share no filesystem and none of the file trackers solve mutual
  exclusion across hosts — for the swarm it fails criterion 1–3.

### Claude Task Master (eyaltoledano/claude-task-master)

- **Model:** a single `tasks.json` (plus generated per-task .txt views),
  tasks/subtasks/dependencies per "tag"; `task-master next` IS a ready
  queue ("Identifies tasks that are pending/in-progress and have all
  dependencies satisfied"). Task generation needs a provider LLM key.
  https://github.com/eyaltoledano/claude-task-master
- **Concurrent writers (facts):** no documented concurrency before 2026;
  PR #1566/#1569 added `proper-lockfile` + atomic rename + in-lock re-read
  for cross-PROCESS safety; tag-state races remain open (#1637).
  Multi-machine: NOT DOCUMENTED anywhere we read. A JSONL-in-git backend is
  an OPEN alternative being pursued (PR #1619).
- **Atomic claim:** none (no claim/lease tool exists in its MCP/CLI surface —
  inference from the tool list).
- **Licence:** "MIT License with Commons Clause" — "the right to Sell the
  Software" is stripped (no hosting-as-a-service). A swarm-facing internal
  tool is unaffected, but it colors "shared product" ambitions.
  https://raw.githubusercontent.com/eyaltoledano/claude-task-master/main/LICENSE
- **Fit:** a PRD-to-tasks generator for ONE working tree; not a multi-pod
  tracker.


### 4.4 Trackers with a built API — Plane and Gitea Issues

### Plane (makeplane/plane)

- **What:** self-hosted project management (work items, states, cycles,
  modules, pages), REST v1/v2 + webhooks; AGPL-3.0 (NOT Apache-2.0 — the
  prompt's guess was wrong; LICENSE.txt on `preview`).
  https://github.com/makeplane/plane
- **Footprint (facts):** the in-repo compose runs 13 services — web, admin,
  space, api, worker, beat-worker, migrator, live, proxy, Postgres 15.7,
  Valkey 7.2.11, RabbitMQ 3.13.6, MinIO/Silo
  (docker-compose.yml @ preview). Helm chart and a one-container "Docker
  AIO" exist as official paths (developers.plane.so — vendor claims).
- **Concurrency (facts):** NO documented optimistic locking on issue PATCH —
  concurrent work-item edits silently overwrite, last writer wins
  (#9995, open, reporter's statement). Atomicity is being fixed
  endpoint-by-endpoint in the app (PR #9684, "make transfer_cycle_issues
  atomic", OPEN). No agent-grade claim primitive anywhere in the API docs.
  https://github.com/makeplane/plane/issues/9995
- **Ready queue:** none native (no dependency-graph blocking view over
  states; relations exist but no "ready work" concept).
- **MCP:** OFFICIAL, `makeplane/plane-mcp-server` (MIT): 30 tools, 207
  operations, stdio/HTTP/SSE, self-host via `PLANE_BASE_URL`.
  https://github.com/makeplane/plane-mcp-server
- **Verdict for our swarm:** a human dashboard product, AGPL, and a heavy
  multi-service stack, whose API model cannot even express "exactly one
  agent gets this row". Its MCP server is notable for OUR AGENT'S OWN
  interactive use in a LATER milestone, not as the swarm's write surface.

### Gitea Issues (go-gitea/gitea)

- **What:** self-hosted git forge; issues (+labels, assignees, dependencies)
  as a by-product; MIT; one binary "with SQLite, MySQL and PostgreSQL
  support" (arm64 binaries named for Raspberry Pi 4); one container +
  optional database service for the minimal Docker install.
  https://docs.gitea.com/installation/install-from-binary/
- **Issues API (facts):** REST with `assignees` arrays (singular `assignee`
  deprecated); optimistic locking DOCUMENTED ONLY FOR BODY EDITS —
  "Pass `content_version` to enable optimistic locking on body edits. If
  the version doesn't match the current value, the request fails with 409
  Conflict." (gitea.com swagger.v1.json; no If-Match/ETag anywhere).
  Whether an assignee PATCH can race safely is NOT VERIFIED — no documented
  guarantee either way.
- **Dependencies (facts): contrary to the assumption in our brief, a
  dependency API exists**: `GET/POST/DELETE
  /repos/{owner}/{repo}/issues/{index}/dependencies` ("all issues that
  block this issue"), POST body takes an owner/repo/index triple so edges
  cross repositories; verified LIVE with HTTP 200 on gitea.com
  (2026-10-13). No ready-queue native (an agent computes ready =
  unassigned AND not blocked itself); NO WEBHOOK EVENT for dependency
  changes (issue #11765, open since Gitea 1.11.6).
- **MCP:** official `gitea.com/gitea/gitea-mcp` (MIT, Go binary, stdio +
  stateless HTTP).
- **Verdict for our swarm:** light to run and API-clean, but the model is
  human-forge-shaped: statuses are forge states (open/closed), priorities
  and the ready-queue semantics our adapter needs (implemented-advisory,
  stage acceptance comments, held-leaf claims) would be a layer of
  conventions ON TOP of Gitea with no engine enforcement; the atomic-claim
  story is undocumented; and every write is still HTTP to a human forge for
  agents-as-workflows. A possible later UI layer; not the swarm's tracker.

### 4.5 Other agent-oriented trackers (short)

**Gas Town** (`gastownhall/gastown`, MIT, 18,351 stars): the orchestrator
product beads grew inside — "multi-agent workspace manager" (Mayor
coordinator, rigs, polecats; work state stored in the Beads ledger; convoys
assign beads). CLI only in what we read. It is where beads' server mode and
merge discipline evolved; its own users report the claim races in §2.
https://github.com/gastownhall/gastown

**MCP Agent Mail** (Python `Dicklesworthstone/mcp_agent_mail`, superseded by
`mcp_agent_mail_rust`; MIT + OpenAI/Anthropic rider): NOT a tracker —
"mail-like coordination layer for AI coding agents, exposed as an MCP server
with 45 tools and 25 resources, Git-backed archive, SQLite indexing"; agents
get identities, inboxes, searchable history and voluntary file-reservation
"leases". Complementary to a tracker (messages/comments/leases), not a
substitute for issues+claims. https://github.com/Dicklesworthstone/mcp_agent_mail

**bead-forge** (`jedarden/bead-forge`, 4 stars, MIT + rider): a
self-described "drop-in replacement for beads_rust (`br`) — every `br`
command works unchanged... adds atomic claiming via SQLite `BEGIN IMMEDIATE`
transactions, so 20 workers can claim work simultaneously without racing
each other". Its "20 workers" claim is the VENDOR's own (not verified by
us), and it inherits the same per-machine SQLite shape (no network story);
its atomic-claim-within-one-device fix is the same mechanism our §5 adopts
across the network on Postgres. Worth watching as THE proof that the
br-compatible CLI is a stable contract.
https://github.com/jedarden/bead-forge

**Linear as an agent context layer** — surfaced by beads' own tracker (issue
#2829, "Scoped Linear sync for parallel agent execution across worktrees"):
hosted, commercial; out of scope for a self-hosted swarm (not verified
further).



## 5. If we build it: the minimal shape (INFERENCE throughout)

Everything in this section is OUR OWN design reasoning, grounded in the local
facts below and in §§2-4; no external sources are cited in it.

Status: INFERENCE throughout. This lane is our own design reasoning, grounded in
the local facts below; no web sources are cited in it. Read date 2026-10-13.

### Local facts it stands on (all read 2026-10-13 in this worktree)

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

### The minimal shape

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

### Migration / adoption path (deliberate)

1. Stand up the schema + CLI; `br sync --import-only` from the current
   export one time (statuses/types/comments carry over verbatim).
2. Point `.backlog/claim.mjs` PATH/env at the new CLI first (same flags);
   run both in parallel one session, gate on the export diff.
3. Keep the landing-PR export flow; review whether a session still needs to
   land bookkeeping PRs once the tracker is live-backed — that flow exists
   ONLY because the database is machine-local. That is a decision for later,
   not in this research.

### Rough size

- Schema + migrations: a few hundred lines of SQL.
- CLI (Node/TS, Postgres driver): ~2-3k LOC for the ten subcommands and the
  exporter; testable against an ephemeral Postgres container, no
  serialization puzzle.
- Exporter/adapter conformance tests: re-run adapter.mjs against our export
  and diff against br's export — the conformance definition is ALREADY a
  byte-readable artifact (.backlog/adapter.test.mjs).
- Order: 1-2 weeks part-time for one engineer including tests (INFERENCE,
  no benchmark behind it).

### Deliberately left out

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

### Risks specific to this design

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


## 6. Risks and open points

**R1 — a new small system to own forever.** The thin tracker has no upstream.
Mitigations: keep the surface at the ten verbs; keep the adapter conformance
suites as the definition of done; consider extracting it into a separate
repository (the madarch-sharing plan) so it evolves independently of
lifemodel's product code.

**R2 — two CLI dialects during adoption.** Sessions carrying tasks AND pods
claiming them will speak `br` and the new CLI at the same time for a while.
Both must emit identical beads-format JSONL. Mitigation: byte-diff the two
exports in the adoption gate (design §5, adoption path; inference).

**R3 — the export's tombstone vocabulary.** Beads_rust's #541 semantics
(absence-from-export as deletion when `--merge` is involved) are what we
ALREADY only avoid by never running `--merge`; the new CLI should neither
need nor have a `--merge`: deletion is an explicit tombstone in Postgres,
exported as such. Any role `--force`-style waiver? Only claim.mjs's
implemented-advisory override carries it — `.backlog/config.json`,
`execution.claims`). The new CLI's README documents it as the ONLY waiver.

**R4 — servers as single points of both claim and consensus.** Postgres
holds the truth AND the arbitration. A tracker outage stops WORK STARTS but
not running tasks (Jobs keep running; the tracker is Claims+status, not the
bus). Reads should degrade to the LAST SUCCESSFUL export in git — which the
adapter already knows how to serve (`--at <rev>`) and the backlog gate
already treats as the honest snapshot on any branch that lacks a live one
(docs/backlog-integration.md, "Tracker layout").

**R5 — the export is not automatically in git.** Even with Postgres as the
source of truth, `.beads/issues.jsonl` remains the artifact the adapter,
gate, commit-link checks and historians read at revisions. The flush-to-git
cadence (currently session-landing PRs; per pre-commit hook a landing
ONLY on landing branches) stays as-is; per-write flush is NOT proposed.
Risk: the accepted revision of a stage may be behind Postgres truth by a
few minutes. Accept it (inference): the gate judges diffs OF THE EXPORT and
its semantics, not freshness claims.

**R6 — beads_rust's tombstone-bug class never reaching us.** We never ran
`--merge` (the pre-commit "Tracker layout" section forbids `br sync
--merge` as a catch-up: see docs/backlog-integration.md). Keep it that way
until the thin tracker replaces the flow. Watch #541.

**R7 — beads' fork moving fast.** Upstream changed storage model twice in
five months and renumbered export semantics with releases (watch the
`wire_revision` signal if any HTTP surface is against it — bd-serve-v0.md).
Irrelevant if we do not adopt, relevant to the export-shaped common
vocabulary: keep the adapter's vocabulary FROZEN; version the compatibility
in ledger from beads formats (write the shape in a plain table that cannot
drift silently — adapter is the ONLY consumer of its own parse).

**Open points for the owner (questions, not decisions).**
Q1 — max workers per machine → if it stays ≤4 system pods the design's
concurrency story is trivially fine at any size; the R2/R4 analysis holds
either way.
Q2 — the second Postgres schema lives in the SAME cluster or its own
CloudNativePG? (ADR-010 Q3: per-module credential on its own schema — same
cluster is the default reading.)
Q3 — commit the JSONL export from the tracker pod? The write side would be
a one-boarding: a small Job that flushes and pushes. The landing-PR flow is
needed only until the tracker replaces br's DB-per-machine reconciliation
completely (§5, migration).

## 7. NOT VERIFIED (nothing on this list was guessed, just not checked)

- beads: current binary size with the embedded Dolt engine (0.56.0-era
  notes: 168MB pre-embedded → ~41MB first embedded drop; current re-embed
  size not published/verified — lane).
- beads: whether `bd dolt push/pull` performance with >10k issues is
  NOWHERE measured in-repo (lane read none; not verified).
- plane: whether work-item PATCH accepts any version/If-Match field for a
  CAS claim; whether webhook payloads match the v2 endpoint promises
  (pages found via sitemap only); hardware sizing for self-host (lane).
- gitea: whether assignee PATCH races are safe in any backend (no doc
  guarantee; not tested); whether dependencies render as graph view in
  the UI; whether dependency REST works on a STABLE release (verified on
  a dev instance only); minimum hardware (lane).
- claude-task-master: whether the vendor's "Team Collaboration" page
  changes anything (linked from README, not read); multi-machine behavior
  not documented anywhere we read (lane).
- bead-forge: the "20 workers claim simultaneously without racing" claim —
  vendor's own, not reproduced (lane).
- gas town: whether it offers REST/MCP surfaces (README read covers CLI/gt
  only) (lane).
- `tobi/backlog.md` (the lane brief's authorship guess): the repo 404s and
  no backlog repo sits in tobi's public list; the project found and cited is
  MrLesk/Backlog.md instead.
- Our own CLI surface: whether `br where --json`'s full output contract has
  fields beyond `jsonl_path` needed anywhere (grep of .backlog shows only
  `jsonl_path` read TODAY — full output not audited; inference-to-check at
  build time).
- Whether beads's `bd serve` HTTP API v0 would EVER be exposed beyond
  loopback in k3s pods without a TLS/reverse proxy — architecture question
  unexamined because recommendation does not need it (this report).

## 8. Sources

**Beads (gastownhall/beads) — repository docs/engineering docs at main
@85464f5 (2026-10-13), fetched via raw.githubusercontent.com and the GitHub
API; releases and CHANGELOG at HEAD; all issue bodies read on 2026-10-13
via the GitHub API (all URLs in the lane file swarm-tracker-lanes/beads.md).**
Directly cited from the lane:

- docs/architecture/dolt.md — storage modes (embedded/server/shared),
  migration, Dolt 2.3.x DOLT_RESET pin, GC/federation.
  https://github.com/gastownhall/beads/blob/main/docs/architecture/dolt.md
- docs/core-concepts/sync-concepts.md — "Dolt is the source of truth",
  JSONL is an export only.
  https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md
- docs/getting-started/sync-setup.md — "Do not use JSONL as sync", push/pull
  rules, journal-corruption warning, stale refs/dolt/data recovery.
  https://github.com/gastownhall/beads/blob/main/docs/getting-started/sync-setup.md
- engdocs/design/dolt-concurrency.md — transaction discipline, cell-level
  merge, no row locking, branch-per-worker retirement.
  https://github.com/gastownhall/beads/blob/main/engdocs/design/dolt-concurrency.md
- engdocs/design/bd-serve-v0.md — bd serve v0 HTTP surface, typed 409
  already_claimed, embedded-Dolt refusal, wire_revision.
  https://github.com/gastownhall/beads/blob/main/engdocs/design/bd-serve-v0.md
- CHANGELOG.md@HEAD — the whole timeline of backend/model switches and the
  merge-failure fixes with their original issue numbers.
  https://github.com/gastownhall/beads/blob/main/CHANGELOG.md
- Issues (title quoted, all open unless noted): #3575, #4657, #5998 (claim
  races), #7243 (closed, guarded delete), #6903 (reaper), #4259 (schema
  fork; closed), #6727 (migration fork; open), #4796 (child-id collision),
  #2466 (closed metadata conflicts), #5564, #6034, #6368, #6359 (sync-path
  failures), #4746, #6737, #7287, #3760 (server-mode defects), #2829
  (Linear), #3791 (local-only tables request).
- README.md — Zero Conflict hash ids, MCP-badges, versioned refs.
  https://github.com/gastownhall/beads

**Beads_rust (Dicklesworthstone/beads_rust) — main @8f26d4 (2026-10-13),
releases through v0.7.4; all URLs in swarm-tracker-lanes/beads_rust.md.**

- README.md — storage/fsqlite/lock story, MCP stdio, Limitations table.
  https://github.com/Dicklesworthstone/beads_rust/blob/main/README.md
- docs/ARCHITECTURE.md — WAL mode, mutate transaction retry, schema v19.
  https://github.com/Dicklesworthstone/beads_rust/blob/main/docs/ARCHITECTURE.md
- docs/SYNC_SAFETY.md + .beads/SYNC_CLI_FLAG_SEMANTICS.md +
  .beads/SYNC_SAFETY_INVARIANTS.md — merge guards, tombstone retention
  invariants.
  https://github.com/Dicklesworthstone/beads_rust/blob/main/docs/SYNC_SAFETY.md
- Issues: #541 (tombstone-on-merge; OPEN), #543 (--base; OPEN), #182
  (multi-user parity P0; closed "tracked internally"), #242, #457
  (corruption history), #268, #548.

**Backlog.md / Claude Task Master / Plane / Gitea / Gas Town / MCP Agent
Mail / bead-forge — all URLs in swarm-tracker-lanes/file-based.md and
swarm-tracker-lanes/api-trackers.md, read 2026-10-13.**

Directly cited: MrLesk/Backlog.md #843/#860/#937/#997 and README;
eyaltoledano/claude-task-master PR #1566/#1569, issue #1637, PR #1619,
LICENSE; makeplane/plane LICENSE.txt + docker-compose.yml at `preview`,
issue #9995, PR #9684, plane-mcp-server README; go-gitea/gitea
swagger.v1.json (as served on gitea.com) + issue #11765 + gitea-mcp README
+ install docs; gastownhall/gastown README; mcp_agent_mail_rust README +
LICENSE; jedarden/bead-forge README + LICENSE.

**This repository — read 2026-10-13 on this branch:**

- docs/backlog-integration.md (Tracker layout, Landing a session,
  observations of the tombstone symptom).
- .backlog/adapter.mjs + adapter.test.mjs (the export vocabulary and its
  conformance suite).
- .backlog/claim.mjs (the guarded claim: br >=0.7 `--if-unchanged` CAS).
- .backlog/config.json (execution: claims wording; workers, review).
- docs/adr/010-container-generations.md on branch design/b0r-containers-simplify
  (the k3s platform: CloudNativePG, Valkey bus, namespaces, threat model).
- docs/charters/instance-1.md (charter outcome 6 per-task pods).

**Lane files kept on the branch as evidence: swarm-tracker-lanes/*.md
(five lane files, committed beside this report).**
