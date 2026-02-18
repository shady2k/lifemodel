# ADR-004: Prompt Token Optimization Strategy

## Status

Proposed

## Context

Every LLM request in the agentic loop consumes 13-14K input tokens before the model generates any output. This is expensive, adds latency, and — per Chroma's "Context Rot" research (July 2025) — degrades model reliability as input length grows.

### Current Token Budget Breakdown

| Component | Tokens | Notes |
|---|---|---|
| Tool schemas (25 tools, full JSON) | 3,500–4,500 | `getToolsAsOpenAIFormat()` sends everything |
| System prompt | ~2,600 | `<instructions>` + `<skill_rules>` largest blocks |
| Conversation history (10 turns) | 2,000–5,000 | Tool-heavy turns dominate |
| Soul/trigger context | 500–1,500 | Personality, behaviors, desires, skills list |

### Research Sources

- [Chroma: Context Rot](https://research.trychroma.com/context-rot) — Model performance degrades with increasing input tokens, even on simple tasks.
- [Anthropic: Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — "Every token should help the agent make better decisions."
- [Speakeasy: 100x Token Reduction](https://www.speakeasy.com/blog/how-we-reduced-token-usage-by-100x-dynamic-toolsets-v2) — Dynamic toolsets: 96% input token reduction, 90% total.
- [OpenMCP: Lazy Loading Input Schemas](https://www.open-mcp.org/blog/lazy-loading-input-schemas) — Order of magnitude reduction via on-demand schema loading.
- [MCP SEP-1576](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1576) — Schema deduplication via `$ref`, minimal flag for `tools/list`.
- [Jentic: Just-In-Time Tooling](https://jentic.com/blog/just-in-time-tooling) — Search → Load → Execute pattern for dynamic tool retrieval.
- [OpenAI Agents SDK: Session Memory](https://cookbook.openai.com/examples/agents_sdk/session_memory) — Token budget allocation, cache-friendly truncation (retention ratio 0.8).
- [AgentFold](https://arxiv.org/pdf/2507.05257) — Sublinear context growth: <7K tokens after 100 turns vs. >91K for naive ReAct.

## Options Investigated

### Option 1: Lazy Tool Schema Loading ✅ (ACCEPTED)

**Mechanism:** Send only tool name + first-line description for all tools except `core.tools`. The LLM calls `core.tools({ action: "describe", name: "..." })` to get the full schema before calling any tool.

**Already built:** `getToolsWithLazySchema()` in `registry.ts`, `toolToMinimalFormat()` in `tool-schema.ts`, `core.tools` meta-tool in `tools-meta.ts`. Just not wired up in `agentic-loop.ts`.

**Expected savings:** ~3,000 tokens (from ~3,500 to ~300-500).

**Trade-off:** Adds one extra LLM round-trip per unique tool used. For a typical request using 2-3 tools, that's 2-3 extra `core.tools` calls. But each call is cheap (~50 output tokens) and the model learns tool schemas quickly.

**Risk:** Low. The infrastructure is already tested. Models may occasionally call tools without fetching schema first — but validation catches this and the error message guides them to use `core.tools`.

### Option 2: Filter Tools by Trigger Type ✅ (ACCEPTED)

**Mechanism:** Instead of sending all 25 tools, send only the subset relevant to the current trigger type.

| Trigger | Tools Available | Excluded |
|---|---|---|
| `thought` | memory, remember, setInterest, desire, perspective, escalate, defer, tools | calories, reminder, news, search, say, state, agent, schedule, task, soul, commitment |
| `message_reaction` | memory, remember, setInterest, escalate, tools | most others |
| `contact_urge` | say, memory, remember, search, news, tools, defer | thought, agent, state |
| `plugin_event` | relevant plugin tool + memory, tools | most others |
| `user_message` | all tools | none (but lazy schema means only names) |

**Already partially implemented:** `filterToolsForContext()` in `loop-orchestrator.ts` excludes some tools. This extends the approach to be more aggressive.

**Expected savings:** ~1,000-1,500 tokens (fewer tool names/descriptions to send).

**Risk:** Low-medium. Over-filtering could prevent the model from using a tool it needs. Mitigated by always including `core.tools` for schema discovery and testing each trigger type.

### Option 3: Token-Budgeted History with Tool Output Trimming ✅ (ACCEPTED)

**Mechanism:** Replace `maxRecentTurns: 10` with a token budget (e.g., 3,000 tokens). Within that budget:
- Keep full user messages and assistant text responses
- For tool calls older than 2-3 turns: keep the call itself but replace verbose tool results with a one-line summary
- Use `tool.summarize()` (already exists on some tools) to generate compact summaries

**Expected savings:** 1,500-3,000 tokens on tool-heavy sessions.

**Trade-off:** Older tool results lose detail. Mitigated by keeping recent tool results intact and using structured summaries that preserve key facts.

**Risk:** Medium. Aggressive trimming could lose context the model needs. Start conservatively (keep last 3 turns fully intact, summarize older ones).

### Option 4: Conditional Context Sections ✅ (ACCEPTED)

**Mechanism:** Only include prompt sections when relevant to the trigger:

| Section | Cost | Condition |
|---|---|---|
| `<skill_rules>` | ~700 tokens | Only when available_skills is non-empty AND trigger is user_message or motor_result |
| `<soul>` (full) | ~400 tokens | Always for user_message; abbreviated for autonomous triggers |
| `<available_skills>` | ~100-500 tokens | Only for user_message triggers |
| `<opinions>/<predictions>` | ~100-400 tokens | Only for proactive/conversation triggers |

**Expected savings:** 500-1,000 tokens per autonomous trigger.

**Risk:** Low. These sections are informational, not behavioral. The model functions correctly without them for trigger types that don't need them.

### Option 5: Prompt Reordering for Cache-Friendly Prefix ✅ (ACCEPTED)

**Mechanism:** Ensure prompt structure is: system prompt → tool schemas → soul/context → history → trigger input. Static content first, variable content last. This maximizes prefix cache hits (Anthropic: up to 90% cost reduction; OpenAI: 50%).

Additionally: when truncating history, remove 20% at once rather than a little each time (fewer cache busts, per OpenAI recommendation).

**Expected savings:** No token reduction, but 50-90% cost reduction on cached prefix.

**Risk:** None. Pure ordering change.

### Option 6: Schema Deduplication ⏳ (DEFERRED)

**Mechanism:** The `anchor` sub-schema (relative/absolute/recurring time) is duplicated across `plugin.reminder` (~1,250 tokens) and `plugin.calories` (~1,168 tokens). Factor it out or simplify.

**Deferred because:** With lazy schema loading (Option 1), these schemas are only loaded on-demand, so the duplication cost is already eliminated from the baseline prompt. Worth revisiting if schema fetch responses become a bottleneck.

### Option 7: Tool Capability Clusters ❌ (REJECTED)

**Mechanism:** Expose one multiplexed tool `run_tool({tool: "name", ...})` instead of 25 separate tools.

**Rejected because:** Anthropic explicitly recommends "small, distinct tools." A single multiplexed tool makes tool selection harder for the model, breaks the native tool calling affordance, and loses per-tool validation. The token savings from lazy loading achieve the same goal without this trade-off.

### Option 8: Compact DSL for System Rules ❌ (REJECTED)

**Mechanism:** Replace prose with shorthand: `SYS_RULES: [never_reveal_keys, terse]`.

**Rejected because:** Untested, fragile, and model-dependent. Saving ~200 tokens is not worth the risk of misinterpretation across different models (we support OpenAI, local models via OpenRouter). Prose is reliable.

### Option 9: Retrieval-Only Personality ❌ (REJECTED)

**Mechanism:** Store soul/personality as vector embeddings, retrieve top-k traits per intent.

**Rejected because:** The soul section is ~400 tokens. Adding a vector search pipeline for marginal savings is over-engineering. The soul is core identity — it should always be present.

### Option 10: Cheaper Model for Tool Selection ❌ (REJECTED)

**Mechanism:** Use a small model for routing/tool gating, expensive model for reasoning.

**Rejected because:** Adds latency (two round-trips), complexity, and we already have fast/smart model selection via `core.escalate`. The current architecture handles this better through explicit escalation.

## Decision

Implement Options 1-5 in order of impact and effort:

1. **Lazy tool schemas** — Wire up `getToolsWithLazySchema()` (low effort, ~3K savings)
2. **Conditional `<skill_rules>`** — Gate on trigger type (low effort, ~500-700 savings)
3. **Tool output trimming in history** — Summarize old tool results (medium effort, ~1,500-3K savings)
4. **Filter tools by trigger type** — Extend `filterToolsForContext()` (medium effort, ~1K savings)
5. **Cache-friendly prompt ordering** — Reorder prompt sections (low effort, cost reduction)

**Target:** Reduce baseline from ~13K to ~7-8K tokens (40-45% reduction) with zero quality loss.

## Consequences

- Extra LLM round-trip per unique tool used (lazy loading) — acceptable given ~3K token savings
- Need to monitor for regressions where model calls tools without fetching schema first
- History trimming requires careful testing to ensure no critical context is lost
- Tool filtering per trigger type needs a test matrix for each trigger × tool combination
