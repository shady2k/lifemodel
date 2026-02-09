# Digital Human 2.0

## Core Philosophy

**We are building a digital human, not a chatbot.**

Architecture mirrors the human body: Channels = senses, Signals = neural impulses, Layers = brain regions, CoreLoop = heartbeat (1s tick), Energy & state = physiology.

## Design Principles

1. **Energy Conservation** — Layered processing: autonomic first (free), conscious thought only when needed (expensive).
2. **Emergence Over Polling** — State accumulates → pressure crosses threshold → action emerges. No periodic polling.
3. **Signals, Not Events** — Everything is a Signal. Unified model for all data flow.
4. **Plugin Isolation** — Core NEVER imports plugin types. Plugins use ONLY PluginPrimitives API. No direct calls between plugins.
5. **No Backward Compatibility** — Remove dead code. Clean breaks over compatibility shims.
6. **No Attribute Prefix Routing** — Never encode behavior in attribute names (e.g., `interest_crypto`). Create dedicated tools with explicit fields. ID prefixes (`mem_`, `core.*`) are fine — they identify types, not encode behavior.
7. **Restart-Safe Scheduling** — Preserve existing schedules on restart. Past-due schedules fire immediately.

## Lessons Learned

These are requirements, not suggestions.

1. **Read-Write Symmetry in Plugin APIs** — If plugins can READ, they need WRITE too. `getUserProperty` without `setUserProperty` caused silent data loss.

2. **Atomic Units in Conversation History** — Tool calls and results must NEVER be separated. Every `tool` message's `tool_call_id` must match a preceding `tool_calls[].id`.

3. **Deterministic Errors Need Prevention, Not Recovery** — Same input → same error means fix the root cause. Don't retry what will always fail.

4. **Unified Storage Path** — All data through DeferredStorage → JSONStorage (atomic writes). Direct file I/O causes race conditions and `}{` corruption.

5. **Timestamp Filtering Uses Content Timestamps** — `lastFetchedAt = max(item.publishedAt)`, NOT `new Date()`. Using fetch time skips items published between content time and fetch time.

6. **Stop Conditions Handle Gaps** — Use exact match `id === lastSeenId`, not `id <= lastSeenId`. IDs may have gaps from deletions.

## Documentation

- `docs/architecture.md` - 3-layer brain, CoreLoop, agentic loop, project structure
- `docs/concepts/` - Signals, intents, energy, memory, conversation history
- `docs/features/` - Thinking, news, reminders, social debt
- `docs/plugins/` - Neurons, channels, plugin overview
- `docs/adr/` - Architecture Decision Records

## Data & Logs

- `data/logs/agent-<timestamp>.log` — Structured pino logs: system events, LLM requests/responses, tool calls, errors
- `data/logs/conversation-<timestamp>.log` — Human-readable: exact messages sent to/from LLM with role markers
- `data/state/` — Persisted user data (state, memory, conversations)

## Debugging Unexpected Agent Output

### Finding the Problem

1. **Find logs:** `ls -t data/logs/agent-*.log | head -3`
2. **Find the tick:** Search conversation log for the bad output text — note the `[traceId:tick_NNNNN]` prefix
3. **Trace the chain:** `grep "tick_NNNNN" data/logs/agent-*.log` reveals: trigger → LLM request → LLM response → post-processing

### Conversation Log Format
```
[HH:MM:SS] [traceId:tick_N] ► [N] ROLE:
  message content...
[HH:MM:SS] [traceId:tick_N] ────────────
← RESPONSE [duration, tokens, finish_reason] gen:<generation_id>
  LLM response...
═══════════════════════════════
```

### Key Log Fields

| Field | What it tells you |
|-------|-------------------|
| `traceId` / `spanId` | Groups events in one processing chain / specific tick |
| `triggerType` | What caused the agent to act (`contact_urge`, `user_message`, `thought`) |
| `model` / `provider` | Which model produced the output, `role` = fast/smart |
| `generationId` | OpenRouter generation ID for provider-side debugging |
| `finishReason` | `stop` = normal, `length` = truncated |
| `response` / `contentPreview` | Full raw LLM output / first 100 chars of plain-text |

### Common Issues

- **Model echoing instructions:** Search `"Accepted plain-text response"`. Non-user-message triggers reject plain text (`allowPlainText: false`). If it still leaked, check which model (`model` field) and whether it's a prompt clarity issue.
- **Poisoned history:** Bad response saved in conversation history → model copies pattern. Check for bad text in prior ASSISTANT messages in the conversation log. Fix: clean `data/state/` conversation files.
- **Truncated response:** `finishReason: "length"` — model hit token limit. Agentic loop retries with smart model.
- **Container issues:** Search logs for `component: "container-manager"`. `docker ps -a --filter label=com.lifemodel.component=motor-cortex` lists all Motor Cortex containers. Stale containers are pruned on restart. If Docker is unavailable, agentic runs fail unless `MOTOR_CORTEX_UNSAFE=true`.
