# lifemodel

## Backlog workflow

All retained work and commits belong to tracked tasks. File discoveries through
`to-backlog`; implement through `take-task`; close only after stage acceptance
through `close-out`. Read Backlog integration in `docs/backlog-integration.md`
before writes. When a skill reports the installation is out of date, run
`setup-shady2k-skills`.

This repository works through the shady2k-skills plugin. Without it, install it once
(Claude Code: `/plugin marketplace add shady2k/skills`, then
`/plugin install shady2k-skills@shady2k`; Prime Agent or Pi:
`prime-agent package install git:github.com/shady2k/skills` / `pi install git:github.com/shady2k/skills`).

**Every commit names its leaf task** in parentheses in the subject, e.g.
`Fix the thing (lifemodel-7ld)`; the commit-msg hook and CI enforce it.

## What this is

A human-like, proactive AI agent: it runs continuously, accumulates internal and
external pressure, and decides on its own when to think, act, or reach out. The
architecture mirrors the human body — Channels are the senses, Signals are neural
impulses, Layers are brain regions, CoreLoop is the heartbeat (a fixed 1-second
tick), Energy & state are physiology. Start with `README.md` and
`docs/architecture.md`.

## Repository layout

- `src/index.ts` — entry point: builds the container and starts CoreLoop
- `flake.nix`, `flake.lock` — Nix flake exporting the NixOS module and defining flake checks
- `deploy/root/` — Flux root OCIRepository and Kustomization templates
- `deploy/nixos/` — the `services.lifemodel` NixOS module and setup guide
- `deploy/platform/` — the signed platform OCI artifact applied by Flux: A0 starts the loader before dependent step A creates OpenBao, Gitea and application namespaces, step B installs CloudNativePG and step C creates the shared stores; step D, last, runs the storage module whose readiness reads the database catalog; loader first-start phases establish Bao custody, seed protected Gitea branches and create the application sources and Kustomizations (ADR-010, ADR-015)
- `deploy/cli/` — `lifemodel doctor` recovery and health-diagnosis CLI
- `docker/loader/` — the loader's OCI image, including platform-mode packaging
- `scripts/install.sh` — generic-Linux platform installer
- `scripts/release/` and `.github/workflows/release.yml` — signed platform release workflow and digest pinning helper
- `scripts/test-isolated.mjs` — disposable test boundary; its source snapshot allowlist includes `deploy/`
- `src/core/` — the heart: CoreLoop tick, Agent, energy model, scheduler,
  plugin loader and discovery, container (dependency wiring), event bus and
  queue, intent application, metrics, tracing, the bounded shutdown-drain
  sequence (one overall stop deadline; intake stop first, sends of the drained
  turn awaited, channels released after, storage flushed last) with its hard
  exit at the deadline (`hard-exit.ts`), and the durable
  stream-backed inbound messages, included in the tick snapshot and deduplicated
  by external message id
- `src/layers/` — the brain: `autonomic/` (neurons, filters, zero LLM cost),
  `aggregation/` (buckets, patterns, the wake threshold), `cognition/` (the
  agentic LLM loop with its prompts, message builders and core.* tools, plus
  the `soul/` inner-life modules)
- `src/runtime/` — Motor Cortex (the sandboxed agentic act loop), Docker
  container management, sandbox and shell runners, the Agent Skills loader
  (`skills/`), built-in skills (`builtin-skills/`), locks, credentials
- `src/channels/` — shared channel interfaces; gateways deliver through the inbound stream
- `src/plugins/` — plugins proper (alertness, calories, contact-pressure,
  desire-pressure, energy, news, reminder, social-debt, thoughts, time-neuron,
  web-fetch, web-search) and shared helper libraries (`providers/`,
  `web-shared/`)
- `src/llm/` — the provider interface, the single OpenAI-compatible endpoint
  provider (the endpoint names a model per role; no separate keyed provider
  and no fallback), tool-schema conversion, conversation-log writing
- `src/storage/` — persistence: Postgres storage, conversations, the dual-layer memory
  (pgvector vector store + JSON graph store), the soul
- `src/ports/` — the narrow interfaces plugins see (LLM, storage, scheduler, …)
- `src/types/` — Signal, Intent, Plugin, Cognition and friends: the shared
  vocabulary
- `src/models/`, `src/config/`, `src/utils/` — the user model, config
  loading/schema, small utilities
