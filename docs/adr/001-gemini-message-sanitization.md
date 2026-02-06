# ADR-001: Gemini Message Sanitization in OpenRouter Provider

**Date:** 2026-02-06
**Status:** Accepted
**Affects:** `src/plugins/providers/openrouter.ts`

## Problem

Gemini models (`google/*`) via OpenRouter reject or crash on two message patterns that our agentic loop produces:

1. **First content message is not `user`** — Autonomous triggers (thoughts, plugin events, proactive contact) produce `system → assistant(+tool_calls) → tool` sequences with no user message. OpenRouter collapses leading system messages into Gemini's `system_instruction`, making the first content message `assistant`. Gemini requires first content to be `user` → 400 error.

2. **Mid-conversation `system` messages** — Our agentic loop injects system messages after conversation history for trigger prompts, retry notes, and force-respond escalation. Gemini only supports `system` as `system_instruction` at the start. OpenRouter can't translate mid-conversation system messages → 500 Internal Server Error.

## Decision

Handle both issues in `OpenRouterProvider.buildRequestBody()`, gated behind `isGeminiModel()`:

1. **`ensureUserTurnForGemini`** — If the first non-system message is not `user`, insert a synthetic `{ role: 'user', content: '[autonomous processing]' }` message.

2. **`sanitizeSystemMessagesForGemini`** — Find the leading block of consecutive system messages (left for OpenRouter to collapse into `system_instruction`). Convert any system messages after that block to `user` role with a `[System]` prefix.

## Alternatives Considered

### A. Merge all system messages into leading system prompt
Proposed by: Codex consultation.

Rejected because 3 of 4 mid-conversation system message injection points cannot be merged:
- **Retry note** — Only exists on retry; reconstructed tool call messages MUST follow it (atomic unit invariant, CLAUDE.md Lesson #2)
- **Force-respond** — Conditional escalation that only fires on 2nd+ attempt; can't pre-bake
- **Compacted summary** — Must precede recent history for narrative flow

### B. Fix at source in the agentic loop (never emit mid-conversation system messages)
Inspired by: OpenCode project (which never creates mid-conversation system messages).

Rejected because:
- Would change behavior for ALL providers, not just Gemini
- OpenAI and Anthropic give `system` role higher authority than `user` — switching to `user` role reduces compliance for orchestration directives on those providers
- OpenCode avoids the problem because it's a coding assistant without autonomous triggers, proactive contact, or soul state — different use case

### C. Throw error on mid-conversation system messages (Vercel AI SDK approach)
Rejected — would break our autonomous trigger pipeline.

## Industry Research

| Framework | Approach |
|---|---|
| LiteLLM | Extract ALL system messages to `system_instruction` |
| Vercel AI SDK | Throw error on mid-conversation system messages |
| LangChain | `convert_system_message_to_human=True` option |
| SillyTavern | "Send system as user after chat start" checkbox |
| OpenCode | Avoids the problem (never creates mid-conversation system) |

Converting mid-conversation system to user role is the most common pattern (LangChain, SillyTavern, community solutions).

## Consequences

- Gemini models work for all trigger types (user messages, autonomous, proactive contact, retries)
- Non-Gemini models are completely unaffected (`isGeminiModel` gate)
- Mid-conversation system messages lose their elevated authority on Gemini — acceptable since Gemini doesn't support the concept at all
- If Gemini requires strict alternating user/model turns, consecutive user messages after conversion could be an issue — OpenRouter's adapter currently merges these, but a `mergeConsecutiveUserMessages` step can be added if needed
