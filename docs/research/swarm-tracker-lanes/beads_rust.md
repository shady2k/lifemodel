# beads_rust (`br`, github.com/Dicklesworthstone/beads_rust) — research lane

Read at: repo state `main` @ `8f26d4211e7a` (pushed 2026-10-12T22:55Z), releases through
v0.7.4 (2026-10-01). Raw files fetched from raw.githubusercontent.com at that HEAD;
issue data from the GitHub REST API. Reading date 2026-10-13. We run br 0.7.x.

## Summary

- **Storage is SQLite-family only, single-host.** br stores issues in `.beads/beads.db`
  (FrankenSQLite — a pure-Rust SQLite clone, `fsqlite` crates pinned `=0.4.10`) in WAL
  mode, with a `.beads/.write.lock` serializing all writers on one machine (default write
  wait 30 s, `--lock-timeout <ms>`). Multi-process concurrency was repeatedly corrupted
  in the past (issues #242, #457); the engine-level fix landed in fsqlite 0.3.12 / br
  v0.5.5. There is NO shared-server or network mode. With 20 pods on different machines
  there is no shared lock and no shared FS, so correctness rests entirely on git +
  JSONL exchange — FACTS FROM SOURCES (README; docs/ARCHITECTURE.md).
- **`br sync` is explicitly one-directional and local-only.** Bare `br sync` is refused;
  you must name the mode: `--flush-only` (DB→JSONL export with anti-loss guards),
  `--import-only` (JSONL→DB), `--merge` (three-way vs `beads.base.jsonl`), `--reconcile`,
  `--reconcile-additive`, `--status`, `--witness`. Sync never runs git and never touches
  the network — FACTS FROM SOURCES (README Architecture/Safety Model; .beads/SYNC_CLI_FLAG_SEMANTICS.md).
- **`--merge` tombstone danger is real and confirmed upstream as open bug #541.** With
  default `deletions_retention_days: None`, "tombstone retention alone is not deletion
  evidence" (invariant DL-6), but `--merge` treats an issue absent from the incoming
  JSONL as deleted when local == base — and our observed failure (export on a branch,
  then merge a JSONL that predates `beads.base.jsonl`) tombstones the local issue and
  reports `conflicts: 0`. #541 reproduces this on 0.7.4 and proposes the fix; it is OPEN
  (0 comments, state as of 2026-10-13). Companion feature request #543 (`--base <PATH>`)
  is also open. FACTS FROM SOURCES (#541; docs/SYNC_SAFETY.md Merge Guards).
- **Upstream-beads compatibility: JSONL is a shared interchange, not a shared database.**
  br imports classic beads JSONL "conformance is checked against bd v0.46.0"; br has
  extra fields/tables and its "length-prefixed content hashes deliberately differ from
  classic bd hashes. Use JSONL interchange rather than assuming the two tools can share
  an identical live database schema." The project's whole existence is a frozen snapshot
  of classic beads ("Steve has given his full endorsement"); upstream is NOT tracked —
  br intentionally diverged by freezing. FACTS FROM SOURCES (README FAQ + Why This
  Project Exists; docs/TEST_HARNESS.md "Known divergences from bd 0.46.0").
- **Multi-machine story = git only, with known sharp edges.** Routes/`external:` deps
  are local dispatch tables, not sync (README FAQ); a `br sync --remote <url>` backend
  is the top P0 gap requested in #182 and was closed by the author as "tracked
  internally" with no timeline; #543 names sync scripts for "multiple machines or
  clones" as the use case needing `--base`. No REST API anywhere. FACTS FROM SOURCES
  (#182, #543, README Limitations: no daemon, no real-time collaboration, no automatic
  multi-repo sync).
- **Versions & license:** v0.1.0 (2026-01-18) → v0.7.4 (2026-10-01); ~24 published
  releases in 0.2–0.7; project explicitly a frozen port, 0.x throughout, stability
  language per minor line ("Late 0.2 stabilization", "stabilization cut on the 0.5
  line"). License: MIT **plus a rider** that revokes rights for OpenAI and Anthropic
  and their affiliates/agents (GitHub shows SPDX `NOASSERTION`). FACTS FROM SOURCES
  (releases list; CHANGELOG.md; LICENSE).
- **CLI/MCP surface:** CLI has 30+ commands (lifecycle, ready/blocked/search, deps,
  labels, comments, coordination, doctor, schema, sync); `br ready` = open + not
  blocked + not deferred (configurable ready status group in `.beads/policy.yaml`);
  deps are `br dep add A B` (A blocked by B). MCP: `br serve` (MCP-over-stdio, launched
  by the client, no network port) behind the non-default `mcp` feature; tools
  `list_issues/show_issue/create_issue/update_issue/close_issue/manage_dependencies/project_overview`.
  FACTS FROM SOURCES (README; Cargo.toml).
- **PostgreSQL swap (INFERENCE, not design):** no abstraction point exists. `SqliteStorage`
  in `src/storage/sqlite.rs` is the only storage; the schema is SQLite DDL in
  `src/storage/schema.rs` (v19) with SQLite-specific dirty-tracking, WAL, lock and
  witness files, and docs call the engine family "SQLite + JSONL only" (Dolt backend
  explicitly out). A Postgres back-end would be a new port, not a config change —
  INFERENCE (from docs/ARCHITECTURE.md schema inventory, README Limitations).

## Evidence

### Q1 — Concurrency model (storage, guarantees, what breaks on 20 pods)

- FACT: storage is `SqliteStorage` over the fsqlite stack; README badges SQLite;
  `Cargo.toml` pins `fsqlite = "=0.4.10"` (plus 13 sibling fsqlite crates). README
  Safety Model: "The storage engine is FrankenSQLite (pure Rust, no C SQLite)."
  https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/README.md
  https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/Cargo.toml
- FACT: WAL mode and busy timeout: docs/ARCHITECTURE.md — "WAL Mode: Concurrent reads
  during writes"; "Busy Timeout: Normal CLI storage opening defaults to 30s; direct
  `SqliteStorage::open` uses `DEFAULT_BUSY_TIMEOUT_MS = 0`."
  https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/docs/ARCHITECTURE.md
- FACT: writers serialize on `.beads/.write.lock`; contended writers register in
  `.beads/.write-waiters.lock/`, "the earliest live registration retries the authority
  lock"; default 30 s timeout shared by registration and polling.
  https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/docs/SYNC_SAFETY.md (Workspace write admission)
- FACT: mutations run through `SqliteStorage::mutate` with "a transaction retry loop" —
  "The callback can be retried on transient database contention." docs/ARCHITECTURE.md
  Transaction Protocol (URL above).
- FACT (history, what breaks under multi-process): #242 "Recurring SQLite corruption /
  DB-vs-JSONL drift under concurrent multi-agent br writes" (0.1.38); quote: "the SQLite
  DB repeatedly drifted into a partially corrupted state that required `br doctor
  --repair`". Fixed by engine fix: #457 (fsqlite 0.3.11 page-aliasing corruption, closed)
  — author quote: "The **root-cause engine fix** shipped in FrankenSQLite **0.3.12**
  (cross-process WAL reader registration + reset-gate on the peer-reader horizon)".
  https://github.com/Dicklesworthstone/beads_rust/issues/242
  https://github.com/Dicklesworthstone/beads_rust/issues/457
- FACT: all locking is FILE-based; nothing spans machines. README Limitations:
  "Background daemon — no processes to manage", "Real-time collaboration — Git-based
  async collaboration". #182 quote: "br's single-writer SQLite architecture is a
  blocking limitation … The only sync mechanism is JSONL-over-git."
  https://github.com/Dicklesworthstone/beads_rust/issues/182
- INFERENCE: with 20 pods on 20 machines there is no shared FS, so the WAL/lock design
  is simply bypassed — each pod owns a replica; coordination reduces to git-merging
  `.beads/issues.jsonl` and importing. (Follows from the above; stated as inference.)

### Q2 — server/daemon/sync mode; flags; tombstones

- FACT: no server/daemon. README: "`br serve` … uses MCP over stdio. It is launched by
  an MCP client, does not listen on a network port"; `--no-daemon` is accepted only for
  classic-bd compatibility: "br never runs a daemon"; Limitations table: no background
  daemon, no Dolt backend, no Linear/Jira sync, no web UI, no real-time collaboration.
  https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/README.md
- FACT: bare `br sync` is refused; one of `--flush-only/--import-only/--merge/
  --reconcile/--reconcile-additive/--status/--witness` required. README Architecture:
  "Bare `br sync` is intentionally refused". Data flow: `--flush-only` = "Write JSONL +
  clear dirty flags"; `--import-only` = "Merge to SQLite".
  https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/docs/ARCHITECTURE.md
- FACT: `--merge` = three-way merge against `.beads/beads.base.jsonl` (the last local
  export); conflict resolution flags `--force` (newer timestamp), `--force-db`,
  `--force-jsonl`; `AmbiguousBase` guard refuses merge when an external row does not
  advance beyond anchor+local timestamps. .beads/SYNC_CLI_FLAG_SEMANTICS.md §2/§3.3.
  https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/.beads/SYNC_CLI_FLAG_SEMANTICS.md
- FACT (tombstones): "An explicit external tombstone remains a deletion, and local
  tombstones retain their protection against resurrection"; `deletions_retention_days`
  in `.beads/metadata.json` omits a tombstone from export after retention elapses;
  "An absent or zero setting keeps tombstones indefinitely."
  https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/docs/SYNC_SAFETY.md (Tombstone retention; Merge Guards)
- FACT (the danger we hit): open issue #541 — "`br sync --merge` reverts and deletes
  this workspace's exported edits when the JSONL predates `beads.base.jsonl` (reports
  `conflicts: 0`)"; quote: "an issue created and exported on a feature branch is
  **tombstoned**; the merge reports `"status":"success","conflicts":0`". Root cause
  quoted in the issue: "Case 4 (`(Some(b), Some(l), None)`): the issue is missing from
  main's JSONL and `l == b`, so it is deleted." State: OPEN, 0 comments (2026-10-13).
  https://github.com/Dicklesworthstone/beads_rust/issues/541
- CONTEXT (docs vs bug): docs/SYNC_SAFETY.md + invariant DL-6 promise the OPPOSITE
  default ("With a local-export merge anchor, absence from incoming JSONL never deletes
  a local record without `--force-jsonl`; tombstone retention alone is not deletion
  evidence" — .beads/SYNC_SAFETY_INVARIANTS.md). So #541 documents a documented-guarantee
  violation in the merge path. https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/.beads/SYNC_SAFETY_INVARIANTS.md
- RELATED: #268 (closed, fixed pre-report) — `--import-only --force/--rebuild` formerly
  dropped tombstone labels/deps/comments and orphan cleanup deleted preserved
  tombstones. https://github.com/Dicklesworthstone/beads_rust/issues/268 — and #548
  (closed) about an omitted-local-issue `needs_flush` flag letting the next auto-flush
  overwrite pulled edits. https://github.com/Dicklesworthstone/beads_rust/issues/548
- INFERENCE for our usage: staying with `--flush-only` + `--import-only` only (as we do)
  avoids the #541 path unless `--import-only --force` is used on a stale JSONL; the
  lossless repair path is `br sync --reconcile` / `--reconcile-additive` (plan/apply,
  sha-bound). Stated as inference from these files.

### Q3 — Compatibility with upstream beads

- FACT: README "Why This Project Exists": a port "frozen at the 'classic' SQLite +
  JSONL architecture" because upstream moved "toward GasTown and beyond"; "Rather than
  ask Steve to maintain a legacy mode … I created this Rust port"; "Steve has given his
  full endorsement of this project." No statement of tracking upstream; divergence is
  the point. https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/README.md
- FACT: JSONL compat: FAQ — "br imports classic beads JSONL. Conformance is checked
  against bd v0.46.0; br has additional fields, workflow tables, its own plain-text
  output, and paginated JSON query results. Its length-prefixed content hashes
  deliberately differ from classic bd hashes. Use JSONL interchange rather than assuming
  the two tools can share an identical live database schema."
  (same README URL) + https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/docs/TEST_HARNESS.md
- FACT: concrete divergences (docs/TEST_HARNESS.md, pinned bd v0.46.0, run 2026-09-03):
  br-only tables (`capacity_*`, `close_metadata`, `gate_results`, `gate_result_history`),
  br-only columns (`issues.owner`, `issues.agent_context`, `issues.source_system`,
  `issues.prerequisites`, `events.harness`, `events.model`), br-only JSONL dependency
  fields `thread_id` and `metadata`, paginated JSON, schema v19 dependency PK.
- FACT: migration path bd→br exists as a shipped skill: copy issues.jsonl, `br sync
  --import-only` (README FAQ) or the `bd-to-br-migration` skill ("br imports bd JSONL;
  `bd sync` → `br sync --flush-only`").
  https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/skills/bd-to-br-migration/SKILL.md
- INFERENCES: (a) interop = one-way-ish JSONL import of bd exports; live DB sharing is
  out by design. (b) ID prefixes: any prefix accepted ("`br` accepts any prefix
  (cross-tool tolerance)" per docs/audit_bd_to_br_2026_05_09.md on CLI_REFERENCE
  examples; default br- settable via `issue_prefix`). Not verified against current bd.

### Q4 — Multi-machine story

- FACT: collaboration is git-committed `.beads/issues.jsonl` (README: "Collaboration:
  JSONL merges cleanly in git", "Git operations are YOUR responsibility"); `br sync
  --import-only` after `git pull`. (README Design Philosophy §2/§3.)
- FACT: nothing remote: README env table keeps `BEADS_*` classic-bd keys only "read for
  compatibility"; sync docs: "Local-only by default. Sync makes no network or Git calls"
  (.beads/SYNC_CLI_FLAG_SEMANTICS.md §1.1).
- FACT: #182 (closed, roadmap) top P0: "Remote sync backend (`--remote <url>`) … This
  would allow centralized sync without requiring Dolt"; author: "Remote sync is the
  biggest gap … I'm tracking this internally"; priority "Stabilize FrankenSQLite →
  Remote sync → Auto-sync → Atomic claim", "not putting a timeline on this."
  https://github.com/Dicklesworthstone/beads_rust/issues/182
- FACT: #543 (open): sync tools for "multiple machines or clones (developers plus cloud
  agent sessions) that keep the tracker on a separate branch" need `--base <PATH>`.
  https://github.com/Dicklesworthstone/beads_rust/issues/543
- FACT: cross-workspace routing (`.beads/routes.jsonl`, prefix→path) is a "local
  dispatch table", explicitly "not automatic multi-repo synchronization" (README FAQ
  "Can one workspace refer to issues in another workspace?"). Requires same machine
  (a filesystem path). INFERENCE: not an answer for pods on different machines.
- INFERENCE: for a fleet on many machines the supported topology is per-machine clones
  exchanging `.beads/issues.jsonl` via git, with merge/import/reconcile discipline; a
  shared PostgreSQL deployment has no supported path today.

### Q5 — Version history, license, surfaces, dependencies/ready

- FACT: project inception 2026-01-15; v0.1.0 released 2026-01-18; latest release v0.7.4
  2026-10-01. Release tags read: 0.1.28-era → 0.2.x (stabilization) → 0.3 (2026-08-14) →
  0.4 (2026-08-23/24) → 0.5.x (2026-08-25…09-09) → 0.6.0 (2026-09-12) → 0.7.x
  (2026-09-24…10-01). https://github.com/Dicklesworthstone/beads_rust/releases
  https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/CHANGELOG.md
- FACT: recent 0.7 line is recovery/robustness-focused (CHANGELOG headlines: v0.7.4
  "FrankenSQLite 0.4.7, so reads after a SQLite reader such as bv no longer copy the
  database"; v0.7.2 "WAL-index recovery no longer locked out … warns when rows may be
  lost (#523)"). Repo actively developed: HEAD commit 8f26d4211e7a pushed 2026-10-12.
- FACT: license "MIT License (with OpenAI/Anthropic Rider)" — MIT text plus a rider
  revoking all rights from OpenAI, Anthropic, and anyone acting on their behalf,
  including employees/contractors. GitHub license API: `spdx_id: NOASSERTION`. Quote:
  "'Restricted Parties' means OpenAI, L.L.C.; Anthropic, P.B.C.; any of their respective
  Affiliates; and any person or entity acting … for the benefit of … any of the
  foregoing". https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/LICENSE
- FACT: CLI surface: `br create/list/show/update/close/reopen/defer/dep add|remove/
  graph/ready/blocked/search/label/comments/stats/coordination/doctor/schema/config/
  init/vcs-status/sync/scheduler` (README Commands; docs/CLI_REFERENCE.md,
  https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/docs/CLI_REFERENCE.md).
  Ready queue: "`br ready` — Shows issues that are open, not blocked, not deferred";
  deps: "`br dep add br-A br-B` … Now br-A won't appear in `br ready` until br-B is
  closed". `--robot` exists on many commands; `br capabilities --format json`.
- FACT: MCP surface (behind `mcp` cargo feature, off by default): `br serve` stdio;
  tools `list_issues, show_issue, create_issue, update_issue, close_issue,
  manage_dependencies, project_overview`; resources `beads://project/info`,
  `beads://issue/{id}`, `beads://schema`, `beads://issues/ready`, `beads://coordination/status`, etc.
  Same locks/safety model as CLI. (README "Enable MCP Server Support".)
- INFERENCE on "0.x": every release is 0.x, minor lines get their own stabilization
  cuts, and the 0.5→0.7 period saw data-correlation-class engine bugs (#457, #522, #523)
  — treat each minor bump as a migration, not a patch. INFERENCE.

### Q6 — Running many writers on PostgreSQL (marked INFERENCE)

- INFERENCE: no SQL-abstraction layer. Only storage is `SqliteStorage`
  (`src/storage/sqlite.rs`, "owns a `Connection`, database-family write authority …,
  an opener lease, and mutation, policy and temporary-storage state");
  authoritative DDL is `CREATE TABLE IF NOT EXISTS` statements in
  `src/storage/schema.rs` with `CURRENT_SCHEMA_VERSION` (schema 19 today); docs:
  README Limitations "Dolt backend — SQLite + JSONL only". A Postgres port would need
  a new storage implementation, reimplementation of the dirty-tracking/export-hash/
  blocked-cache bookkeeping, and a replacement for file-lock write admission.
- INFERENCE: the schema itself is simple and portable (~15 tables: issues,
  dependencies, labels, comments, events, dirty_issues, blocked_issues_cache,
  export_hashes, child_counters, config, metadata, gate_results,
  gate_result_history, close_metadata, capacity_*), documented in
  docs/ARCHITECTURE.md "Database Schema" — the SQL is unlikely to be the hard part;
  the sync/JSONL machinery and the `.beads/`-filesystem witness/lock model are.
- NOT verified: whether any code accepts another engine behind the `SqliteStorage`
  name (source not read line-by-line); no `rusqlite`/`postgres` feature in Cargo.toml
  features list (only `default = ["self_update"]`, `mcp`).

## Issues read

- #242 — "Recurring SQLite corruption / DB-vs-JSONL drift under concurrent multi-agent br writes on v0.1.38" (closed): repeated `beads.db` corruption under multi-agent concurrent writes; JSONL stayed intact. https://github.com/Dicklesworthstone/beads_rust/issues/242
- #457 — "v0.5.3 (fsqlite 0.3.11) malforms migrated databases under concurrent multi-process writes — reproducible in 60s … v0.2.22 clean" (closed): fixed by FrankenSQLite 0.3.12 (cross-process WAL reader registration). https://github.com/Dicklesworthstone/beads_rust/issues/457
- #182 — "Roadmap for multi-user/multi-agent feature parity with bd (Go beads)?" (closed, author: tracked internally): remote-sync backend is the top P0 gap; no timeline. https://github.com/Dicklesworthstone/beads_rust/issues/182
- #541 — "`br sync --merge` reverts and deletes this workspace's exported edits when the JSONL predates `beads.base.jsonl` (reports `conflicts: 0`)" (OPEN, 0 comments): reproduces the tombstoning we observed, br 0.7.4. https://github.com/Dicklesworthstone/beads_rust/issues/541
- #543 — "Feature: `br sync --merge --base <PATH>` so callers can supply the merge ancestor" (OPEN): use case "sync tools for multiple machines". https://github.com/Dicklesworthstone/beads_rust/issues/543
- #268 — "`br sync` tombstone preservation: drops labels/deps/comments; cleanup deletes preserved tombstones" (CLOSED — fixed on main before filing, commits 97a085ce et al.). https://github.com/Dicklesworthstone/beads_rust/issues/268
- #548 — "Import: omitted local issue sets needs_flush; next auto-flush can overwrite pulled edits" (closed): import/flush race that can clobber peer edits. https://github.com/Dicklesworthstone/beads_rust/issues/548
- #182-related surface, not re-read: #503/#522/#523 referenced from CHANGELOG headlines only (not opened).

## Not verified

- We did not BUILD or run br here; all findings are from repo text, issue text and the
  GitHub API at the refs named above. #541's repro was verified by its author on
  0.7.4/main@a0b9c85, not by us.
- Current bd (Go beads) status/format today — we read only br's bd-v0.46.0 conformance
  claims; whether bd's newer (Dolt-era) format still round-trips into br is unverified.
- Whether any `--remote`/network sync has shipped since — no evidence found in README,
  CHANGELOG or issues we opened; the Limitations table still excludes it.
- Exact CLI help text for 0.7.4 subcommands (we read docs/CLI_REFERENCE.md's existence
  and README tables, not the full reference; command inventory may drift).
- Whether #541's proposed case-4/case-6 fix has been merged after reading — issue was
  open with no comments at read time; check before relying on default `--merge` safety.
