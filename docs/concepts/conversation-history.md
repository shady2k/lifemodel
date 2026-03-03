# Conversation History

Short-term message history for multi-turn LLM interactions.

## Overview

Conversation history stores the message-by-message record of interactions with a user. Unlike [Memory](./memory.md) (long-term facts), conversation history is:

- **Short-term**: Compacted and summarized over time
- **Per-user**: Keyed by recipient ID
- **LLM-formatted**: Stored in OpenAI message format for direct injection

## Message Types

| Role | Purpose | Fields |
|------|---------|--------|
| `system` | Instructions, context | `content` |
| `user` | User messages | `content` |
| `assistant` | Agent responses | `content`, `tool_calls[]` |
| `tool` | Tool execution results | `content`, `tool_call_id` |

## Invariants

### Tool Call/Result Pairing

**Tool calls and their results are atomic units.**

Every `tool` message's `tool_call_id` MUST have a matching `id` in a preceding `assistant` message's `tool_calls[]` array.

```
assistant: { tool_calls: [{ id: "call_123", ... }] }
tool: { tool_call_id: "call_123", content: "..." }  ← MUST match
```

**Why this matters:**
- LLM APIs reject requests with orphaned tool results
- Tool results without their calls lose semantic meaning
- Tool calls without results confuse the LLM about what happened

### History Slicing

When truncating history to fit context limits:

1. **Never** slice between a tool call and its results
2. Find "safe" boundaries: user messages, or assistant messages whose tool_calls are fully satisfied
3. If an assistant has `tool_calls`, ALL corresponding `tool` messages must be included

### Compaction

When the conversation exceeds the turn or size threshold, older messages are compacted:

- The processor generates a rolling summary via LLM, chaining the previous summary from memory
- The summary is saved to VectorStore as a `MemoryEntry` with `metadata.kind: 'conversation_summary'`
- Messages are then trimmed to the last 3 turns (CAS-guarded for concurrent safety)
- Summaries are searchable via `core.memory` and surface through associations
- Older summaries naturally decay through consolidation — mimics human memory fading
- Keep recent tool call/result pairs intact
- Summarize user/assistant exchanges (skip tool details)

## Turn-Based Counting

History limits are based on **turns**, not individual messages.

### Why Turns?

A single user interaction can generate many messages:
```
user: "Log my lunch"           ← 1 message
assistant: [tool_calls: 3]     ← 1 message
tool: {result 1}               ← 1 message
tool: {result 2}               ← 1 message
tool: {result 3}               ← 1 message
                               ─────────────
                               5 messages for 1 turn!
```

With message-based counting (limit=10), just 2 tool-heavy turns would trigger compaction. With turn-based counting, we preserve the full context of meaningful exchanges.

### What Is a Turn?

A **turn** = user message + assistant response (including all tool calls/results).

```typescript
// Count turns by counting user messages
const turnCount = messages.filter(m => m.role === 'user').length;
```

### Configuration

| Setting | Value | Description |
|---------|-------|-------------|
| `maxTurnsBeforeCompaction` | 10 | Triggers summary generation |
| `recentTurnsToKeep` | 3 | Kept in full after compaction |
| `maxRecentTurns` | 10 | Returned by `getHistory()` |

## Storage

- Key format: `conversation:{recipientId}`
- Messages stored with ISO timestamps
- Conversation summaries stored in VectorStore as `MemoryEntry` objects (`metadata.kind: 'conversation_summary'`)
- Status tracking (active, awaiting_answer, closed, idle)

## Related

- [Memory](./memory.md) - Long-term fact storage
- [Signals](./signals.md) - How messages become signals
- [Intents](./intents.md) - How responses become actions
