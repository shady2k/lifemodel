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

---

## 3-Layer Brain Architecture

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

---

## Key Concepts

### Neurons (AUTONOMIC)
Monitor state, fire on meaningful change. Use Weber-Fechner law (relative thresholds).
- `SocialDebtNeuron`, `EnergyNeuron`, `ContactPressureNeuron`, `TimeNeuron`, `AlertnessNeuron`

### Signal Acknowledgment (AGGREGATION)
Like habituation - prevents repetitive processing:
- **handled**: Signal processed, clear it
- **deferred**: "Not now, but later" (with override on significant change)
- **suppressed**: Block indefinitely

### Intents
Layers don't mutate state. They return Intents that CoreLoop applies:
- `UPDATE_STATE`, `SEND_MESSAGE`, `SCHEDULE_EVENT`
- `ACK_SIGNAL`, `DEFER_SIGNAL`

### Memory Consolidation
During sleep mode: merge duplicates, decay old memories, forget weak ones.

### COGNITION Agentic Loop
Uses **native OpenAI tool calling** per [OpenAI Chat Completions API](https://platform.openai.com/docs/guides/function-calling):
- Tools registered with `strict: true` and `additionalProperties: false`
- Terminal via `core.final` tool with discriminated union (`respond | no_action | defer`)
- Tool results linked via `toolCallId` (OpenAI's `tool_call_id`)
- Smart retry: if confidence < 0.6 and no side-effect tools ran → retry with expensive model

```
Request: messages + tools (tool_choice: "required")
    ↓
Response: { tool_calls: [...], content: "thinking..." }
    ↓
Execute tools → add role: "tool" messages with tool_call_id
    ↓
Loop until core.final called → parse args → return intents
```

**OpenAI API compliance:**
- `tool_calls[].id` links to `tool_call_id` in tool results
- `role: "tool"` for tool result messages (Chat Completions format)
- `parallel_tool_calls: false` for deterministic execution
- `strict: true` on tools for schema adherence

---

## Project Structure

```
src/
├── core/           # CoreLoop, Agent, energy, event-bus
├── layers/         # autonomic/, aggregation/, cognition/
├── llm/            # LLM provider interface, tool schema conversion
├── plugins/        # neurons/, channels/, providers/
├── channels/       # Input channels (Telegram, etc.)
├── ports/          # External service adapters
├── storage/        # Persistence, memory, conversations
├── types/          # Signal, Intent, Cognition types
└── config/         # Configuration loading
```

---

## Development

```bash
npm run build    # Compile TypeScript
npm run dev      # Hot reload
npm start        # Run agent
npm test         # Run tests
```

**Platform**: macOS (Darwin) - use `gtimeout` instead of `timeout`
