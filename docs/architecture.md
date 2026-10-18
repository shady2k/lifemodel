# Architecture

## 3-Layer Brain

```
┌─────────────────────────────────────────────────────────────────┐
│  ┌─────────────┐    Sensory Organs (Channels)                  │
│  │  Inbound    │────┐                                          │
│  └─────────────┘    ▼                                          │
│              ┌──────────────┐                                  │
│              │   SIGNALS    │                                  │
│              └──────┬───────┘                                  │
│  ┌──────────────────▼──────────────────┐                       │
│  │         AUTONOMIC LAYER             │  Zero LLM cost        │
│  │  • Neurons monitor state            │  Like: brain stem     │
│  │  • Weber-Fechner change detection   │                       │
│  └──────────────────┬──────────────────┘                       │
│  ┌──────────────────▼──────────────────┐                       │
│  │        AGGREGATION LAYER            │  Zero LLM cost        │
│  │  • Buckets signals, detects patterns│  Like: thalamus       │
│  │  • Decides: wake COGNITION?         │                       │
│  │  • AckRegistry: habituation/deferral│                       │
│  └──────────────────┬──────────────────┘                       │
│                     │ (only if threshold crossed)              │
│  ┌──────────────────▼──────────────────┐                       │
│  │         COGNITION LAYER             │  LLM (fast + smart)   │
│  │  • Fast model first (System 1)      │                       │
│  │  • Smart retry if uncertain <0.6    │  Like: System 1+2     │
│  │  • Deep reasoning when needed       │                       │
│  └─────────────────────────────────────┘                       │
└─────────────────────────────────────────────────────────────────┘
```

Most ticks: only AUTONOMIC and AGGREGATION run. COGNITION wakes for user messages or threshold crossings. Smart model used only on retry (low confidence + safe to retry).

### Motor Cortex (Runtime Service)

Motor Cortex is **not a brain layer** — it's a runtime service invoked by Cognition via `core.act`. It runs a separate agentic LLM loop with its own tools (code sandbox, filesystem, shell) and conversation context. Results flow back via `motor_result` signals through the standard pipeline.

