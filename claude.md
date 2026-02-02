# Digital Human 2.0

## Core Philosophy

**We are building a digital human, not a chatbot.**

The architecture mirrors the human body and brain:
- **Channels** = sensory organs (eyes, ears)
- **Signals** = neural impulses
- **Layers** = brain regions
- **CoreLoop** = heartbeat (steady 1-second tick)
- **Energy & state** = physiology (tired, alert, sleepy)

---

## Design Principles

### 1. Energy Conservation
Never do more than necessary. Layered processing: autonomic first (free), conscious thought only when needed (expensive).

### 2. Emergence Over Polling
State accumulates → pressure crosses threshold → action emerges naturally. No "check every N minutes" polling.

### 3. Signals, Not Events
Everything is a Signal. Unified model for all data flowing through the brain.

### 4. Plugin Isolation
Core and plugins are strictly decoupled. Core NEVER imports plugin types. Plugins interact with core ONLY via PluginPrimitives API. No direct calls between them.

### 5. No Backward Compatibility
Remove old, dead, and unused code. Avoid fallbacks. Clean breaks over compatibility shims.

### 6. No Attribute Prefix Routing
Never encode behavior in attribute names via prefixes (e.g., `interest_crypto`, `urgency_news`).
This forces LLMs to use identifier-style naming with underscores instead of natural language.

**Bad:** `core.remember(attribute="interest_локальные_модели", value="+0.5")`
**Good:** `core.setInterest(topic="локальные модели", intensity="strong_positive")`

Create dedicated tools with explicit fields instead.

Note: ID prefixes (`mem_`, `rcpt_`, `src_`) and namespace prefixes (`core.*`, `plugin.*`) are fine -
they identify entity types, not encode behavior.

### 7. Restart-Safe Scheduling
Scheduled events must not be lost due to downtime. On restart:
- Preserve existing schedules (don't overwrite with new `fireAt`)
- Past-due schedules fire immediately (catch-up behavior)
- This ensures reliability without requiring 24/7 uptime

---

## Lessons Learned

Architectural insights from past bugs. These are requirements, not suggestions.

### 1. Read-Write Symmetry in Plugin APIs
If plugins can READ a capability, they likely need to WRITE it too. Design plugin service interfaces with read-write symmetry from the start.

**Example:** `getUserProperty` without `setUserProperty` caused silent data loss - tools reported success but changes weren't persisted.

### 2. Atomic Units in Conversation History
Tool calls and their results are **atomic units**. History management (slicing, compaction, retrieval) must NEVER separate them.

**Invariant:** Every `tool` message's `tool_call_id` must have a matching `tool_calls[].id` in a preceding `assistant` message.

**Example:** History slicing cut between a tool call and its result, causing API errors on the next LLM request.

### 3. Deterministic Errors Need Prevention, Not Recovery
If an error is deterministic (same input → same error), fix the root cause. Don't add retry/recovery infrastructure for errors that will just fail again.

**Example:** Snapshot + rollback for tool_call_id mismatches was rejected - the error is caused by bad slicing, which retry won't fix.

### 4. Unified Storage Path
All persistent data must use the same storage infrastructure. Never bypass DeferredStorage with direct file I/O - it causes race conditions and file corruption.

**Pattern:** Component → Storage interface → DeferredStorage → JSONStorage (atomic writes)

**Example:** MemoryProvider used direct `writeFile` with `autoSave: true`. Multiple concurrent saves corrupted the file with `}{` pattern.

### 5. Timestamp Filtering Must Use Content Timestamps
When filtering polling results to avoid duplicates, use the newest item's actual timestamp, not the fetch time.

**Invariant:** `lastFetchedAt = max(item.publishedAt)`, NOT `new Date()`

**Example:** Fetched at 13:01:31, newest article at 12:55:00. Using fetch time as `lastFetchedAt` caused articles published at 13:00:00 to be filtered on the next poll—they were never seen but appeared "old" compared to 13:01:31.

### 6. Stop Conditions Must Handle Gaps
When stopping pagination at a "last seen" ID, use exact match (`===`), not less-than-or-equal (`<=`). IDs may have gaps due to deletions.

**Invariant:** Stop on `id === lastSeenId`, not `id <= lastSeenId`

**Example:** `lastSeenId=26580` but posts 26574-26580 were deleted. Max current ID is 26573. Using `<=` stopped immediately on the first post (26573 <= 26580), returning 0 articles instead of the expected posts.

---

## Documentation

Project documentation is in the `docs/` folder:
- `docs/architecture.md` - 3-layer brain, CoreLoop, project structure
- `docs/concepts/` - Signals, intents, energy model, memory, conversation history
- `docs/features/` - Thinking, news, reminders, social debt
- `docs/plugins/` - Neurons, channels, plugin overview
