# API servers for human/agent interaction — Plane, Gitea, and agent-oriented coord trackers

Reading date: 2026-10-13. All URLs fetched live on that date. Versions/refs read are stated per item.

## Summary

- **Plane** (makeplane/plane, branch `preview`, 2026-10-13) is **AGPL-3.0, not Apache-2.0** (LICENSE.txt). It is a REST-API project-management platform whose self-host stack is heavy: the development compose alone runs web, admin, space, api, worker, beat-worker, migrator, live, proxy plus Postgres 15.7, Valkey 7.2.11, RabbitMQ 3.13.6 and an S3-compatible (Silo) service; a Helm chart and a one-container "Docker AIO" are also official paths.
- Plane has an official MCP server (`makeplane/plane-mcp-server`, MIT) with 30 tools / 207 operations, stdio/HTTP/SSE transports, and first-class self-host support via `PLANE_BASE_URL`.
- Plane's API documents **no optimistic locking or claim/transition guarantees**. Issue #9995 documents concurrent description PATCHes silently overwriting each other (last writer wins); atomicity is being fixed endpoint-by-endpoint (PR #9684, "make transfer_cycle_issues atomic", open, not merged as of reading).
- **Gitea** (go-gitea/gitea, main branch; swagger read from gitea.com instance `29.0.0+dev-19-g1204a0cbf2`) is **MIT**, ships as a single binary "with SQLite, MySQL and PostgreSQL support, and built with embedded assets", and runs in one container.
- The prompt's assumption "Gitea has no dependency graph" is **wrong at the data level**: Gitea serves `GET/POST/DELETE /repos/{owner}/{repo}/issues/{index}/dependencies` ("all issues that block this issue"), and the POST body takes an `owner/repo/index` triple, so blocking edges are cross-repo. Verified live (HTTP 200) on gitea.com. There is no ready-queue over those edges — an agent must compute "ready = unassigned AND not blocked" itself (inference). There is also **no webhook event for dependency changes** (issue #11765, open).
- Gitea docs do have **optimistic locking, but only for body edits**: `PATCH .../issues/{index}` says "Pass `content_version` to enable optimistic locking on body edits. If the version doesn't match the current value, the request fails with 409 Conflict." Whether a claim (assignee) edit can use it is not documented — not verified.
- An official **Gitea MCP server exists**: `gitea.com/gitea/gitea-mcp` ("Gitea's official MCP Server", MIT), Go binary / `docker.gitea.com/gitea-mcp-server`, stdio + stateless HTTP, OAuth 2.1 for remote clients.
- Three bead-lineage agent-oriented coordination tools beyond beads itself read from their own repos: **Gas Town** (gastownhall/gastown, MIT, multi-agent workspace manager using Beads as its ledger), **MCP Agent Mail** (Dicklesworthstone/mcp_agent_mail and its Rust successor, MIT+OpenAI/Anthropic rider, FastMCP coordination layer with inboxes and file leases over Git+SQLite), and **bead-forge** (jedarden/bead-forge, MIT+rider, drop-in beads_ruset replacement whose claim command is atomic via SQLite `BEGIN IMMEDIATE`).

## Evidence

### a) Plane — footprint

- Licence is AGPL-3.0: `LICENSE.txt` on branch `preview` reads "GNU AFFERO GENERAL PUBLIC LICENSE"; the GitHub API also reports `spdx_id: AGPL-3.0`. https://raw.githubusercontent.com/makeplane/plane/preview/LICENSE.txt , https://api.github.com/repos/makeplane/plane — FACT FROM SOURCES.
- Compose in-repo (branch `preview`, `docker-compose.yml`) defines 13 services: web, admin, space, api, worker (bgworker), beat-worker, migrator (one-shot), live, plane-db (`postgres:15.7-alpine`, `max_connections=1000`), plane-redis (`valkey/valkey:7.2.11-alpine`), plane-mq (`rabbitmq:3.13.6-management-alpine`), plane-minio (S3-compatible Silo image), proxy. https://raw.githubusercontent.com/makeplane/plane/preview/docker-compose.yml — FACT FROM SOURCES.
- Official architecture doc lists exactly those services plus Monitor (license validation), Silo (GitHub/GitLab/Slack integrations) and Intake (email ingest) as deployable services, with PostgreSQL 15.7+/16 and Redis/Valkey requirements. https://developers.plane.so/self-hosting/plane-architecture — AUTHOR/VENDOR CLAIM (their own doc).
- Deployment methods offered: Docker, Docker Compose, Docker AIO, Docker Swarm, Kubernetes (Helm), Podman Quadlets, airgapped. https://developers.plane.so/self-hosting/overview — AUTHOR/VENDOR CLAIM.