- **Oneshot mode**: Synchronous JS execution in sandbox (5s timeout)
- **Agentic mode**: Async sub-agent loop (max 20 iterations), returns runId immediately
- **Mutex**: Only one agentic run at a time (including `awaiting_input`)
- **Energy gated**: 0.05 (oneshot), 0.15 (agentic)
- **Docker isolation**: Agentic runs execute inside per-run Docker containers with `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, resource limits (512MB, 1 CPU, 64 PIDs by default). Network is off by default (`--network none`); a skill run that declares allowed domains goes through `--network bridge` with an egress proxy. Docker is required — there is no direct-execution fallback.
- **Dependency pre-installation**: Skills declare npm/pip/apt packages in `policy.json`. A prep container installs them (cache-first, content-addressed Docker named volumes) and mounts them read-only into the runtime container via `NODE_PATH`/`PYTHONPATH`/`PATH`+`LD_LIBRARY_PATH`.
- **IPC**: Host communicates with container via length-prefixed JSON on stdin/stdout (long-lived tool-server process).

See [docs/features/motor-cortex/](features/motor-cortex/) for full design.

---

## CoreLoop (The Heartbeat)

Fixed 1-second tick drives all processing:

1. Collect signals from channels (sensory input)
2. Update thought pressure (from memory)
3. Update desire pressure (from active desires in memory)
4. Check overdue commitments (emit commitment:due / commitment:overdue signals)
5. Check overdue predictions (emit perspective:prediction_due signals)
6. AUTONOMIC layer: neurons emit internal signals
7. AGGREGATION layer: collect, aggregate, decide wake threshold
8. COGNITION layer: (if woken) process with LLM
9. Apply intents returned by all layers

### Restart and stop guarantees

The core has no file-based inbound log and no channel-specific replay. A
gateway appends messages to the Valkey `inbound` stream. The core consumes
these messages through the ordinary signal pipeline.

Each tick commits one Valkey snapshot atomically under the current epoch. It
contains the agent/core state, the internal bus watermark and a per-entry
ledger beyond it, inbound stream read offset, per-recipient offsets, bounded
recent-message-id dedup ring, pending inbound messages and outbound snapshot
outbox. Inbound entries have one queue owner: they are not copied to the
internal bus. Each bus entry is owned by a persisted turn id, completed, or
failed with a retry count. The turn id is fixed when the turn starts and is
reused on replay even if replay groups in more triggers. Entries complete only
in the CAS that commits their outcome. The watermark advances only across a
contiguous completed prefix; completed entries beyond a gap are skipped on
restart, while owned and failed entries replay under their saved turn id. The
ledger admits at most 100 entries beyond the watermark. Later signals remain in
the Valkey stream until capacity opens; they do not enter the snapshot ledger.
Entries are removed as the watermark passes them, and stream trimming occurs
only through that watermark after a successful CAS. The Valkey epoch check rejects commits from a stale core. Postgres writes
use the active-holder fence.

A tick killed before commit leaves the previous snapshot and offsets
unchanged. On restart, inbound messages not covered by that snapshot are
processed again. A successful commit advances the offsets together with the
state and outbox, so a committed answer does not replay. The dedup ring is
bounded; no unbounded deduplication promise is made.

A committed outbound event is an answer. Pending outbox events survive tick
boundaries, and each CAS retires only the exact batch it accepted. A graceful
stop commits a drained answer through a bounded final CAS before writes close;
if that CAS misses the stop deadline, its triggers remain eligible for replay.
The Postgres consumer writes its message row with the event id as an idempotency
key, then advances its cursor.
If a crash happens between those operations, the row is applied again safely.
Deliberate silence is represented by a committed tick with no outbound event.
An error-disposition or rejected turn commits no partial sends, including
immediate acknowledgements. Inbound failures are retried once by the next core
(two failed attempts total). Only the final exhausted attempt commits one error
notice as the input outcome; its effect key is distinct from a successful
answer, and the input then completes. Distinct turns derive outbound
idempotency keys from their persisted turn identity and effect ordinal.
The web channel is a pull channel with no delivery cursor. Outbound events are
retained until the Postgres apply offset passes them, subject to the 10,000-event
and 30-day retention bounds. Delivery belongs to a future channel whose delivery
can fail. If there is no channel registered, this core reports the event once at
info and advances its own delivery cursor. Web availability is its Postgres
conversation row. An outbound event is not retained for future gateway delivery
after the Postgres apply offset advances, except for the explicit 10,000-event /
30-day retention bound.

Outbound retention deletes event-key deduplication entries in bounded batches
before trimming stream rows in one Valkey Lua script. The warning count reflects
actual dropped rows; if key deletion fails, the rows remain available for retry
so the cleanup cannot orphan keys.

Delivery is at-least-once: a gateway can deliver an answer and crash before
advancing its cursor, causing a repeat. An append that never reaches Valkey is
outside the core's boundary. Valkey snapshot commits and Postgres writes have
separate epoch/active-holder fences; there is no cross-store transaction.
Other queued work not represented in the committed snapshot or its own durable
store can be lost on process death. A graceful stop may drain a tick within its
configured deadline; a hard stop during a tick does not drain or commit it.

## COGNITION Agentic Loop

Uses native OpenAI tool calling with **Codex-style natural termination**:
- Tools registered with `strict: true`
- Natural termination: LLM stops calling tools when done (no `core.final` required)
- Smart escalation: Fast model can request deeper reasoning via `core.escalate`
- Smart retry: Low confidence and no side-effects → retry with expensive model
- Conversation status: JSON schema `{"response": "...", "status": "..."}` controls follow-up timing
- Proactive deferral: `core.defer` allows LLM to postpone proactive contact

```
Request: messages + tools (tool_choice: "auto")
    ↓
Response: { tool_calls: [...], content: "thinking..." }
    ↓
Execute tools → add role: "tool" messages → drain pending user messages
    ↓
No tool calls = natural completion
    ├─ pending user messages? → deliver response, absorb messages, continue loop
    └─ no pending messages  → return intents
    ↓
Loop continues until LLM stops calling tools
```

### Module Structure

The agentic loop is decomposed into focused modules:

```
src/layers/cognition/
  agentic-loop.ts             # Orchestration (run + dependency wiring, ~280 lines)
  agentic-loop-types.ts       # All shared types/interfaces (no runtime deps)
  response-parser.ts          # parseResponseContent — JSON schema + plain text (pure)
  intent-compiler.ts          # ToolResult→Intent, batched thoughts, confidence (pure)
  tool-executor.ts            # Tool call loop + execution (primary LoopState mutator)
  loop-orchestrator.ts        # buildRequest, filterToolsForContext, proactive budget

  prompts/
    system-prompt.ts           # Identity, rules, time awareness (runtime-dynamic)
    trigger-prompt.ts          # Assembles context sections + trigger-specific section
    context-sections.ts        # User profile, thoughts, soul, behavioral rules, commitments, desires, perspectives, available skills, runtime snapshot
    trigger-sections.ts        # Proactive contact, plugin events (commitments, predictions, self-scheduled), thought, reaction
    runtime-snapshot.ts        # State query detection, level descriptions, scope

  messages/
    history-builder.ts         # buildInitialMessages + conversation history injection
    retry-builder.ts           # addPreviousAttemptMessages (smart retry context)
    tool-call-validators.ts    # Orphaned tool result filtering (safety net)