- `tests/` — unit and integration tests, fixtures, helpers
- `docs/` — architecture, concepts, features, plugins, ADRs, charters
- `cli/browser-auth.ts` — browser authentication helper
- `.backlog/` — the backlog gate and its rules, and in `.backlog/sync/` the
  mechanism that keeps the tracker outside the code branches: one store per
  machine on `refs/tracker/state`, linked from each checkout's `.beads`;
  `docs/backlog-integration.md` describes the workflow

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | run from source with tsx (`src/index.ts`) |
| `npm run build` | compile to `dist/` and copy `src/runtime/builtin-skills` |
| `npm start` | run the build (`dist/index.js`) |
| `npm run test` | run the whole test suite inside the disposable test boundary (`node scripts/test-isolated.mjs test`) |
| `npm run test:docker` | the launcher's docker mode (`node scripts/test-isolated.mjs docker`) |
| `npm run test:watch` | explicitly unsupported: the launcher runs the suite one-shot and bounded and has no watch option yet, and watch on the host is refused by the entrypoint policy — run `node scripts/test-isolated.mjs test -- <path>` instead |
| `npm run check` | every product check in one command — typecheck, lint, the format check and the suite (`--maxWorkers=2`), all started through the isolated launcher (`node scripts/test-isolated.mjs check`), stopping at the first failure; the exact command CI's product job runs |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint over `src/` and `loader/` (`lint:fix` to auto-fix) |
| `npm run format` / `format:check` | Prettier over `src/**/*.ts` and `loader/**/*.ts` |
| `npm run connect` | connect this clone: git hooks, the link to this machine's tracker store, gate check |
| `npm run backlog` | the backlog gate (`npm run backlog:json` for JSON output) |
| `npm run present` | the present-documents check |
| `nix flake check` | checks the exported NixOS module and platform installer rendering; needs Nix; CI's `ci-nix` job runs it on pull requests that touch what the flake reads (selected by `scripts/ci-nix-paths.sh`) (lifemodel-lut.3.6) |
| `npm run ready` | open leaves ready to claim |
| `npm run browser:auth` | browser authentication (`cli/browser-auth.ts`) |

