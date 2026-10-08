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

- `src/index.ts` — entry point: builds the container, starts Telegram and CoreLoop
- `src/core/` — the heart: CoreLoop tick, Agent, energy model, scheduler,
  plugin loader and discovery, container (dependency wiring), event bus and
  queue, intent application, metrics, tracing, the bounded shutdown-drain
  sequence (one overall stop deadline; intake stop first, sends of the drained
  turn awaited, channels released after, storage flushed last) with its hard
  exit at the deadline (`hard-exit.ts`), and the durable
  inbound log (`inbound-log.ts`), which persists inbound user messages on
  receipt, removes an entry once its turn reached a recorded outcome
  (answered, deliberately silent, failed send, failed turn - a failed outcome
  is never retried), replays the entries whose turn recorded none at start
  and dedups by Telegram update_id
- `src/layers/` — the brain: `autonomic/` (neurons, filters, zero LLM cost),
  `aggregation/` (buckets, patterns, the wake threshold), `cognition/` (the
  agentic LLM loop with its prompts, message builders and core.* tools, plus
  the `soul/` inner-life modules)
- `src/runtime/` — Motor Cortex (the sandboxed agentic act loop), Docker
  container management, sandbox and shell runners, the Agent Skills loader
  (`skills/`), built-in skills (`builtin-skills/`), locks, credentials
- `src/channels/` — sensory organs; the Telegram channel lives in
  `src/plugins/channels/telegram.ts`
- `src/plugins/` — plugins proper (alertness, calories, contact-pressure,
  desire-pressure, energy, news, reminder, social-debt, thoughts, time-neuron,
  web-fetch, web-search) and shared helper libraries (`providers/`,
  `web-shared/`)
- `src/llm/` — the provider interface, the fast/smart/motor MultiProvider
  routing, tool-schema conversion, conversation-log writing
- `src/storage/` — persistence: JSONStorage (atomic writes) behind
  DeferredStorage (batched flush), conversations, the dual-layer memory
  (LanceDB vector store + JSON graph store), the soul
- `src/ports/` — the narrow interfaces plugins see (LLM, storage, scheduler, …)
- `src/types/` — Signal, Intent, Plugin, Cognition and friends: the shared
  vocabulary
- `src/models/`, `src/config/`, `src/utils/` — the user model, config
  loading/schema, small utilities
- `tests/` — unit and integration tests, fixtures, helpers
- `docs/` — architecture, concepts, features, plugins, ADRs, charters
- `cli/browser-auth.ts` — browser authentication helper
- `.backlog/` — the backlog gate and its rules; `docs/backlog-integration.md`
  describes the workflow

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | run from source with tsx (`src/index.ts`) |
| `npm run build` | compile to `dist/` and copy `src/runtime/builtin-skills` |
| `npm start` | run the build (`dist/index.js`) |
| `npm run test` | run the whole test suite (vitest) |
| `npm run test:watch` | vitest in watch mode |
| `npm run check` | every product check in one command — typecheck, the loader's typecheck, lint, the format check, then `vitest run --maxWorkers=2`, stopping at the first failure; the exact command CI's product job runs |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint over `src/` and `loader/` (`lint:fix` to auto-fix) |
| `npm run format` / `format:check` | Prettier over `src/**/*.ts` and `loader/**/*.ts` |
| `npm run connect` | connect this clone: git hooks, backlog import, gate check |
| `npm run backlog` | the backlog gate (`npm run backlog:json` for JSON output) |
| `npm run present` | the present-documents check |
| `npm run ready` | open leaves ready to claim |
| `npm run browser:auth` | browser authentication (`cli/browser-auth.ts`) |