```

Key design decisions:
- **`agentic-loop.ts` re-exports all types** from `agentic-loop-types.ts` for backward compatibility
- **`tool-executor.ts`** returns a `ToolExecutionOutcome` discriminated union (continue/escalate/defer) to preserve loop control flow
- **`PromptBuilders` interface** enables dependency inversion — messages/ doesn't depend on prompts/
- **Pure modules** (`response-parser`, `intent-compiler`, all prompts/) have read-only access to state
- **System prompt is runtime-dynamic** (timestamp, timezone, useSmart) — never cached

---

## Project Structure

```
src/
├── core/           # CoreLoop, Agent, energy, event-bus
├── layers/         # autonomic/, aggregation/, cognition/
├── runtime/        # Motor Cortex, sandbox, shell, container, skills
│   └── skills/     # Agent Skills standard: loader, types, policy.json, index.json
├── llm/            # LLM provider interface, tool schema conversion
├── plugins/        # Modular extensions
├── channels/       # Channel contracts; external gateways use streams
├── ports/          # External service adapters
├── storage/        # Postgres persistence, pgvector + JSON graph memory, conversations
├── types/          # Signal, Intent, Cognition, Commitment, Desire, Perspective types
├── models/         # UserModel for preferences
├── config/         # Configuration loading from Postgres and the model endpoint's shape
└── settings/       # lifemodel's own web settings (the root host), and the restart code
```

## Platform model gateway

The loader package also builds `loader/src/model-gateway.ts` as a separate
process entry point (`node /opt/lifemodel/loader/dist/model-gateway.js` in the
loader image). It does not start the loader or read its bootstrap state.
`LIFEMODEL_OPENBAO_ADDRESS` is required; the projected service-account JWT is
read from the standard Kubernetes token path. The gateway uses the
`model-gateway` Bao role and the shared in-memory slot cache.

Its API listener, 8080, exposes only `POST /v1/chat/completions` and
`GET /v1/models`. Its status listener, 8081, exposes only `GET /status`.
Upstream credentials never cross the return boundary: the gateway owns error
bodies and return headers, buffers and inspects JSON, and parses SSE frames
with per-choice/per-field key-prefix withholding. Each request has at most
one primary and one reserve attempt, never switches after output starts, and
aborts model transport on disconnect or deadline. The shared loader validator
resolves and pins each destination. See [ADR-013](adr/013-model-gateway.md).
Step A deploys it as `model-gateway` in `lifemodel-system`: the loader image
with the command overridden to `/opt/lifemodel/loader/dist/model-gateway.js`,
its own ServiceAccount and no loader volume, custody Secret or PKI, a read-only
root filesystem, and readiness on `/status` alone, so missing slots before
onboarding never hold the step. The release flow pins step A to the same pushed
loader digest as A0. Its Service publishes 8080 (the API) and 8081 (`/status`);
the core is admitted to 8080 only, the web module and the loader to 8081 only,
and the core's own model egress is the gateway's 8080 — DNS, Postgres and Valkey
stay as they were. Its egress is the loader's model exception plus DNS and
OpenBao; the loader's API-server and Gitea routes are the loader's alone,
because the namespace default deny is a separate object from the loader's
permits. The loader's bootstrap policy phase provisions the gateway's Bao
identity beside `loader-model` before the root token is retired: policy `read`
on `lifemodel/data/model/*` only and Kubernetes-auth role `model-gateway` bound
to the gateway's ServiceAccount, verified as that policy would be held.

The core's endpoint comes from `LIFEMODEL_MODEL_BASE_URL`, which the platform
sets and lifemodel's settings interface cannot edit; it overrides
`core.settings` and carries no key. The core sends no `Authorization` header,
its role models unset in settings default to `default`, and its provider makes
one HTTP attempt per completion whose timeout aborts the request through an
`AbortSignal` — the gateway's primary/reserve pair is the whole transport
failover budget. See [ADR-013](adr/013-model-gateway.md).

## Platform deployment and loader first start

The platform artifact is a signed OCI source applied by Flux. Its root
Kustomization applies A0 and step A in order: A0 creates and starts the loader
and Gitea namespace, while A depends on A0 and creates OpenBao, Gitea and the
application namespaces. A0 does not create any namespace owned by A. The
loader's platform mode stores restart-safe phase records in a platform-created
Secret, initializes OpenBao and retains its unseal key, then verifies
Kubernetes-auth handoff before revoking and removing the root token. It seeds
protected `main` and `deploy` branches in Gitea from the release bundle, creates
a read-only source account and namespace-local source credentials, then creates
the two application Kustomizations with their restricted appliers. Admission
policies constrain loader-managed Secrets and application Kustomizations.
The Gitea admin Secret stays while its chart reference exists. See
[ADR-010](adr/010-container-generations.md) for the platform decision and
[the loader guide](features/instance/loader.md) for the phase details.