`dev`, `build`, `start`, `typecheck` and `lint` need `node_modules` (`npm ci`,
on node 24 to match CI's own install). `npm run test` and `npm run check` do
not need host `node_modules`: they need **Node.js ≥ 24 and Docker** (Test
isolation, below). The backlog gate and the present check need only `node`.
Docker is required for the isolated test boundary and for Motor Cortex agentic
runs.

## Test isolation

Local and ordinary CI suites never start on the host. Their entrypoints — `npm run test`,
`npm run check`, the husky pre-commit hook, CI's product job — goes through the
disposable test boundary, `scripts/test-isolated.mjs
<check|test|docker> [--timeout-ms <ms>] [-- <vitest args>]`:

- a run is one-shot and bounded, with at most 2 vitest workers enforced twice —
  by the launcher and by `vitest.config.ts`;
- the run works inside a disposable container built from a selective snapshot
  of the tree (allowlisted source, test and config paths, the manifests),
  copied in — nothing of the owner checkout is bind-mounted, and `.git`,
  `.env*`, `data/`, `node_modules`, git credentials and the Docker socket
  never reach it; the launcher fails closed when it cannot hold that;
- the launcher installs SIGINT/SIGTERM handlers and a hard deadline: on exit —
  success, inner failure, timeout or interruption — it stops and removes the
  test/store containers, the per-run internal store network and temporary
  source images it started, then returns the exit code (124 for timeout,
  130/143 for interruption); a hard kill can leave labeled resources behind,
  and it prunes matching containers, networks and snapshot images at the next
  run start and reports what it pruned;
- each run pulls digest-pinned Valkey 8.1 and Postgres 17.11/pgvector images
  during provisioning, starts them with memory-backed data and resource caps,
  and waits for both readiness checks before Vitest. The test container joins
  only their dedicated `--internal` Docker network and receives
  `LIFEMODEL_TEST_VALKEY_URL` and `LIFEMODEL_TEST_DATABASE_URL`; that network
  has no outside route. The test container receives no Docker socket or host
  mounts. Tests use `tests/helpers/test-stores.ts` for a Postgres database and
  Valkey logical database per Vitest worker. The Postgres database is created on
  demand and dropped when its test file finishes
  (`tests/setup/test-store-cleanup.ts`); one left per file filled the 512 MiB
  data volume (measured peak 472 MiB of it before, ~70 MiB after, with at most
  three worker databases at a time; a file whose client is still connected at
  teardown has its database dropped `WITH (FORCE)` and logs the count). Missing
  store URLs fail tests; there is no skip or substitute store;
- the boundary runs Node.js 24.21.0 (`node:24.21.0-bookworm-slim`) with
  dependencies provisioned by native `npm ci` inside a container. Only the
  allowlisted `legacy-peer-deps` install policy is copied from `.npmrc`;
  credentials and registry overrides are rejected. The dependency cache key
  includes the manifests, policy and resolved base image/platform. Provisioning
  can use the network; the test container is isolated to its internal store
  network, non-root, capped at 2 CPUs, 3 GiB of memory (no additional swap) and
  256 processes. Its root filesystem is read-only; writes use memory-backed
  `/tmp` (768 MiB) and `/home/node` (64 MiB). The per-run source image is
  removed after the container. The dependency cache is intentionally retained;
- the overall run deadline is 25 minutes (`--timeout-ms` can lower it). Cleanup
  is awaited afterwards; the Docker-machine helper has up to 75 seconds to stop
  control processes and delete its machine after interruption;
- `docker` mode runs on macOS with OrbStack. It creates a fresh Ubuntu 24.04
  machine with `--isolated --isolate-network`, 2 CPUs, 4 GiB memory and a
  32 GiB disk limit. No Mac mounts or SSH forwarding are enabled. The source
  and SHA-verified Node/Docker artifacts arrive over stdin; native `npm ci`
  and a private rootless Docker daemon run inside the machine. Docker mode
  pulls and starts the same digest-pinned Valkey and Postgres services on an
  internal network, publishes them only to machine loopback for Vitest, waits
  for readiness, then removes the services/network before deleting the
  machine. OrbStack machines share a Linux kernel: this is not a hardware-VM security boundary.
  Unsupported hosts, missing OrbStack and failed rootless setup fail closed;
  there is no owner-socket, privileged or host-suite fallback. Deletion is
  awaited from outside the machine; an unconfirmed deletion keeps its claim
  for next-run recovery and cannot turn a successful suite into a green run;
- the entrypoint policy is itself tested: `tests/unit/test-entrypoints.test.ts`
  reads committed config surfaces (package.json scripts, vitest config, the
  pre-commit hook, CI, lockfile agreement and store-image/network policy) and
  refuses a
  raw vitest start on the host in every CI job.

CI builds and publishes the standalone core and web images. It also builds the platform loader image on pull requests that touch its inputs, without publishing it, and runs `nix flake check` on pull requests that touch what the flake reads (the `ci-nix` job); all tests run through the isolated launcher.

Prerequisites for test runs and checks: **Node.js ≥ 24 and Docker**. Watch
(`test:watch`) is explicitly unsupported, never a host fallback.

## Testing

- All tests live in `tests/` (unit and integration, plus `fixtures/` and
  `helpers/`). Never create test files inside `src/`.
- Run the suite with `npm run test` — through the boundary, one-shot and
  bounded (Test isolation, above).
- `npm run check` is the one command with CI's verdict — CI's `ci-product` job
  runs the same launcher command, `node scripts/test-isolated.mjs check`, on
  node 24 behind GitHub's disposable Docker daemon: typecheck, lint, the
  format check and the suite (at most 2 workers), stopping at the first
  failure. No `npm ci` runs on the `ci-product` host. A manifest that disagrees with
  `package-lock.json` fails the entrypoint policy tests in the suite, which is
  what `npm ci` used to prove before the checks started.
- Run one file: `node scripts/test-isolated.mjs test --
  tests/unit/energy-management.test.ts` (unit or ordinary integration tests).
- Tests do not use pino's file transport: it writes from a worker thread that a
  test cannot stop, and it raced the removal of temp directories. Use a
  recording or in-memory logger (`tests/helpers/test-logger.ts`), or
  `logToFile: false` for a real container.
- An assertion waits for the event it checks (a log line, a settled outcome),
  never for a tick count or a timer: the tick counter rises when a tick starts,
  before its work is done.

## Data & logs

Created at runtime relative to the working directory; the root is `data/`
(override with `DATA_PATH`; defaults live in `src/config/config-schema.ts`).
`DATA_PATH` moves logs and plugin/runtime files, not durable application state. Configuration is stored in the core Postgres schema `core.settings`; `src/config/config-loader.ts` does not read or write a config file. `resolveConfigDir` and `data/config/agent.json` are removed.

- `data/logs/agent-<timestamp>.log` — pino logs (pino-pretty formatted):
  system events, errors. Default level is `info`; the LLM request
  summaries, responses and `contentPreview` are `debug` — set
  `LOG_LEVEL=debug` to see them. That shows previews of non-tool messages
  only: tool results and assistant messages carrying tool calls are logged
  at `trace`, which `LOG_LEVEL` cannot select — read tool calls and results
  in the conversation log instead (`src/llm/provider.ts`,
  `src/config/config-loader.ts`). The newest 10 non-empty files are kept
  (`src/core/logger.ts`)
- `data/logs/conversation-<timestamp>.log` — the LLM exchanges, formatted,
  not verbatim: role markers and separators, indented content, only the new
  messages of each request (history is summarized in one line), tool calls
  and results pretty-printed, responses unwrapped from their JSON envelope;
  the file comes from `src/core/logger.ts`, the entries from
  `src/llm/provider.ts`
- Persistent state lives in its declared store: the tick snapshot, bus offsets and inbound/outbound streams live in Valkey; conversations, memory, soul, registries, plugin settings, schedules and configuration live in Postgres. `DATA_PATH` is not a persistent-state store and the core must start when it is read-only. In the cluster, logs go to stdout (`kubectl logs`), and the ONNX model is baked into the core image at `/opt/model-cache` and read in place. Motor Cortex and its skill/workspace/run directories are disabled in the cluster (`MOTOR_CORTEX_ENABLED=false`) and move with lifemodel-653; when disabled, they must not create `data/skills`, `data/motor-runs` or `data/models`. Back up the stores before destructive recovery; logs and stores hold personal messages and tool content.

## Debugging unexpected agent output

Verify each step against the logger code (`src/core/logger.ts`,
`src/llm/provider.ts`, `src/layers/cognition/agentic-loop.ts`) — the format
below is what that code writes today.

1. Find the newest logs: `ls -t data/logs/agent-*.log | head -3`
2. Find the exchange: search the conversation log for the bad output text,
   or by timestamp. Conversation lines carry a `[traceId:spanId]` prefix
   only when trace context reaches the logger — a cognition turn runs
   outside it, so a prefix is often missing there; the trace id is
   shortened to its first 8 characters when present.
3. Trace the chain: with `LOG_LEVEL=debug`, the agent log holds the LLM
   request summaries, responses and post-processing. Follow the trace id
   seen in the conversation log, or the tick's id as `correlationId` (a
   cognition wake is traced from its trigger signal; the tick id links, it
   does not root), or fall back to the same timestamp window.

