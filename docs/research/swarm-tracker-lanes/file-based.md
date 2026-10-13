# File-based agent trackers — primary-source lane (read 2026-10-13)

## Summary

- **Correction to the lane brief:** the "backlog.md" project is **MrLesk/Backlog.md** (author handle "MrLesk", MIT). `tobi/backlog.md` (Tobias Lütke's GitHub user) does **not exist** — the GitHub API returns 404 for `tobi/backlog.md`, `tobi/backlog-md` and `tobi/backlog`; no backlog.md repo appears in tobi's public repo list. Authorship "by tobi" is therefore **not verified / appears incorrect**.
- **Backlog.md** is markdown-native: one `.md` file per task (`backlog/tasks/<prefix>-<n> - Title.md`) with YAML frontmatter (id, status, assignee, labels, dependencies, priority) plus section blocks. No server, optional git, MIT. Single-machine concurrency got a real fix in 2026: per-task filesystem lock with fail-fast contention (**PR #860**, closing **#843**); a git-backed *distributed* claim system (custom refs + CAS via `--force-with-lease`) is still only a proposal (**Issue #937**, open).
- **Backlog.md does no `git push` at all** — its git layer only commits locally and `fetch --prune`s; sync across machines is whatever the user's own git push/pull does. Each task is one file, so git merges are low-conflict, but nothing makes cross-machine claims atomic.
- **Claude Task Master** stores everything in a single `tasks.json` (in `.taskmaster/tasks/`) plus generated per-task `.txt` views; rich dependencies and an `next`-task ready queue. Concurrency was "not documented" until recently — cross-process `proper-lockfile` locking + atomic rename + in-lock re-read landed in **PR #1566/#1569**; known races remain open (**#1637**). Multi-machine: **NOT DOCUMENTED**; the git-committed single-file model implies manual sync. Licence is **MIT + Commons Clause** (cannot sell or host it as a service).
- **Beads (gastownhall/beads, MIT)** is the strongest swarm fit of the three: it is purpose-built for AI-agent issue tracking with hash-based IDs, a dependency-aware ready queue (`bd ready`), and Dolt-backed cross-machine sync (`bd dolt push/pull` to a git remote, plus server and experimental HTTP modes). But its atomic-claim story is **documented-and-measured as broken under sub-second concurrency** (open issues #3575, #4657, #5998); a CAS PR (#4682) is open.
- For a **k3s pod swarm with no shared FS**, all three need a networked backend: Backlog.md leans on users' own git push/pull (no built-in push, no distributed claims yet), Task Master has none documented (a SQLite+JSONL backend PR is open), Beads has a designed one (Dolt remotes / SQL server / HTTP) but with race caveats.
- Interfaces: Backlog.md — CLI, MCP (`backlog mcp start`), local web UI, `--json` reads. Task Master — CLI (`task-master`), MCP server (`task-master-ai`, 36 tools), no HTTP API. Beads — CLI (`bd`) with JSON output; MCP ships in-tree (`integrations/beads-mcp`, PyPI/badge) and can also serve over HTTP (`bd serve`).

## Evidence

### a) Backlog.md — MrLesk/Backlog.md

Read at `main` HEAD (repo pushed 2026-10-12; the repo is actively developed). Latest release v1.53.0 (2026-09-24); npm package `backlog.md` latest = 1.53.0. 7,014 stars. MIT ([LICENSE](https://github.com/MrLesk/Backlog.md/blob/main/LICENSE)).

**What it is (FACT, README at main):** "Markdown‑native Task Manager & Kanban visualizer for any Git repository… turns any folder into a self‑contained project board powered by plain Markdown files and a zero‑config CLI." https://raw.githubusercontent.com/MrLesk/Backlog.md/main/README.md

**Data model (FACT, README + a real task file):**
- Directory layout: `backlog/tasks/`, `backlog/drafts/`, `backlog/archive/`, `backlog/completed/`, `backlog/milestones/`, `backlog/decisions/`, `backlog/docs/` (visible in the repo tree: https://github.com/MrLesk/Backlog.md/tree/main/backlog).
- One markdown file per task; filename carries a configurable prefix-ID + title (`back-414 - Add-basic-Web-UI-theme-customization.md`). YAML frontmatter holds `id, title, status, assignee, created_date, labels, dependencies, references, priority`, followed by marked sections (DESCRIPTION / AC:BEGIN / DOD:BEGIN). Source: the dogfooded task file https://raw.githubusercontent.com/MrLesk/Backlog.md/main/backlog/tasks/back-414%20-%20Add-basic-Web-UI-theme-customization.md
- Statuses are configured columns (default `[To Do, In Progress, Done]`), default assignee, `zeroPaddedIds`, `backlog_directory` configurable. Source: https://raw.githubusercontent.com/MrLesk/Backlog.md/main/ADVANCED-CONFIG.md
- Dependencies live in task frontmatter (list of IDs); board/status/milestone and "task detail showing what a task waits on and what waits on it" are first-class (README Features). No separate ready-queue query beyond status/dependency filtering via `task list --json` (AUTHOR CLAIM for the queue-less model; ready-queue behavior is my INFERENCE from CLI docs).

**Concurrency of many writers (FACT + evidence from issues):**
- Git layer does **no push**: `src/git/operations.ts` at main has `fetch` (--prune, network-error tolerant), commit, staging; there is no pull/push/rebase command. Sync is the user's own git workflow. https://raw.githubusercontent.com/MrLesk/Backlog.md/main/src/git/operations.ts
- Cross-branch task state is resolved by reading task directories across recent branches (`src/core/cross-branch-tasks.ts`, `checkActiveBranches`, `activeBranchDays`), i.e. it *reads* other agents' branches but does not merge them.
- Per-host locking: issue **#843** (closed) measured that concurrent `task edit` on the same task "lose one of the two writes… Both processes exit 0" (12/12 lost at simultaneous start; ~20–30 ms vulnerable window). https://github.com/MrLesk/Backlog.md/issues/843
- Fix (FACT, merged PR **#860**, closes #843): "The edit funnel now runs inside a filesystem-level task lock (proper-lockfile, `retries: 0`) with an in-lock re-read… On contention the second writer fails fast… CLI exits non-zero, the web server returns 409, MCP returns OPERATION_FAILED… Locks live under `backlog/.locks/` (per-checkout, so sibling worktrees never falsely contend); a crashed holder's stale lock auto-breaks after 10s." https://github.com/MrLesk/Backlog.md/pull/860 (earlier wait-and-re-read variant #852 was withdrawn: https://github.com/MrLesk/Backlog.md/pull/852)
- ID allocation at create/promote/demote is serialized with a library-backed lock (**PR #565**, closed). https://github.com/MrLesk/Backlog.md/pull/565 — still imperfect: issue **#997** (open): "task create assigns the next numeric id by scanning backlog/tasks/ and backlog/completed/, but not backlog/archive/tasks/" → archived IDs get reused. https://github.com/MrLesk/Backlog.md/issues/997
- Cross-machine claim race is **unsolved**: issue **#937** (open) proposes "Git-backed atomic task coordination" — per-task custom refs, CAS via `--force-with-lease`, `task claim/renew/release` — and states the status quo plainly: "Fetch-before-edit cannot close this distributed race." https://github.com/MrLesk/Backlog.md/issues/937

**k3s pod swarm with no shared FS (my INFERENCE):** workable only if every pod runs the same repo with its own checkout and does its own git push/pull (each task = one file keeps conflict rate low; locks are per-checkout and provide zero distributed protection). Two agents on different machines can still both claim the same task (#937). No locking server, no HTTP API.

**Interfaces (FACT, README):** CLI (`backlog task …`, `board`, `browser` web UI on 127.0.0.1:6420, `search`), versioned JSON reads (`--json`, `--watch`), MCP server (`backlog mcp start`, auto-configures Claude Code/Codex/Gemini/Kiro/Cursor; `backlog://workflow/*` resources), agent-instruction file mode. Self-hosting footprint: single Node/Bun/brew binary, no server, no LLM dependency, git optional (`--no-git`).

### b) Claude Task Master — eyaltoledano/claude-task-master

Read at `main` HEAD (repo pushed 2026-04-28); package.json and npm `task-master-ai` latest both = **0.43.1** (last release 2026-03-31). 28,213 stars.

**What it is (FACT, README at main):** "A task management system for AI-driven development… designed to work seamlessly with any AI chat / Cursor." Tasks are generated from a PRD by LLM calls (requires at least one provider API key). https://raw.githubusercontent.com/eyaltoledano/claude-task-master/main/README.md

**Storage (FACT, repo tree + docs/task-structure.md):** single JSON database `.taskmaster/tasks/tasks.json` (1.5 MB in this repo's own usage) with tasks/subtasks/dependencies per "tag" (workstreams), plus generated human-readable task files `task_NNN_*.txt`. Task fields: `id, title, description, status (pending/in-progress/done/deferred), dependencies[], priority, details, testStrategy, subtasks[]`. https://raw.githubusercontent.com/eyaltoledano/claude-task-master/main/docs/task-structure.md and https://github.com/eyaltoledano/claude-task-master/tree/main/.taskmaster/tasks

**Deps/ready queue:** `dependencies` array per task; `task-master next` "Identifies tasks that are pending/in-progress and have all dependencies satisfied" — i.e. a built-in ready queue (FACT, docs/task-structure.md).

**Concurrency:** (was) NOT DOCUMENTED in the README at main — the story is in recent PRs/issues:
- PR **#1566** (merged, closed): "Addresses a race condition where multiple Claude Code windows (separate processes) accessing Task Master simultaneously could corrupt the JSON file or cause saved work to be lost" — adds `withFileLock` via `proper-lockfile`, temp+rename atomic writes, re-read inside lock. https://github.com/eyaltoledano/claude-task-master/pull/1566
- Issue **#1568** (closed, pattern adopted by PR #1569): "Several methods in file-storage.ts use a read-modify-write pattern that can still result in lost updates… re-reads the file inside the lock." https://github.com/eyaltoledano/claude-task-master/issues/1568
- Still open: **#1637** "bug: MCP server stale in-memory tag state causes cross-tag data corruption" ("the server reads parent task metadata from in-memory state rather than from the specified tag parameter") and **#1585** legacy concurrency cleanup; PR **#1420** (open) "resolve tag system corruption in concurrent operations". https://github.com/eyaltoledano/claude-task-master/issues/1637
- No atomic *claim* primitive at all (closest is `set_task_status` / `next` guidance) — my INFERENCE from tool list: no claim/lease tool exists in the 36-tool set.

**Multi-machine:** NOT DOCUMENTED. Storage is one file in the repo (so it travels via ordinary git like code), but the docs I read (README, docs/) describe single-project single-machine use; "Team Collaboration" lives in vendor docs only (link in README, not verified here). A SQLite+JSONL storage PR is explicitly motivated by "JSON storage reads/writes the entire file on every operation" and git-friendly sync (**PR #1619**, open: "Version-controlled tasks - The JSONL file can be committed to git"). https://github.com/eyaltoledano/claude-task-master/pull/1619

**Interfaces & footprint:** CLI (`task-master init/parse-prd/list/next/show/…`), MCP server (`npx task-master-ai`, 36 tools ≈21k tokens, reducible via `TASK_MASTER_TOOLS`), no HTTP API/self-host server. Needs Node and ≥1 LLM provider API key for task generation (FACT, README).

**Licence:** "MIT License with Commons Clause" — Commons Clause: "the grant of rights under the License will not include… the right to Sell the Software" (selling / hosting as a service forbidden). https://raw.githubusercontent.com/eyaltoledano/claude-task-master/main/LICENSE

### c) Other file-based trackers for coding agents — Beads (gastownhall/beads)

Read at `main` HEAD (repo pushed 2026-10-13; heavily developed today). Latest release v1.3.2-rc.2 (2026-10-10). 27,834 stars. MIT. Originally Steve Yegge's project, now under gastownhall; docs https://beads.gascity.com/

**What it is (FACT, README):** "Distributed graph issue tracker for AI agents, powered by Dolt… provides a persistent, structured memory for coding agents. It replaces messy markdown plans with a dependency-aware graph." https://raw.githubusercontent.com/gastownhall/beads/main/README.md

**Data model (author claim, README):** dependency-graph of issues in a Dolt (version-controlled SQL) database; hash-based IDs ("`bd-a1b2`… prevent merge collisions in multi-agent/multi-branch workflows"); hierarchical epic IDs; graph links (`blocks`, `relates-to`, `supersedes`); `.beads/issues.jsonl` is an export "not the source of truth".

**Concurrency + claims (author claim vs measured facts):**
- README author claim: "`bd update <id> --claim` | Atomically claim a task (sets assignee + in_progress)."
- Measured facts contradict it under real concurrency: Issue **#3575** (open): "`bd ready` followed by `bd update <id> --claim` is not atomic. When multiple agent processes poll `bd ready` concurrently and both attempt to claim the same bead, both succeed — leading to duplicate work." https://github.com/gastownhall/beads/issues/3575
- Issue **#4657** (open): "the claim is NOT a hard single-writer CAS under true sub-second concurrency" (2-way race → both succeed 5/5). https://github.com/gastownhall/beads/issues/4657
- Issue **#5998** (open, v1.2.2 shared Dolt server): "Two simultaneous invocations of `bd ready --claim`… Both return the same bead." https://github.com/gastownhall/beads/issues/5998
- Fix in flight: PR **#4682** (open) "optimistic concurrency for beads — metadata + whole-row compare-and-swap". https://github.com/gastownhall/beads/pull/4682

**Sync across machines / swarm (author claim, README):** embedded Dolt (in-process, single writer) default; `bd init --server` connects to a concurrent-writer `dolt sql-server`; sync by `bd dolt push/pull` against `refs/dolt/data` on a git remote; experimental HTTP backend (`bd connect https://…`, `bd serve`) and `bd ready --claim` over HTTP ("lists and claims in one transaction" in-memory, with a documented divergence ledger). This is the only one of the three designed for a server-backed multi-writer swarm.

**Deps/ready queue:** `bd dep add`, `bd ready` ("List tasks with no open blockers"), `bd ready --claim` (README, FACT).

**Interfaces & footprint:** Go/brew binary, `npm i -g @beads/bd`; JSON output everywhere; MCP server in-tree (`integrations/beads-mcp`, https://pypi.org/pypi/beads-mcp/json, beads-mcp 1.3.1); `bd setup claude/codex/…` installs agent instructions. Self-hosting: none needed for embedded mode; a Dolt server optional.

## Issues read (each: one short quoted line)

Backlog.md (MrLesk/Backlog.md):
- #937, "Add Git-backed atomic task coordination" (open) — "Fetch-before-edit cannot close this distributed race." https://github.com/MrLesk/Backlog.md/issues/937
- #843, "[Bug]: task edit loses concurrent writes silently…" (closed) — "Two `backlog task edit` calls on the same task, running concurrently, lose one of the two writes." https://github.com/MrLesk/Backlog.md/issues/843
- #860, "BACK-575 - Fail fast instead of silently losing concurrent task edits" (merged PR closing #843) — "Locks live under `backlog/.locks/` (per-checkout…)". https://github.com/MrLesk/Backlog.md/pull/860
- #852, "Serialize the task edit read-modify-write with a per-task lock" (withdrawn PR) — "a per-task lock around the whole read → mutate → write". https://github.com/MrLesk/Backlog.md/pull/852
- #565, "BACK-404 - Harden task ID locking for concurrent create/promote/demote operations" (merged PR) — "serialize task, draft-promotion, and task-demotion ID allocation with a library-backed lock". https://github.com/MrLesk/Backlog.md/pull/565
- #997, "[Bug]: task create reuses an id already claimed by an archived task" (open) — "the next `task create` hands the same `task-N` to a new task". https://github.com/MrLesk/Backlog.md/issues/997

Claude Task Master (eyaltoledano/claude-task-master):
- #1566, "fix: Add cross-process file locking to prevent race conditions" (merged PR) — "multiple Claude Code windows… could corrupt the JSON file or cause saved work to be lost". https://github.com/eyaltoledano/claude-task-master/pull/1566
- #1568, "Adopt modifyJson() pattern… to prevent lost updates" (closed) — "Several methods in file-storage.ts use a read-modify-write pattern that can still result in lost updates." https://github.com/eyaltoledano/claude-task-master/issues/1568
- #1637, "bug: MCP server stale in-memory tag state causes cross-tag data corruption" (open) — "maintains an in-memory currentTag state that becomes stale across operations". https://github.com/eyaltoledano/claude-task-master/issues/1637
- #1619, "feat(storage): Add SQLite storage backend with JSONL sync" (open PR) — "The JSONL file can be committed to git." https://github.com/eyaltoledano/claude-task-master/pull/1619

Beads (gastownhall/beads):
- #3575, "Race condition: bd ready / bd update --claim allows simultaneous claims of same bead" (open) — "both attempt to claim the same bead, both succeed — leading to duplicate work." https://github.com/gastownhall/beads/issues/3575
- #4657, "bd update --claim is not a hard CAS under true sub-second concurrency (load-tested)" (open) — "the claim is NOT a hard single-writer CAS". https://github.com/gastownhall/beads/issues/4657
- #5998, "'bd ready --claim' is not transactional" (open) — "Both invocations return the same bead". https://github.com/gastownhall/beads/issues/5998
- #4682, "feat(cas): optimistic concurrency for beads" (open PR) — "metadata + whole-row compare-and-swap". https://github.com/gastownhall/beads/pull/4682

## Per-question matrix

| Question | Backlog.md | Task Master | Beads |
| --- | --- | --- | --- |
| Concurrency model | Per-task lockfile per checkout, fail-fast on same-task edit (single host only); no distributed claim yet (#937 open) | proper-lockfile + atomic writes on one tasks.json (single host); tag-state bugs remain | Dolt; embedded = single writer; server/HTTP modes = concurrent writers; claim races open (#3575/4657/5998) |
| Atomic claim story | NONE across machines; #937 proposes git-ref CAS; local ID allocation serialized (#565) but archived-ID reuse bug (#997) | NONE (no claim tool documented) | "Atomic" is an author claim; load-tested NOT atomic (#4657) |
| Sync across machines | Nothing built in (no push in the tool); per-file git merges; cross-branch *reading* only | NOT DOCUMENTED; file travels via git manually; SQLite/JSONL backend only a PR | Built in: `bd dolt push/pull` to git remote `refs/dolt/data`, or SQL-server/HTTP modes |
| Deps / ready queue | dependencies field + board views; no dedicated ready query | dependencies + `next` ready queue | dependency graph + `bd ready` / `bd ready --claim` |
| Interfaces | CLI, MCP, local web UI, JSON API | CLI, MCP (36 tools) | CLI (JSON), MCP (beads-mcp), HTTP serve |
| Self-hosting footprint | One Node/bun CLI, optional local web UI (127.0.0.1), git optional | Node + npm + LLM provider API key | Go binary; embedded Dolt default; optional dolt sql-server / HTTP server |
| Licence | MIT | MIT + Commons Clause (no selling/hosting) | MIT |

## Not verified

- Any connection between Tobias Lütke ("tobi") and Backlog.md — `tobi/backlog.md` 404s; "by tobi" in the lane brief is contradicted by GitHub API (repo author is MrLesk).
- Backlog.md's distributed behavior with `remoteOperations: true` beyond code reading (no live multi-pod test run here).
- Task Master's "Team Collaboration" vendor docs (tryhamster.com) — not fetched; multi-agent story beyond README remains vendor-doc territory.
- Beads claim behavior on the latest 1.3.2-rc builds (the race issues cite 1.2.2–current main; no live load test performed here).
- Exact npm download/usage numbers beyond badges; MCP tool-count token costs taken verbatim from the Task Master README.
