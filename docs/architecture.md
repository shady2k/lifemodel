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

One fixed order, `shutdownSequence` in `src/core/container.ts`, under ONE
overall deadline (default 90 s from `CoreLoopConfig.shutdownDrainTimeoutMs`,
settable through the `coreLoop` field of `AppConfig`; the container starts it
at the shutdown and `coreLoop.stop()` bounds every wait below by it — past the
deadline the stop continues and what is left is journaled):

1. Channel intake stops first — no new updates are accepted from here on.
   Updates already accepted sit in `pendingSignals`, not in the channel.
   Sending keeps working (`stopIntake` only stops polling).
2. `coreLoop.stop()` waits, each bounded by the deadline: the in-flight tick,
   the scheduler callback, the COGNITION turn in flight, and the sends that
   turn scheduled. A turn that finishes within the deadline is applied
   exactly once and its answer is DELIVERED before the channels are released
   (in-flight sends are tracked and awaited; a failed send is logged, never
   silently dropped). A turn that overruns has EVERY signal it owns requeued:
   all its trigger signals plus the user messages it absorbed mid-loop.
3. Signals accepted but never processed (the queue, a cut-loose tick's taken
   batch, and the requeued turn signals) are written to the pending-signal
   journal (`data/state/core/pending_signals.json`) through DeferredStorage.
4. State, recipient and ack registries persist.
5. Channels stop fully (clients released; after this a send refuses).
6. DeferredStorage flushes last — nothing writes after it.

On start, `createContainerAsync` restores the journal into `pendingSignals`
and clears it, so a graceful restart processes the same signal exactly once.
A corrupt or unreadable journal file fails startup loudly with the file path
and the original error as `cause` — it is never treated as empty.
`container.shutdown` is idempotent: every later caller gets the first call's
promise, so no second run can journal an empty queue over the first one.

### Durable inbound log (lifemodel-ctc.2.1)

Inbound user messages are durable beyond the graceful stop. The log lives in
core (`src/core/inbound-log.ts`, `data/state/core/inbound_log.json` through
the unified storage path); channels only emit signals through their awaited
callback:

1. On receipt, the signal is appended to the log and FLUSHED at once; only
   then is it queued. The entry carries the ROUTING data (channel,
   destination): a first message of a new chat can outlive the recipient
   registry's debounced save, and replay re-registers the route from the
   entry before anything is queued. A failed flush rolls the append back in
   memory and the error propagates, so the update is not acknowledged as
   handled. `stopIntake` gives in-flight intake handlers a bounded moment so
   their emit reaches the log before the stop proceeds.

   Dedup: a duplicate Telegram `update_id` is dropped instead of queued. The
   index is the exact keys of the live entries plus a bounded ring of recent
   keys (default `maxRecentKeys` = 1000) - NO numeric watermark, because
   Telegram may pick a random smaller update_id again after a week of
   silence. THE CONTRACT IS BOUNDED (coordinator decision, comment 49): the
   ring is the whole dedup horizon, so an `update_id` that fell out of it
   (more than 1000 later admissions, or a compaction) is no longer recognised
   and a redelivery of it can be accepted again. That is deliberate: Telegram
   re-delivers only unconfirmed updates and keeps them for at most 24 h, and a
   personal agent does not receive 1000 messages in 24 h. What keeps an
   ACCEPTED message from being replayed (and so answered twice) is the
   per-recipient offset, not the ring. No unbounded dedup is promised.