Conversation log format (schematic; written by `src/llm/provider.ts`). One
log entry carries a whole request or response block, so the
`[timestamp] [traceId:spanId]` prefix is written once, before the block:

```
[HH:MM:SS.mmm] [traceId:spanId]
════════════════════════════════════════════
→ REQUEST [req_N] to provider (model)
────────────────────────────────────────────
► [N] ROLE:
  message content
────────────────────────────────────────────
← RESPONSE [durationMs, tokens tokens, finish_reason] gen:<generationId>
  LLM response
════════════════════════════════════════════
```

Key fields in the agent log:

| Field | What it tells you |
| --- | --- |
| `traceId` / `spanId` | one processing chain / one span in it (`tick_<n>`, a signal's child span, …) |
| `triggerType` | what caused the agent to act (`user_message`, `contact_urge`, `thought`, …) |
| `model` / `provider` | which model produced the output; the role (fast/smart/motor) routes it |
| `generationId` | OpenRouter generation id for provider-side debugging |
| `finishReason` | `stop` normal, `tool_calls` a tool round, `length` truncated, `error` provider failure |
| `response` / `contentPreview` | full raw LLM output / first 200 chars of a request message |

Common issues:

- **Model echoing instructions:** search the agent log for
  `"Accepted plain-text response"` and for
  `"Salvaged plain-text response from model that made tool calls"`. Plain
  text is accepted for `user_message` and `motor_result` triggers, and after
  any tool call in the tick (the model did real work but skipped the JSON
  wrapper) — see `shouldAllowPlainText` and the salvage logic in
  `src/layers/cognition/agentic-loop.ts`. Other triggers require the JSON
  response format. If text still leaked, check the `model` field and whether
  the prompt is clear.
- **Poisoned history:** a bad response saved into conversation history gets
  copied by later turns. Check prior ASSISTANT messages in the conversation
  log. Conversation history lives in Postgres; inspect and recover it through
  the Postgres-backed conversation store, after backing up the database. Tick
  snapshots, bus offsets and inbound/outbound streams live in Valkey; inspect
  or recover those through their Valkey-backed stores, after backing up Valkey.
  Do not delete files under `data/` to recover durable state.
- **Truncated response:** `finishReason: "length"` — the model hit the token
  limit. The loop retries: a truncated user-message response with no tool
  calls forces a retry, and failures escalate to the smart model.
- **Container issues:** search logs for `component: "container-manager"`.
  `docker ps -a --filter label=com.lifemodel.component=motor-cortex` lists all
  Motor Cortex containers; stale ones are pruned on restart (older than 5
  minutes). Docker is required for agentic runs — without it they fail with
  "Docker required for Motor Cortex isolation".

## Restart guarantees

The Valkey streams and the committed tick snapshot are the core's durable
boundary. Local files do not define inbound replay.
Gateways append messages to `inbound`; the core reads them as signals. Inbound
messages remain owned by that stream and are never copied into the internal bus.
The bus snapshot stores a contiguous watermark and a per-entry ledger for
entries beyond it. Each ledger entry is owned by a persisted turn id, completed,
or failed with a retry count. A failed internal turn retries once in the same
running core; after its second failure its entries are completed with the
recorded failure and a warning. A turn id is fixed when the turn starts, saved in
the epoch-checked snapshot before any effect, and reused when its owned entries
replay; absorbing more triggers later does not change its effect keys. A tick
commit atomically stores this ledger with the inbound read and per-recipient
offsets, bounded recent-message-id dedup ring, pending inbound messages, and
outbox events. The same epoch-checked CAS records completed inbound ids in the
Valkey sorted set `inbound:completed`, trimming entries older than 25 hours.
Admission checks both this set and the ring; a conversation history row alone
does not prove completion and cannot suppress replay. An entry is completed only in the CAS that commits its outcome.
The watermark advances only over the contiguous completed prefix. The ledger
admits at most 100 entries beyond the watermark. When full, later signals wait
in the Valkey stream and are not admitted into the snapshot ledger until capacity
opens. Completed entries beyond a gap stay in the ledger and are skipped on
restart; owned and failed entries replay under their recorded turn id. Entries
leave the ledger only when the watermark passes them, and the stream is trimmed
only through that watermark after the snapshot CAS succeeds. The Valkey commit
rejects a stale generation by epoch. Postgres writes are fenced by the active
holder.

The outbound stream retains events until the Postgres apply offset passes them, except for an explicit 10,000-event / 30-day retention bound; events beyond that bound may be dropped and are logged with the actual trim count. The web channel is a pull channel with no delivery cursor. One Valkey Lua script deletes event-key deduplication entries in bounded batches before trimming rows, so a key-deletion failure leaves rows available for retry and cannot orphan keys. Events at or below the Postgres apply offset are removed, and event-key deduplication entries share the same retention horizon.

The outbox persists across tick boundaries. A CAS retires only the exact batch
it accepted; sends arriving while the CAS is in flight remain queued for a
later commit. A committed outbound event is the answer boundary. The Postgres
message-row consumer applies outbound events idempotently by event id; its
cursor advances after the row write. Deliberate silence is recorded by the
committed tick with no outbound event. Error-disposition and rejected turns
commit no partial sends; acknowledgements emitted before the failure are
withdrawn with the turn. Inbound failures are counted and retried once by a
fresh core (two failed attempts total). On the exhausted attempt only, one error
notice is committed as the input's outcome, with an effect key distinct from a
successful answer, and the input completes. An internal bus failure remains
failed with its retry count and recorded turn id until a later outcome commits.
Failed sends are not a core outcome: the gateway owns delivery and retry. The
web channel is a pull channel with no delivery cursor; the browser's resume
cursor is not a delivery record. With no channel registered, the core logs the
committed event once at info and advances its in-process delivery cursor; the
web availability is its Postgres row; the outbound event is not retained for future gateway delivery after the Postgres apply offset advances, except for the explicit 10,000-event / 30-day retention bound.

A rejected signal-normalization write fails the core closed without committing that tick; the bounded fatal stop exits non-zero, and restart replays every uncommitted durable input, including the rest of the drained batch. A persistent store failure remains unhealthy and requires store repair.

A hard stop or crash during a tick leaves the previous snapshot authoritative.
The fresh core reads from its committed offsets and processes uncommitted
messages again. After a commit, those messages are past the committed offsets
and do not replay. The dedup ring is bounded; it is not an unbounded history.
A graceful stop commits a drained turn through a bounded final epoch-checked
snapshot before durable writes close. If it cannot commit by the stop deadline,
its inputs remain uncommitted and replay. The same applies to an in-flight turn
killed by a hard stop. Queued non-inbound work not represented by a durable
stream or the committed snapshot can be regenerated or recovered according to
its own durable store.

Remaining windows are explicit: a Postgres message row may be applied before
its cursor advances, so restart can reapply it (the event-id key makes that
idempotent). A gateway may deliver an answer before its delivery cursor
advances, so restart can deliver it again (delivery is at-least-once). An
inbound gateway append that never reaches Valkey is outside the core's durable
boundary. The Valkey epoch fence protects snapshot commits; the Postgres active
holder fence protects Postgres writes. Neither makes a cross-store transaction.

## Design Principles

**We are building a digital human, not a chatbot.**

1. **Energy Conservation** — Layered processing: autonomic first (free),
   conscious thought only when needed (expensive). (`src/core/energy.ts`,
   layers in `src/layers/`)
2. **Emergence Over Polling** — State accumulates → pressure crosses a
   threshold → action emerges. No periodic polling. (the wake threshold in
   `src/layers/aggregation/threshold-engine.ts`)
3. **Signals, Not Events** — Everything is a Signal. One unified model for all
   data flow. (`src/types/signal.ts`)
4. **Plugin Isolation** — Core NEVER imports plugin types. Plugins use ONLY
   `PluginPrimitives` API. No direct calls between plugins.
   Known exception, being fixed: `lifemodel-faw`.
5. **No Backward Compatibility** — Remove dead code. Clean breaks over
   compatibility shims.
6. **No Attribute Prefix Routing** — Never encode behavior in attribute names
   (e.g., `interest_crypto`). Create dedicated tools with explicit fields —
   `core.setInterest` replaced `interest_<topic>`
   (`src/layers/cognition/tools/core/interest.ts`). ID prefixes (`mem_`,
   `core.*`) are fine — they identify types, not encode behavior.
7. **Restart-Safe Scheduling** — Schedules persist in storage and are reloaded
   on restart; a due schedule fires as soon as it is seen
   (`src/core/scheduler-primitive.ts` checks `nextFireAt <= now`).
8. **Long-Term Architecture Over Quick Wins** — Build proper, standards-aligned
   systems that can be enhanced later. Adopt open standards and extend via
   separate policy layers rather than forking formats.

## Lessons Learned

These are requirements, not suggestions.

1. **Read-Write Symmetry in Plugin APIs** — If plugins can READ, they need
   WRITE too. `getUserProperty` without `setUserProperty` caused silent data
   loss. (Both are in `PluginPrimitives` today.)
2. **Atomic Units in Conversation History** — Tool calls and results must
   never be separated. Every `tool` message's `tool_call_id` must match a
   preceding `tool_calls[].id`.
3. **Deterministic Errors Need Prevention, Not Recovery** — Same input → same
   error means fix the root cause. Don't retry what will always fail.
4. **State has an explicit durable home** — Tick snapshots and bus streams live in Valkey; conversations, memory, soul, registries, plugin settings, schedules and configuration live in Postgres. `DATA_PATH` is not a state store. Do not add a file-backed state path or compatibility shim.
5. **Timestamp Filtering Uses Content Timestamps** —
   `lastFetchedAt = max(item.publishedAt)`, NOT `new Date()`. Using fetch time
   skips items published between content time and fetch time.
   (`getMaxPublishedAt` in `src/plugins/news/index.ts`)
6. **Stop Conditions Handle Gaps** — Stop on exact match with the last seen
   id, never on `<=`. IDs may have gaps from deletions.
   (`getMaxPublishedAt` in `src/plugins/news/index.ts`)
7. **Secrets Are Never Printed Whole** — Never print an environment, a
   Kubernetes Secret or a settings dump to find one value: a filter by a
   loose word catches unrelated secrets. Print names only, or test for
   presence (`printenv | cut -d= -f1`, `kubectl get secret -o
   jsonpath='{.data}' | jq keys`).

## Practices

Written answers to repeated failures, one file each under `docs/practices/`
(about ten active at most):

- PRA-001 — an interface is accepted on screenshots of the deployed build in
  real Chromium and Firefox, compared with each claim of its feature document
  (`docs/practices/PRA-001-interface-accepted-on-screen.md`).
