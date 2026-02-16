# ADR-001: Gemini Message Sanitization → Transcript Compiler

**Date:** 2026-02-06 (original), 2026-02-16 (superseded)
**Status:** Superseded by transcript compiler
**Affects:** `src/plugins/providers/transcript-compiler.ts`, `src/plugins/providers/provider-transforms.ts`

## Problem

Gemini models (`google/*`) via OpenRouter reject or crash on two message patterns that our agentic loop produces:

1. **First content message is not `user`** — Autonomous triggers (thoughts, plugin events, proactive contact) produce `system → assistant(+tool_calls) → tool` sequences with no user message. OpenRouter collapses leading system messages into Gemini's `system_instruction`, making the first content message `assistant`. Gemini requires first content to be `user` → 400 error.

2. **Mid-conversation `system` messages** — Our agentic loop injects system messages after conversation history for trigger prompts, retry notes, and force-respond escalation. Gemini only supports `system` as `system_instruction` at the start. OpenRouter can't translate mid-conversation system messages → 500 Internal Server Error.

3. **Consecutive same-role messages** — Local models (LM Studio) reject messages with consecutive same-role entries (3 assistants, 2 users, 2 system). OpenRouter silently normalizes this, but direct connections to local servers have no normalization layer.

## Decision (v2 — Transcript Compiler)

The original Gemini-specific transforms (`ensureUserTurnForGemini`, `sanitizeSystemMessagesForGemini`) have been replaced by a **universal transcript compiler** that normalizes messages via declarative policies.

**Architecture:**
```
history-builder.ts (semantic transcript — source of truth)
       ↓
transcript-compiler.ts (structural normalization — policy-driven)
       ↓
addCacheControl() (provider metadata)
       ↓
convertMessages() → generateText() (wire format + transport)
```

**Policies:**
- `STRICT_POLICY` — Local providers: merge consecutive same-role, collapse leading system to 1
- `GEMINI_POLICY` — Gemini via OpenRouter: insert synthetic user turn, convert mid-system to user
- `OPENROUTER_POLICY` — Passthrough (OpenRouter normalizes)

**Transform pipeline** (order matters):
1. Merge leading system messages → exactly `maxLeadingSystemMessages`
2. Convert mid-conversation system → `[System]`-prefixed user (with `_noMerge` flag)
3. Insert synthetic user turn if first content is assistant
4. Merge consecutive same-role messages (skip tool_calls, tool_call_id, _noMerge, null content)

**Post-compile checks:**
- Duplicate `tool_call.id` → throws (data corruption)
- Orphan tool results → warns (trimmed histories produce these legitimately)

## Original Decision (v1)

Handle both issues in provider `executeRequest()`, gated behind `isGeminiModel()`:

1. `ensureUserTurnForGemini` — Insert synthetic user message
2. `sanitizeSystemMessagesForGemini` — Convert mid-conversation system to user

**Removed** — absorbed by transcript compiler policies.

## Alternatives Considered

### A. Merge all system messages into leading system prompt
Rejected because mid-conversation system messages (retry notes, force-respond, compacted summary) cannot be pre-baked.

### B. Fix at source in the agentic loop
Rejected — would change behavior for all providers; OpenAI/Anthropic give `system` role higher authority.

### C. Per-provider if/else blocks
Rejected in v2 — doesn't scale. The transcript compiler with declarative policies is the proper abstraction.

## Industry Research

| Framework | Approach |
|---|---|
| LiteLLM | Extract ALL system messages to `system_instruction` |
| Vercel AI SDK | Throw error on mid-conversation system messages |
| LangChain | `convert_system_message_to_human=True` option |
| SillyTavern | "Send system as user after chat start" checkbox |
| OpenCode | Avoids the problem (never creates mid-conversation system) |

## Consequences

- All provider constraints handled by a single pipeline with structured telemetry
- Adding new provider constraints = adding a new `TranscriptPolicy`
- Local models (LM Studio) no longer get 400 errors from consecutive same-role messages
- Gemini behavior preserved via `GEMINI_POLICY`
- `provider-transforms.ts` retains `isGeminiModel()` and `addCacheControl()` (provider-layer concerns)