2. The outcome rule (owner decision, comment 54). The consumer offset is PER
   RECIPIENT. A cognition turn owns ONLY the entries of the recipient it
   answers (its first trigger - real cognition routes everything through
   `triggerSignals[0]`) plus the messages it absorbed mid-loop for that
   recipient; bundled user messages of OTHER recipients are requeued at the
   wake for their own turns and are never removed by this one. An entry
   LEAVES the log when its turn reached a recorded OUTCOME. The four are
   MUTUALLY EXCLUSIVE, and they are decided only once the turn resolved, every
   send of it (an acknowledgement through `core.say` included) settled, and
   the sends its own result produces have really started:

   - answered: the turn's FINAL send (the one its own result applies) reached
     the chat, or was skipped as a verbatim repeat of the last assistant
     message. A turn that ends with no final send counts as answered when the
     acknowledgement it did send reached the chat (an empty final response
     after `core.say` is a valid answer).
   - deliberately silent: no send is involved - `core.defer` or an explicit
     no-reply/noAction decision of the agent.
   - failed send: the turn produced an answer but its FINAL send did not reach
     the chat (no registry, route or channel, a refusal, an exception). An
     acknowledgement that landed does not turn this into `answered`.
   - failed turn: an `error` disposition (provider error, malformed output,
     exhausted retries, forced refusal), whether or not a message went out.

   An `error` disposition wins over the send outcome; without it the FINAL
   send decides between answered and failed send. A FAILED outcome is never
   retried: it is logged at warn with the recipient and the reason and the
   message is gone. That is the owner's proportionality decision: only what
   breaks a graceful restart or is likely in real use had to be exact.
   Everything else REPLAYS once at the next start: a crash mid-turn, a
   rejected turn, a turn that overran the stop deadline, a send that never
   settled, and a turn that resolved with no send and no disposition (it
   recorded no outcome). There is NO durable delivery evidence and no
   per-entry send identity in the log - and therefore no suppression of a
   send that the log would otherwise prove answered: the OUTCOME is what the
   turn recorded, nothing per send is kept.

3. Photos are received as durable receipts BEFORE the download starts
   (pendingPhoto). The completed photo message replaces the receipt entry in
   place (still one per update) and is queued; a crash mid-download replays
   the receipt at the next start, and the channel re-fetches the file. That
   replay runs BEFORE `index.ts` starts the channel, so the channel keeps a
   download-capable client of its own for it (created on demand, without
   handlers or polling; sending still requires a started bot). On re-fetch
   failure the receipt itself is queued as its caption text, so the message
   is never lost.
4. On start, every uncommitted entry is replayed in order as a signal; the
   entries STAY in the log until they commit, so a crash after a restore
   cannot lose a message (the next start replays them again). Committed
   entries are compacted away (default `maxEntries` = 1000) and the
   recent-keys ring keeps the dedup memory across compaction; both bounds are
   the ones stated in point 1 - very old keys fall out of the ring once its
   capacity is used.

A corrupt or unreadable log file fails startup loudly with its path and the
original error as `cause`.

#### The two guarantees (owner decision, comment 54)

- **Graceful restart - strict.** When the shutdown sequence above completes,
  no turn and no message is lost, and none is answered twice. The stop drains
  the turn in flight, delivers (or reports) the sends it scheduled, and
  flushes storage last: an entry removed by a recorded outcome cannot replay,
  an entry without one replays exactly once at the next start.
- **Crash (kill -9, OOM, a broken generation) - best effort.** Every message
  whose turn recorded no outcome replays once at the next start. A message
  whose turn recorded an outcome can still be LOST if that outcome was a
  failed send or a failed turn: by decision it is not retried, it is warned.

#### Known crash windows (best effort; filed as one debt item, not fixed here)

- **Between receipt and the emit-time flush:** the update is lost and the
  signal is not queued either; the emit error surfaces through the channel's
  error handler.
- **An answer delivered while the removal is not yet on disk:** the message is
  answered TWICE after the restart - once by the delivery that did happen,
  once by the replay. The same window covers every outcome recorded only in
  memory when the crash hits (deliberate silence, failed send, failed turn).
- **A send in flight at the crash:** it is not a recorded outcome, so the
  message replays once; the user may receive the late send AND the replayed
  answer.
- **A failed outcome is not retried:** a failed send and a failed turn remove
  the message for good (warned). This is the owner's decision, not an
  accident of the window above.
- An overrunning turn is abandoned, not aborted: a late SEND intent from it
  is dropped with a warning (fenced), and its in-loop tool writes land in the
  deferred cache and are lost at exit. An abort for the turn in flight lands
  with `dialogue-1`; until then the replay path is the recovery.

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