### a) Plane — API

- REST only (versions v2 "latest" and v1): the API reference catalogue lists Work Items, States, Labels, Cycles, Modules, Milestones, Pages, Estimates, Webhooks etc.; there is no GraphQL section. https://developers.plane.so/api-reference/introduction — FACT FROM SOURCES (catalogue of what the docs contain).
- Webhooks are part of the v2 API: `create/get/list/delete webhook`, `regenerate-webhook-secret`, and webhook log endpoints (overview, list, get). https://developers.plane.so/api-reference/v2/webhooks/create-webhook , https://developers.plane.so/api-reference/v2/webhook-logs/overview — FACT FROM SOURCES (URLs exist in the docs sitemap at https://developers.plane.so/sitemap.xml; the pages were found via the sitemap, not each opened — treat details as not individually verified).

### a) Plane — atomic claiming / concurrency

- Issue #9995 (open): "When two people have the same work item open, the one who saves last silently overwrites what the other saved in the meantime, including newly added images." The reporter traces it to `IssueViewSet.partial_update` accepting a bare `PATCH` with `description_html`. https://github.com/makeplane/plane/issues/9995 — FACT FROM SOURCES (reporter's description, not a maintainer guarantee either way).
- PR #9684 "fix(cycles): make transfer_cycle_issues atomic" (open, not merged) states the function did "two separate, sequential DB writes" where the second "may never run" if the worker is killed. https://github.com/makeplane/plane/pull/9684 — FACT FROM SOURCES.
- Inference: assigning an issue is a plain PATCH of an assignees field with no documented version check, so two agents claiming the same issue cannot do so atomically; no at-least-once or transition guarantees are documented anywhere in the API reference or the searched issues. NOT VERIFIED exhaustively, but no contrary evidence appeared.

### a) Plane — MCP

