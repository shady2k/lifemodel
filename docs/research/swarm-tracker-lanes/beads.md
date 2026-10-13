# beads ("bd") — primary-source research lane

Read 2026-10-13. Repo: `github.com/gastownhall/beads` (moved from `steveyegge/beads`), default branch `main`, MIT, Go.
Commit read: `85464f567aecc736059602dd0eab561bde7612b9` (committer date 2026-10-13T04:35:17Z). Latest release: v1.3.2-rc.2 (2026-10-10); latest stable v1.3.1 (2026-09-30).

## Summary

- **Storage today is Dolt only — not SQLite.** FACT (CHANGELOG/docs): SQLite was the sole backend until v0.47.2 when Dolt went "experimental" (`bd init --backend=dolt`, 2026-01-11); it became the default for new `bd init` in v0.50.0 (2026-02-14); SQLite was removed entirely in v0.51.0/v0.58.0. v1.0.0 (2026-04-02): "Embedded Dolt default on all platforms" — the Dolt engine is linked into the `bd` binary (in-process, data under `.beads/embeddeddolt/`); server mode (`.beads/dolt/`, `dolt sql-server`, multi-writer) remains opt-in. Sources: CHANGELOG.md, `docs/architecture/dolt.md`.
- **`.beads/issues.jsonl` is NOT the sync channel anymore.** FACT: the whole JSONL sync pipeline (`bd sync`, git-portable mode) was removed in v0.56.0 (2026-02-23); sync is native Dolt push/pull over git remotes — data lives under `refs/dolt/data` inside the same git remote. JSONL is now an optional export surface (auto-export became opt-in in v1.0.4/1.0.5): "an export for viewers, interchange... not the canonical cross-machine sync channel" (`docs/core-concepts/sync-concepts.md`). The task premise of "JSONL committed to git for sync" is outdated as of the read date.
- **Server mode exists in two senses** (FACT, with exact commands): (a) Dolt SQL-server mode (`bd init --server`, `bd dolt start/stop/status`, or auto-started; shared one-server-many-projects mode at `~/.beads/shared-server/`, port 3308; also `--proxied-server`); (b) `bd serve` — an HTTP API (shipped v1.2.1, 2026-08-11, "bd-serve v0"), loopback-only by default, bearer-token auth via `--auth-token-file`, refuses embedded-Dolt workspaces. "Is there a multi-instance story" — partially: concurrent `bd serve` instances are data-safe ("claims are arbitrated in the SQL server") but ephemeral-port serves give no mutual exclusion or discovery (engdocs/design/bd-serve-v0.md, engdocs/SERVE_RUNBOOK.md).
- **Merge problems now come FROM the Dolt model, and the project openly fights them** (FACT): recurring `metadata`-table merge conflicts (GH#2466), permanently un-mergeable schemas after two clones migrate in parallel — "their histories become permanently un-mergeable — Dolt refuses the merge outright" (CHANGELOG 1.1.0-rc.1; GH#4259), PK merge refusals and cross-clone delete-vs-insert FK errors, stale `is_blocked` after merges, server-mode reads serving days-stale data (GH#4746). "Because Dolt has no row locking and merges concurrent commits cell-by-cell" is the project's own words (CHANGELOG 1.2.1): it added a shared `row_lock` cell + serialization retry to force conflicts that cell-merge would swallow.
- **"Claim" is atomic on paper, and the CAS landings tracked but did not yet close real races.** FACT: `bd update <id> --claim` / `bd ready --claim` are documented atomic; load-tested reports show double-claims (GH#3575, GH#4657 — "not a hard CAS under true sub-second concurrency"; GH#5998, both open at read time). Fixes shipped in 1.2.x: `--if-revision` CAS (closed #7243), claim verify-by-reread, `row_lock` cell — but `bd ready --claim` non-transactional remained open (GH#5998), and #6903 (no generation guard) open.
- **Concurrency primitives**: derived IDs/leases schema v54 in 1.2.1 (TTL 5m, `bd heartbeat`, `bd reclaim` — leases per-replica, never replicate); merge slots (`bd merge-slot acquire/release`) to serialize conflict-prone work; HTTP claim returns typed 409 `already_claimed` carrying the holder. SQLite-era WAL/busy_timeout/daemon serialization is gone with SQLite.
- **Ready queue/interface**: `bd ready` (blocker-aware, `--claim`), dependency graph (`bd dep`, typed edges), MCP wrapper is a separate Python package `beads-mcp` that shells the CLI (the project recommends CLI+hooks over MCP: "uses ~1-2k tokens vs 10-50k"), and `bd serve` HTTP v0. Self-hosting: one Go binary (embedded Dolt linked in; non-CGO builds fall back to server-backed); optional standalone `dolt` CLI pinned to 2.2.0 for server mode. Licence MIT (GitHub API `spdx_id: MIT`).
- **Vendor claim to weigh** (AUTHOR CLAIM): "cell-level merge... most concurrent changes resolve automatically" (FAQ) — true for different cells, but the incident list above is the cost of the same model when both ends touch the same cell/metadata/schema.

## Evidence

### Q1 — Storage backends and the 0.x timeline

FACT — dated CHANGELOG milestones (all URLs: https://github.com/gastownhall/beads/blob/main/CHANGELOG.md at the read commit):

- v0.9.8 (2025-10-16): `bd daemon` (auto export/import JSONL) and `bd sync` (git commit/pull/push JSONL, "Automatic merge conflict resolution with collision remapping").
- v0.47.2 (2026-01-14): "Dolt backend (experimental)" — `bd init --backend=dolt`.
- v0.49.1 (2026-01-25): "Dolt backend now fully supported... Dolt is not enabled by default"; server mode for "multiple processes to share a Dolt database".
- v0.50.0 (2026-02-14): "Dolt is now the default backend for new `bd init`" — existing SQLite projects unaffected.
- v0.51.0 (2026-02-16): "Phase 6: Remove SQLite backend entirely"; "`bd sync` is now a no-op".
- v0.53.0 (2026-02-18): "Dolt-in-Git sync — native Dolt push/pull via git remotes replaces the entire JSONL sync pipeline"; `bd dolt start`/`stop` (#1813).
- v0.56.0 (2026-02-23): "the entire JSONL-based sync system ... has been removed"; embedded driver removed — "beads now requires a running Dolt SQL server" (reversed at 0.63.3/1.0.0).
- v0.58.0 (2026-03-05): "the SQLite storage layer and all migration infrastructure have been removed. Dolt is the only backend."
- v0.60.0 (2026-03-12): "Shared Dolt server mode — multi-repo and multi-agent setups can share a single Dolt server instance" (GH#2416).
- v0.63.3 (2026-03-30) + v1.0.0 (2026-04-02, PR #2842/#2971): "Embedded Dolt default on all platforms"; per 1.3.0 "nocgo builds, which are always server-backed".
- v1.2.1 (2026-08-11): `bd serve` v0 HTTP surface, `bd sync` as "one verb for the federation loop", lock-free-claim work (below).

FACT — what a "Dolt backend" is: a MySQL-wire-versioned database with version control; `bd` writes SQL, wraps write groups in transactions ending in `CALL DOLT_COMMIT('-Am', ...)`; cross-machine sync = Dolt remotes (`bd dolt remote add origin git+ssh://git@github.com/org/repo.git`), data under `refs/dolt/data` in the same git remote, first `bd dolt pull`/`push` merges cell-level. Sources: `docs/architecture/dolt.md`, `docs/getting-started/sync-setup.md`, `engdocs/design/dolt-concurrency.md`.
FACT — extension seam exists but OSS ships none: "OSS Beads registers no alternate backend... The Dolt family remains hand-wired" (`internal/storage/backends/backends.go@main`). No MySQL/Dolt-as-upstream-DB backend; "Dolt backend" = Dolt (DoltHub-authored store), not "MySQL backend".
INFERENCE — the task's expected "SQLite->SQLite+dolt" split matches: SQLite (≤0.50, CLI-embedded wire) → Dolt (now; embedded engine default or SQL-server process).

### Q2 — Server mode ("bd serve" and the Dolt server)

FACT — exact commands:
- `bd serve` (HTTP): "Serve the beads HTTP API over loopback" — flags `--addr` (default `127.0.0.1:0`), `--auth-token-file` (required with `--allow-non-loopback`), `--allowed-host`, `--insecure-no-auth`. Shipped in v1.2.1 (CHANGELOG: "`bd serve` — the beads work surface over HTTP (bd-serve v0)"). Sources: `cmd/bd/serve.go@main`, `engdocs/design/bd-serve-v0.md`, `engdocs/SERVE_RUNBOOK.md`.
- Dolt server mode: `bd init --server`, `bd dolt start|stop|status|show`, `dolt sql-server --port 3307`, env `BEADS_DOLT_SERVER_MODE=1`, config `dolt: {mode: server, host, port, user}`; shared mode `bd init --shared-server`, port 3308. Sources: `docs/architecture/dolt.md`, `docs/cli-reference/dolt.md`.
- Who talks to it: CLI `bd` subprocesses connect over MySQL wire protocol (a running `bd serve` is a client, not the store); HTTP clients hit `bd serve`'s `/v0/beads/...` (OpenAPI `internal/httpapi/spec/openapi.v0.yaml`); capabilities probed via `GET /v0/beads/context`
- Production posture — AUTHOR CLAIM/FACT mix: the design doc says v0 "exists because the subprocess-per-call shape has two costs"; bearer auth optional, **no TLS ever** ("There is still no TLS" — RUNBOOK); `bd --readonly serve` refused (1.3.0); embedded-Dolt workspaces "refused permanently" for serve. Multi-instance: `bd serve` "carries no mutual exclusion" on ephemeral ports; fixed port = TCP bind is the singleton; no lock/pid/discovery file.
- Related incidents (open): #7295 serve 503s permanently after ~40s idle (proxied mode); #6747 serve leaves db-proxy-child running; #7122 other projects' `bd serve` holds shared-root gate and blocks `bd init`; closed #6737 (stale pooled connections > wait_timeout → 503). #7287 (server memory unbounded with many databases; workaround GOMEMLIMIT).
- Multi-agent story per docs: coordinator assigns, agents self-claim (`bd ready --claim`), merge slots for serialization, federation for peer towns (`bd federation add-peer/sync`).

### Q3 — Sync mechanics and merge pain

FACT — mechanism (no Dolt server involvement): each clone has its own local Dolt DB (embedded or its own server); `bd dolt push`/`pull` move Dolt commits through a remote that can be the same git origin, under `refs/dolt/data`; pull does a cell-level three-way merge; `bd sync` = one verb: "pull, check for merge conflicts POSITIVELY... recompute the denormalized is_blocked flag... push, retrying a bounded number of times when another replica wins the push race", exit codes 0/1/2(conflict)/3(retries)/4(stuck dirty working set) (`cmd/bd/sync.go@main` Long).

Problems the Dolt model CAUSES (each FACT with issue/URL):
- Recurring metadata-table merge conflicts in two-machine push/pull loops — root cause: machine-local rows (`dolt_auto_push_commit`) versioned in Dolt commits (#2466, closed by auto-resolve in v0.60.0).
- Schema migration skew: two clones upgrading independently apply the same migration with different content → "permanently un-mergeable — Dolt refuses the merge (`cannot merge because table dependencies has different primary keys`)" (CHANGELOG 1.1.0-rc.1; #4259 closed with designated-migrator gate, `BD_ALLOW_REMOTE_MIGRATE=1`, per-migration SHA-256 content hash; 1.3.0: shared servers never auto-migrate).
- Cross-clone delete vs child-row-insert merges fail FK outright ("bd dolt pull failed outright with a foreign-key constraint violation") — fixed by explicit cascade-repair (CHANGELOG 1.1.0-rc.1).
- No row locking: "Because Dolt has no row locking and merges concurrent commits cell-by-cell" — a heartbeat vs reclaim would cell-merge into a zombie claim; mitigated by a shared `row_lock` cell + retry (CHANGELOG 1.2.1).
- `dolt_ignore`d table tracked on remote deadlocks `bd sync` (#6368, open); one transport timeout aborts push/pull with possible partial write and no retry (#6034, open); federation sync uses bare `CALL DOLT_MERGE` so strategy resolution can hard-fail (#5564, open).
- Server-mode staleness/consistency: reads up to days stale across concurrent sessions against embedded store (#4746, open); commit-time merge reverts concurrent writers' committed writes (CHANGELOG 1.3.0 fix).
- Operational hazards: raw `dolt` CLI while server runs → "journal corruption" warning (sync-setup); Dolt 2.3.x breaks `DOLT_RESET('--hard')` (pinned to 2.2.0, `docs/architecture/dolt.md`).

Problems it CLAIMS TO HAVE SOLVED:
- JSONL line-level merge conflicts, divergence/id churn and multi-writer JSONL conflicts of the SQLite+JSONL era (#158, #95, #1103 are era-contemporary reports); "Cell-level merge: concurrent changes merge automatically at the field level" (FAQ). Dolt's delete-tracking replaces JSONL's "upsert-only, cannot reconcile deletes" (#sync-concepts).

### Q4 — Concurrency on the local store

FACT — embedded mode: single process opens the in-process engine; v1.0.0 added a process-lifetime flock after GH#2571 panic, then v1.0.4 removed it ("the embedded Dolt engine handles its own concurrency internally") — concurrent `bd` processes on embedded mode race at the engine level (see staleness #4746). Server mode handles multi-writer via SQL transactions; every write group is `BEGIN ... CALL DOLT_COMMIT() ... ` inside one SQL tx (dolt-concurrency.md, implemented 2026-02-24; branch-per-worker `BD_BRANCH` retired).
FACT — claim CAS history: `--if-revision` CAS across five verbs (CHANGELOG 1.2.1, "ExpectedVersion"), guarded delete single-winner fixed (#7243 closed) but `bd ready --claim` double-award stayed open as of read (#5998: "'bd ready --claim' is not transactional: two concurrent invocations both receive the same bead", open 2026-08-24, triaged p2; production workaround = UUIDv7 comment arbitration). #6903 (open): CAS guards check identity/status only, no generation guard — a refreshed-but-same-holder claim gets stripped by a stale reaper.
FACT — two agents claiming same issue: sequential case → loser gets "issue already claimed by <assignee>" exit 1; sub-second race → historically both succeeded (issues above). HTTP claim: typed 409 `already_claimed` with `assignee` member (bd-serve-v0.md). Claim leases: TTL 5m, `bd heartbeat`, `bd reclaim` reverts expired (schema v54, CHANGELOG 1.2.1). Merge slots: `bd merge-slot acquire/release` (docs/cli-reference/merge-slot.md).

### Q5 — Ready queue, interfaces, footprint, licence

FACT — `bd ready`: "Show ready work (open issues with no active blockers)" — blocker-aware `GetReadyWork`, sort policies priority/hybrid/oldest, `--claim`, `--mol`/`--gated` for molecules; `bd dep add`, `bd blocked`, hierarchical IDs (`epic.1.1`). Sources: README "Essential Commands", docs/cli-reference/ready.md, docs/cli-reference/index.md (108 top-level commands).
FACT — interfaces: CLI (primary, recommended by project for agents), MCP via separate PyPI `beads-mcp` wrapper ("integrations/beads-mcp/README.md": "the CLI + hooks approach is recommended... It uses ~1-2k tokens vs 10-50k for MCP schemas"), HTTP `bd serve` v0 under `/v0` (OpenAPI: `internal/httpapi/spec/openapi.v0.yaml`), and in-memory Go library (`beads.OpenBestAvailable`, breaking change in 1.0.4).
FACT — footprint: linkable Go module (`github.com/steveyegge/beads/backend` package exported in 1.3.0); binary embeds the Dolt engine (0.56.0 CHANGELOG: "Binary size drops from 168MB to ~41MB" after first embedded removal; current embedded re-links engine — precise current size not verified); standalone `dolt` CLI only needed for server mode (pinned 2.2.0).
FACT — licence MIT: GitHub repo API `license.spdx_id = "MIT"`.

### Q6 — Verdict-relevant project quotes

- "`bd ready --claim` is not transactional: two concurrent invocations both receive the same bead" — issue #5998 (the project's own tracker, still open).
- "Because Dolt has no row locking and merges concurrent commits cell-by-cell, every status/ownership/lease-mutating path also rewrites a shared `row_lock` cell" — CHANGELOG v1.2.1.
- "Do not use JSONL as sync — `.beads/issues.jsonl` is an export for viewers and interchange. It is not the source of truth, not a full database backup, and cannot safely reconcile deletes or pruning." — docs/getting-started/sync-setup.md.
- "Cross-machine sync uses Dolt remotes... For normal git-hosted projects, the Dolt remote can be the same origin URL used for source code... Dolt stores issue history under refs/dolt/data" — docs/core-concepts/sync-concepts.md.
- "Can multiple agents work on the same repo? Yes — that's what beads was designed for." — docs/reference/faq.md.
- "Switch to server mode when you need: Multiple agents writing simultaneously... Federation with remote peers." — docs/architecture/dolt.md.
- "`bd serve` binds loopback and answers six... [operations]" — later grew to a v0 surface incl. writes, claim, reclaim; "Embedded-Dolt workspaces are refused permanently".

## Issues read (number — title — one line — URL)

- #95 [closed] auto-resolving merge conflicts — community merge tool for conflicted `issues.jsonl` (SQLite era). https://github.com/gastownhall/beads/issues/95
- #158 [closed] Beads approach to merge conflicts? + RFC for markdown backend — "I get in a LOT of trouble with sync issues, concurrency, and corruption of the json store" (SQLite+JSONL era). https://github.com/gastownhall/beads/issues/158
- #1103 [closed] bd sync --merge fails with sync-branch + skip-worktree/daemon write conflict — git merge refutes a "clean" `git status` on `.beads/issues.jsonl`. https://github.com/gastownhall/beads/issues/1103
- #2466 [closed] recurring merge conflicts on `metadata` table in multi-machine setups — machine-local auto-push rows versioned in Dolt causes per-pull conflicts. https://github.com/gastownhall/beads/issues/2466
- #3760 [open] Proposal: bd serve daemon to amortize dolt connection setup — the managed Dolt server "pegs at 400-550% CPU" at idle in a 4-agent town. https://github.com/gastownhall/beads/issues/3760
- #4259 [closed] pull unmergeable after multi-machine upgrade — "migration 0043 forks the dependencies primary key"; permanent divergence. https://github.com/gastownhall/beads/issues/4259
- #4746 [open] bd read path serves stale data across concurrent sessions/agents — "possible long-lived dolt sql-server snapshot/transaction issue", days-stale reads. https://github.com/gastownhall/beads/issues/4746
- #5564 [open] federation sync uses the bare CALL DOLT_MERGE path — conflict-strategy resolution can hard-fail (1105). https://github.com/gastownhall/beads/issues/5564
- #6034 [open] Dolt sync aborts on a single transport timeout — no retry, partial write possible; "the code lands and the database does not". https://github.com/gastownhall/beads/issues/6034
- #6368 [open] bd sync deadlocks when a dolt_ignore'd table is tracked on the remote — clean working set yet "local changes would be stomped by merge: events". https://github.com/gastownhall/beads/issues/6368
- #6611 [open] --claim idempotency across actors — pool-alias claims refused with "already assigned to X". https://github.com/gastownhall/beads/issues/6611
- #6737 [closed] bd serve returns 503 after idle SQL connections exceed Dolt wait_timeout — stale pooled connections. https://github.com/gastownhall/beads/issues/6737
- #6903 [open] claim CAS has no generation guard — stale reaper strips a live, refreshed claim. https://github.com/gastownhall/beads/issues/6903
- #7122 [open] bd init blocked indefinitely by other projects' bd serve holding the shared-root gate. https://github.com/gastownhall/beads/issues/7122
- #7243 [closed] guarded delete (--if-revision) has no single winner under concurrency — every same-token racer exited 0; fixed. https://github.com/gastownhall/beads/issues/7243
- #7287 [open] dolt sql-server memory grows without bound with many databases — live heap flat; freed-heap retention; GOMEMLIMIT fix. https://github.com/gastownhall/beads/issues/7287
- #7295 [open] bd serve 503 db_unavailable permanently after ~40s without requests (proxied-server). https://github.com/gastownhall/beads/issues/7295
- #7385 [open] sync setup manual fallback uses server-only steps after embedded init — doc bugs current default mode. https://github.com/gastownhall/beads/issues/7385
- (Not read in full, cited from CHANGELOG): #1741, #1813, #1940, #2353, #2377, #2416, #2446, #2571, #2672, #2842, #2971, #3140, #3724, #4043, #4356, #4657, #5998, #6672, #6674 — see CHANGELOG.md.

(Numbers #3575, #4657, #4992, #5119 read via search snippets/bodies as cited above.)

## Not verified

- Current installer/binary size and startup latency for embedded mode on each OS (CHANGELOG numbers are from Feb 2026 releases).
- Whether Dolt version pin target "2.2.0" exactly matches the go.mod engine commit (doc says go.mod links "the commit tagged v2.2.0 upstream"; go.mod itself not fetched).
- Real-world throughput/latency of `bd serve` under many agents beyond what runbook constants imply (not measured; #7295/#6737/#7287 suggest operational fragility, not a benchmark).
- Whether #5998/#4657/#6903 were fixed after 1.3.1 (both still open at read; only release notes to 1.3.2-rc.2 checked superficially).
- Whether `bd swarm` federation to external coordinators works outside the orchestrator ecosystem (gc/gascity terms appear throughout; not tested).
- Windows support quality beyond the docs' claims (several open Windows issues, e.g. #7082, #6882).