`dev`, `build`, `test`, `check`, `typecheck` and `lint` need `node_modules`
(`npm ci`, on node 24 to match CI's own install).
The backlog gate and the present check need only `node`. Docker is required for
Motor Cortex agentic runs.

## Testing

- All tests live in `tests/` (unit and integration, plus `fixtures/` and
  `helpers/`). Never create test files inside `src/`.
- Run the suite with `npm run test`.
- `npm run check` is the one command with CI's verdict — on node 24 with the
  dependencies of the committed lockfile: typecheck (`src/` and `loader/`),
  lint, the format check and the suite (at most 2 workers), stopping at the
  first failure. CI's
  `ci-product` job runs exactly it, for a change whose paths include product
  code. A green run on another node version, or with other installed
  dependencies, is not that verdict; CI also fails at its own `npm ci` when
  `package.json` and `package-lock.json` disagree, before the checks start.
- Run one file: `npx vitest run tests/unit/energy-management.test.ts`
  (any path under `tests/`).
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
`DATA_PATH` moves the state, logs, plugins and models roots — it does not
move the config file: startup reads `data/config/agent.json` before applying
`DATA_PATH` (`src/core/container.ts`, `src/config/config-loader.ts`).

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
- `data/state/` — persisted state: JSON state files (written through
  DeferredStorage), conversations, `data/state/memory/` (vector store),
  soul, graph, the durable inbound log (`core/inbound_log.json`) and its backup/corrupted siblings (written through DeferredStorage); next to it `data/skills/`, `data/motor-runs/`, `data/models/`,
  `data/plugins/`. These logs and `data/state/` hold personal messages and
  tool content: do not paste them outside this machine, and back up
  `data/state/` before cleaning conversation history
- `data/config/` — the config file read by `src/config/config-loader.ts`

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
  log; fix by cleaning the conversation files under `data/state/`.
- **Truncated response:** `finishReason: "length"` — the model hit the token
  limit. The loop retries: a truncated user-message response with no tool
  calls forces a retry, and failures escalate to the smart model.
- **Container issues:** search logs for `component: "container-manager"`.
  `docker ps -a --filter label=com.lifemodel.component=motor-cortex` lists all
  Motor Cortex containers; stale ones are pruned on restart (older than 5
  minutes). Docker is required for agentic runs — without it they fail with
  "Docker required for Motor Cortex isolation".

## Restart guarantees

A restart is never allowed to lose a turn or to answer a message twice by
accident. The durable inbound log (`src/core/inbound-log.ts`) is the boundary
that makes the distinction, and it is deliberately simple: the entry is
written and flushed on receipt, and it LEAVES the log when its turn recorded
an OUTCOME - answered, deliberately silent (`core.defer` / explicit
no-reply), failed send, failed turn (`error` disposition). The four are
mutually exclusive: an `error` disposition wins, otherwise the turn's FINAL
send decides answered against failed send (an acknowledgement through
`core.say` counts only when the turn ends with no further message). A failed
outcome is reported at warn with the recipient and the reason and is NEVER
retried. Only a message whose turn recorded no outcome is replayed, once, at
the next start.

The stop (`shutdownSequence` in `src/core/container.ts`) is BOUNDED and BEST
EFFORT, under ONE deadline (`CoreLoopConfig.shutdownDrainTimeoutMs`, default
90 s): intake stops first, the turn in flight and the sends it scheduled are
drained, state and registries persist, the channels are released, the loop is
closed for durable writes and storage flushes last (so a send that settles
behind the flush keeps its message in the log for a single replay instead of
writing where nothing would flush it). The stop persists NOTHING for the next
run: what is queued but unprocessed is dropped. The guarantee covers the TURN
IN FLIGHT and INBOUND TELEGRAM MESSAGES (the log above); everything else that
was only queued in memory is LOST on a restart, as before this feature - a
schedule firing (one-shot or recurring), a Motor Cortex result, a Telegram
reaction, an internal signal. Reminders and Motor Cortex results become tasks
with their own durable record and outcome later (`lifemodel-ten`); the
pressures and neurons the ticks produce are simply recomputed. `src/index.ts` arms a hard
exit at the same deadline (`src/core/hard-exit.ts`, REFERENCED until it is
disarmed - an unref'd timer lets a hung process leave with code 0 before the
deadline): whatever still hangs there - a stalled intake stop, a stalled tick,
a hung send, a stalled flush - is abandoned and the process leaves with a
non-zero code and one error line naming the step and the loop's live work it
never finished.

- **Graceful restart (SIGINT/SIGTERM) - strict, while the stop fits its
  deadline.** When the sequence completes: no message is lost and none is
  answered twice - an entry removed by a recorded outcome cannot replay, an
  entry without one replays exactly once at the next start. A stop that hits
  the deadline is best effort like a crash: the steps after it did not run.
- **Crash (kill -9, OOM, a broken generation) - best effort.** Messages whose
  turn recorded no outcome replay once at start. Signals that were only queued
  in memory are lost, as on main.

Known crash windows (named, not fixed; one debt item): an update lost between
receipt and the emit-time flush; an answer delivered while its removal is not
yet on disk (or any outcome recorded only in memory at the crash) - the
message may be answered twice; a send in flight at the crash - the message
replays once and the user may get the late send and the replay; a failed send
or failed turn removes the message for good by decision. The same windows
cover the stop that hits its deadline. `docs/architecture.md`
carries the same list in context.

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
4. **Unified Storage Path** — All data through DeferredStorage → JSONStorage
   (atomic writes). Direct file I/O causes race conditions.
   Known exception, being decided: `lifemodel-ww8`.
5. **Timestamp Filtering Uses Content Timestamps** —
   `lastFetchedAt = max(item.publishedAt)`, NOT `new Date()`. Using fetch time
   skips items published between content time and fetch time.
   (`getMaxPublishedAt` in `src/plugins/news/index.ts`)
6. **Stop Conditions Handle Gaps** — Stop on exact match with the last seen
   id, never on `<=`. IDs may have gaps from deletions.
   (`fetchTelegramChannelUntil` in `src/plugins/news/fetchers/telegram.ts`)