- Official server: `makeplane/plane-mcp-server`, MIT, README headline "Plane's Official Model Context Protocol Server", 339 stars, last pushed 2026-10-08. https://github.com/makeplane/plane-mcp-server — FACT FROM SOURCES.
- Its README: "30 tools, one per Plane resource, covering 207 operations"; transports stdio, streamable HTTP, SSE (deprecated); OAuth or API-key auth; for self-hosted Plane set `"PLANE_BASE_URL": "https://plane.example.com"`. https://raw.githubusercontent.com/makeplane/plane-mcp-server/main/README.md — FACT FROM SOURCES.
- In-product MCP features are still being developed in the main repo (e.g., issue #8585 "[feature]: MCP support for Epics", #9023 "[feature]: Support reordering modules via API and MCP", bug #8926 "[bug]: MCP Auth Non Stop Opening Tabs", #9322 "MCP doesn't stay logged in"). https://github.com/makeplane/plane/issues/8926 etc. — FACT FROM SOURCES (titles/search hits; bodies not read for these).

### b) Gitea — footprint

- Licence MIT: https://api.github.com/repos/go-gitea/gitea — FACT FROM SOURCES.
- Install-from-binary docs (version 1.24.7 line also served; page fetched 2026-10-13): "All downloads come with SQLite, MySQL and PostgreSQL support, and are built with embedded assets"; arm64 build explicitly named "Raspberry PI 4". https://docs.gitea.com/installation/install-from-binary/ — FACT FROM SOURCES.
- A minimal Docker install is one `gitea` container plus an optional database service, per the walk-through compose in the docs. https://docs.gitea.com/next/installation/install-with-docker — FACT FROM SOURCES (page walked through compose setup; no fixed hardware minimum found in current docs — old "Hardware requirements" section no longer present, not verified).

### b) Gitea — issues API and claiming

- Multiple assignees are supported: `CreateIssueOption`/`EditIssueOption` carry an `assignees` array of usernames, with a deprecated singular `assignee` string; the `Issue` schema returns `assignees` as an array of users. Swagger read from gitea.com (`29.0.0+dev-19-g1204a0cbf2`), i.e. the API of the actively developed Gitea as of 2026-10-13. https://gitea.com/swagger.v1.json — FACT FROM SOURCES.
- Optimistic locking is documented for body edits only: summary of `PATCH /repos/{owner}/{repo}/issues/{index}` contains "Pass `content_version` to enable optimistic locking on body edits. If the version doesn't match the current value, the request fails with 409 Conflict." The swagger defines no `If-Match`/`ETag` parameters (0 occurrences). https://gitea.com/swagger.v1.json — FACT FROM SOURCES.
- Inference: a claim by POSTing/PATCHing `assignees` gets last-writer-wins (assignee changes are not stated to be covered by `content_version`); whether Gitea enforces anything on simultaneous assignment is NOT VERIFIED.

### b) Gitea — dependencies (the prompt's assumption is wrong) and webhooks

- Dependency endpoints exist: `GET /repos/{owner}/{repo}/issues/{index}/dependencies` — "List an issue's dependencies, i.e all issues that block this issue"; `POST` same path — "Make the issue in the url depend on the issue in the form" (body schema `IssueMeta`: `owner`, `repo`, `index` — so a blocking issue can live in another repo); `DELETE` same path — "Remove an issue dependency". https://gitea.com/swagger.v1.json — FACT FROM SOURCES.
- Verified live: `GET https://gitea.com/api/v1/repos/gitea/gitea-mcp/issues/289/dependencies` returned HTTP 200 with `[]` — FACT FROM SOURCES (checked 2026-10-13).
- No webhook trigger for dependency changes: issue #11765 "Add webhook trigger for issue dependencies" (open, filed against 1.11.6, still open) quotes: "Adding, changing, or removing dependencies on an issue does not have a webhook trigger as of Gitea 1.11.6." https://github.com/go-gitea/gitea/issues/11765 — FACT FROM SOURCES.
- Labels and assignees are plain first-class fields (labels CRUD, `assignees` above) — Gitea models a "ready queue" only through an agent-side policy over assignees + dependency edges; nothing native computes ready work. Inference based on the swagger and docs; the docs do not advertise any ready-queue feature.
- Webhooks: "Gitea supports these outgoing webhook integrations: Gitea Gogs Slack Discord Dingtalk Telegram Microsoft Teams Feishu Matrix Wechatwork Packagist"; generic Gitea/Gogs payloads POST JSON or form-encoded, HMAC-signed with a secret. https://docs.gitea.com/next/usage/repository/webhooks/ — FACT FROM SOURCES.

### b) Gitea — MCP

- `gitea.com/gitea/gitea-mcp`, README headline "Gitea MCP Server ... connects a Gitea instance to Model Context Protocol clients"; repo metadata "Gitea's official MCP Server"; ships a Go binary from releases, the `docker.gitea.com/gitea-mcp-server` image, and builds with Go 1.27+. https://gitea.com/gitea/gitea-mcp (README raw: https://gitea.com/gitea/gitea-mcp/raw/branch/main/README.md) — FACT FROM SOURCES.
- MIT: LICENSE file reads "MIT License, Copyright (c) 2025 The Gitea Authors". https://gitea.com/gitea/gitea-mcp/raw/branch/main/LICENSE — FACT FROM SOURCES.
- Transport details: MCP `2026-07-28` with negotiation, tools-only capability, stateless HTTP `/mcp` (POST), `Authorization: Bearer/token` credential passthrough, `/healthz` probes, `-oauth-public-url` OAuth 2.1 flow for web/mobile clients. Same README — FACT FROM SOURCES.

### c) Agent-oriented coordination tools named by beads/beads_rust

- Context anchor: beads itself is now `gastownhall/beads` (MIT; steveyegge/beads redirects), README describes it as "(Dolt)-Powered" (version-controlled SQL database) with hash-based IDs "prevent(ing) merge collisions in multi-agent/multi-branch workflows", a Python MCP wrapper published as `beads-mcp` on PyPI, and "auto-ready task detection". https://github.com/gastownhall/beads , https://raw.githubusercontent.com/steveyegge/beads/main/README.md — FACT FROM SOURCES.
- **Gas Town** — `gastownhall/gastown` (steveyegge/gastown redirects; MIT; 18,351 stars; "Gas Town - multi-agent workspace manager"). README: orchestration for "Claude Code, GitHub Copilot, Codex, Gemini, and others"; a "Mayor" AI coordinator, "Rigs" per project, "Polecats" worker agents, git-worktree-based "Hooks" for persistent storage, and "Convoys" as work-tracking units bundling Beads that get assigned to agents; "Work state stored in Beads ledger". Storage: git worktrees + Beads. API: CLI (`gt sling`), no REST/MCP server documented in the README read. https://github.com/gastownhall/gastown , https://raw.githubusercontent.com/gastownhall/gastown/main/README.md — FACT FROM SOURCES.
- **MCP Agent Mail** — `Dicklesworthstone/mcp_agent_mail` (2,203 stars; Python original, superseded) and `Dicklesworthstone/mcp_agent_mail_rust` (maintained successor, badge "License: MIT+OpenAI/Anthropic Rider"). README: "mail-like coordination layer for AI coding agents, exposed as an MCP server with 45 tools and 25 resources, Git-backed archive, SQLite indexing"; agents get "memorable identities, an inbox/outbox, searchable message history, and voluntary file reservation 'leases'". Storage: Git (auditable artifacts) + SQLite (indexing). API: MCP over FastMCP plus CLI/TUI/web UI. Licence: "MIT License (with OpenAI/Anthropic Rider)" (LICENSE file). https://github.com/Dicklesworthstone/mcp_agent_mail , https://raw.githubusercontent.com/Dicklesworthstone/mcp_agent_mail/main/README.md , https://raw.githubusercontent.com/Dicklesworthstone/mcp_agent_mail_rust/main/README.md , https://raw.githubusercontent.com/Dicklesworthstone/mcp_agent_mail_rust/main/LICENSE — FACT FROM SOURCES.
- **bead-forge** — `jedarden/bead-forge` (small, 4 stars as of reading). README: "a repo-local issue tracker built for multi-agent AI coding workflows ... a drop-in replacement for beads_rust (`br`) — every `br` command works unchanged. On top of that it adds atomic claiming via SQLite `BEGIN IMMEDIATE` transactions, so 20 workers can claim work simultaneously without racing each other", with `bf claim --assignee worker-1 --format json`. Storage: JSONL entries (+ SQLite as in beads lineage, per its ecosystem table). Licence: "MIT License (with OpenAI/Anthropic Rider)" (LICENSE file). https://github.com/jedarden/bead-forge , https://raw.githubusercontent.com/jedarden/bead-forge/main/README.md — FACT FROM SOURCES. Note the README characterizes both beads and beads_rust as having "no atomic claiming"/same "SQLite single-writer" concurrency story — AUTHOR/VENDOR CLAIM by a competitor project, not independently verified here.
- Side signal from beads issue tracker: issue #2829 "Scoped Linear sync for parallel agent execution across worktrees" (open) quotes: "Linear is increasingly positioning itself as the shared context layer for agent-driven software development" — i.e. beads' ecosystem also points at hosted tracker Linear as a coordination layer for agents. https://github.com/gastownhall/beads/issues/2829 — FACT FROM SOURCES (quote of issue #2829 body).

## Issues read (bodies read or quoted)

- makeplane/plane #9995 — "Bug: Concurrent edits silently overwrite work item descriptions (lost images/text)" — open; reporter traces silent last-writer-wins overwrites on work item PATCH. https://github.com/makeplane/plane/issues/9995
- makeplane/plane PR #9684 — "fix(cycles): make transfer_cycle_issues atomic" — open, unmerged; makes a two-write cycle transfer a single DB transaction. https://github.com/makeplane/plane/pull/9684
- go-gitea/gitea #11765 — "Add webhook trigger for issue dependencies" — open since Gitea 1.11.6; dependency add/change/remove still has no webhook event. https://github.com/go-gitea/gitea/issues/11765
- gastownhall/beads #2829 — "Scoped Linear sync for parallel agent execution across worktrees" — open; proposes syncing scoped bead sets to Linear as the shared coordination graph for agents. https://github.com/gastownhall/beads/issues/2829

Search-hit titles only (bodies not read, listed for completeness): plane #8585, #8613, #8926, #9023, #9322 (MCP features/bugs); plane #9049, PR #9401 (page webhooks); gastownhall/beads PR #7049 ("refuse --claim on an issue with an open blocker"), #7451 ("External blocks edges ignored by ready/blocked/claim").

## Not verified

- Plane: whether work item PATCH accepts any `version`/`If-Match` field enabling a CAS claim (API docs catalogue was read, not every endpoint body); whether webhook *payload* shapes match the v2 endpoints' promises (pages found via sitemap only); hardware sizing numbers for the self-host stack (docs give service list, not CPU/RAM floors).
- Gitea: whether assigning an issue concurrently is safe in any backend (no doc guarantee found; not tested); whether issue dependencies work in the *current stable* release's web UI (verified only at the REST level on the dev instance); whether dependencies render as any graph view in Gitea's UI; current Gitea stable's recommended minimum hardware (the old "Hardware requirements" section seems removed from current docs).
- bead-forge: it is 4 stars and young; its "20 workers ... without racing" claim is the vendor's own, not reproduced here.
- Gas Town: whether it offers any non-CLI (MCP/HTTP) interface for external agents — README read covers CLI/gt commands only.
