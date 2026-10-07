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
  queue, intent application, metrics, tracing
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
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint over `src/` (`lint:fix` to auto-fix) |
| `npm run format` / `format:check` | Prettier over `src/**/*.ts` |
| `npm run connect` | connect this clone: git hooks, backlog import, gate check |
| `npm run backlog` | the backlog gate (`npm run backlog:json` for JSON output) |
| `npm run present` | the present-documents check |
| `npm run ready` | open leaves ready to claim |
| `npm run browser:auth` | browser authentication (`cli/browser-auth.ts`) |

`dev`, `build`, `test`, `typecheck` and `lint` need `node_modules` (`npm ci`).
The backlog gate and the present check need only `node`. Docker is required for
Motor Cortex agentic runs.

## Testing

- All tests live in `tests/` (unit and integration, plus `fixtures/` and
  `helpers/`). Never create test files inside `src/`.
- Run the suite with `npm run test`.
- Run one file: `npx vitest run tests/unit/energy-management.test.ts`
  (any path under `tests/`).

## Data & logs

Created at runtime relative to the working directory; the root is `data/`
(override with `DATA_PATH`; defaults live in `src/config/config-schema.ts`).

- `data/logs/agent-<timestamp>.log` — pino logs (pino-pretty formatted):
  system events, LLM requests/responses, tool calls, errors; the newest 10
  non-empty files are kept (`src/core/logger.ts`)
- `data/logs/conversation-<timestamp>.log` — human-readable: the exact
  messages to and from the LLM with role markers; the file comes from
  `src/core/logger.ts`, the entries from `src/llm/provider.ts`
- `data/state/` — persisted state: JSON state files (written through
  DeferredStorage), conversations, `data/state/memory/` (vector store),
  soul, graph; next to it `data/skills/`, `data/motor-runs/`, `data/models/`,
  `data/plugins/`
- `data/config/` — local config files read by `src/config/config-loader.ts`

## Debugging unexpected agent output

Verify each step against the logger code (`src/core/logger.ts`,
`src/llm/provider.ts`, `src/layers/cognition/agentic-loop.ts`) — the format
below is what that code writes today.

1. Find the newest logs: `ls -t data/logs/agent-*.log | head -3`
2. Find the tick: search the conversation log for the bad output text and note
   the `[traceId:spanId]` prefix. Spans are `tick_<n>` (a CoreLoop tick) or a
   signal/intent id.
3. Trace the chain: `grep "tick_NNNNN" data/logs/agent-*.log` shows trigger →
   LLM request → LLM response → post-processing.

Conversation log format (written by `src/llm/provider.ts`):

```
[HH:MM:SS.mmm] [traceId:spanId] ► [N] ROLE:
  message content
────────────────────────────────────────────
← RESPONSE [durationMs, tokens tokens, finish_reason] gen:<generationId>
  LLM response
════════════════════════════════════════════
```

Key fields in the agent log:

| Field | What it tells you |
| --- | --- |
| `traceId` / `spanId` | one processing chain / one tick within it |
| `triggerType` | what caused the agent to act (`user_message`, `contact_urge`, `thought`, …) |
| `model` / `provider` | which model produced the output; the role (fast/smart/motor) routes it |
| `generationId` | OpenRouter generation id for provider-side debugging |
| `finishReason` | `stop` normal, `tool_calls` a tool round, `length` truncated, `error` provider failure |
| `response` / `contentPreview` | full raw LLM output / first 200 chars of a request message |

Common issues:

- **Model echoing instructions:** search the agent log for
  `"Accepted plain-text response"`. Plain text is accepted only for
  `user_message` and `motor_result` triggers (`shouldAllowPlainText` in
  `src/layers/cognition/agentic-loop.ts`); other triggers require the JSON
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
5. **Timestamp Filtering Uses Content Timestamps** —
   `lastFetchedAt = max(item.publishedAt)`, NOT `new Date()`. Using fetch time
   skips items published between content time and fetch time.
   (`getMaxPublishedAt` in `src/plugins/news/index.ts`)
6. **Stop Conditions Handle Gaps** — Stop on exact match with the last seen
   id, never on `<=`. IDs may have gaps from deletions.
   (`fetchTelegramChannelUntil` in `src/plugins/news/fetchers/telegram.ts`)
