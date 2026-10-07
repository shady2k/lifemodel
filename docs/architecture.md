# Architecture

## 3-Layer Brain

```
┌─────────────────────────────────────────────────────────────────┐
│  ┌─────────────┐    Sensory Organs (Channels)                  │
│  │  Telegram   │────┐                                          │
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

### Graceful stop (SIGINT/SIGTERM)

One fixed order, `shutdownSequence` in `src/core/container.ts`:

1. Channel intake stops first — no new updates are accepted from here on.
   Updates already accepted sit in `pendingSignals`, not in the channel.
   Sending keeps working: the answer the drained turn computes is delivered.
2. `coreLoop.stop()` waits for the COGNITION turn in flight up to
   `coreLoop.shutdownDrainTimeoutMs` (default 90 s; set through the
   `coreLoop` field of `AppConfig` when the container is created). A turn
   that finishes within the deadline is applied exactly once. A turn that
   overruns has its trigger signal requeued.
3. Signals accepted but never processed (`pendingSignals`, plus a requeued
   trigger) are written to the pending-signal journal
   (`data/state/core/pending_signals.json`) through DeferredStorage.
4. State, recipient and ack registries persist.
5. Channels stop fully (clients released; after this a send refuses).
6. DeferredStorage flushes last — nothing writes after it.

On start, `createContainerAsync` restores the journal into `pendingSignals`
and clears it, so the same signal is processed exactly once. A corrupt or
unreadable journal file fails startup loudly with the file path — it is never
treated as empty. A crash later in the run could still restore the same
signals again: durable inbox / update_id dedup closes that
(lifemodel-ctc.2.1).

---

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
├── channels/       # Sensory organs (Telegram, etc.)
├── ports/          # External service adapters
├── storage/        # Persistence, memory (LanceDB VectorStore + GraphStore), conversations
├── types/          # Signal, Intent, Cognition, Commitment, Desire, Perspective types
├── models/         # UserModel for preferences
└── config/         # Configuration loading
```
