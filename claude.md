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

---

## 4-Layer Brain Architecture

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
│  │         COGNITION LAYER             │  Cheap LLM            │
│  │  • Fast thinking, simple decisions  │  Like: System 1       │
│  └──────────────────┬──────────────────┘                       │
│                     │ (only if uncertain)                      │
│  ┌──────────────────▼──────────────────┐                       │
│  │           SMART LAYER               │  Expensive LLM        │
│  │  • Deep reasoning, complex tasks    │  Like: System 2       │
│  └─────────────────────────────────────┘                       │
└─────────────────────────────────────────────────────────────────┘
```

Most ticks: only AUTONOMIC and AGGREGATION run. COGNITION wakes for user messages or threshold crossings. SMART engages rarely.

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

---

## Project Structure

```
src/
├── core/           # CoreLoop, Agent, energy, event-bus
├── layers/         # autonomic/, aggregation/, cognition/, smart/
├── plugins/        # neurons/, channels/, providers/
├── types/          # Signal, Intent, Cognition types
├── storage/        # Persistence, memory, conversations
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
