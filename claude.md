# Digital Human 2.0

## Core Philosophy

**We are building a digital human, not a chatbot.**

The architecture mirrors the human body and brain:
- **Channels are sensory organs** (eyes, ears) — they perceive the world and emit signals
- **Signals are neural impulses** — unified data flowing through the system
- **Layers are brain regions** — each handles different levels of processing
- **The CoreLoop is the heartbeat** — steady 1-second tick, always running
- **Energy and state are physiology** — the agent gets tired, alert, sleepy

This is Human 2.0: same principles as biological systems, but with introspection and logging built in. A human can't explain why they felt the urge to message someone. This agent can.

---

## Design Principles

### 1. Energy Conservation (Like the Body)

The human body is a master of energy conservation. So is this agent:

- **Never do more than necessary**. Simple math? Don't call an LLM.
- **Layered processing**: autonomic first (free), conscious thought only when needed (expensive).
- **Simplicity > complexity** when results are equal.

You don't engage your prefrontal cortex to pull your hand from a hot stove — the spinal cord handles it. Similarly, the agent doesn't call GPT-4 to check if it's nighttime.

### 2. Emergence Over Polling

Humans don't check every minute "should I message someone?" Instead:

1. **Background state accumulates** (social debt, unfinished thoughts)
2. **Internal pressure crosses threshold**
3. **Action emerges naturally**

The thought "I should message X" **emerges** from state, not from polling.

### 3. Signals, Not Events

Everything entering the brain is a **Signal** — a unified model:
- User message from Telegram → Signal
- Time tick → Signal
- Internal pressure change → Signal
- Pattern detected → Signal

Channels are "sensory organs" that convert external stimuli into Signals.

---

## 4-Layer Brain Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      DIGITAL HUMAN 2.0                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐    Sensory Organs (Channels)                  │
│  │  Telegram   │────┐                                          │
│  │   (ears)    │    │                                          │
│  └─────────────┘    │                                          │
│                     ▼                                          │
│              ┌──────────────┐                                  │
│              │   SIGNALS    │  Neural impulses                 │
│              └──────┬───────┘                                  │
│                     │                                          │
│  ┌──────────────────▼──────────────────┐                       │
│  │         AUTONOMIC LAYER             │  Always running       │
│  │  • Neurons monitor state            │  Zero LLM cost        │
│  │  • Emit signals on meaningful change│  Like: brain stem,    │
│  │  • Weber-Fechner change detection   │  autonomic nervous    │
│  └──────────────────┬──────────────────┘  system               │
│                     │                                          │
│  ┌──────────────────▼──────────────────┐                       │
│  │        AGGREGATION LAYER            │  Collects & decides   │
│  │  • Buckets signals by type          │  Zero LLM cost        │
│  │  • Detects patterns & anomalies     │  Like: thalamus,      │
│  │  • Decides: wake COGNITION?         │  sensory gating       │
│  └──────────────────┬──────────────────┘                       │
│                     │ (only if threshold crossed)              │
│  ┌──────────────────▼──────────────────┐                       │
│  │         COGNITION LAYER             │  Fast thinking        │
│  │  • Synthesizes understanding        │  Cheap LLM            │
│  │  • Decides action or escalates      │  Like: prefrontal     │
│  │  • Handles simple responses         │  cortex (fast path)   │
│  └──────────────────┬──────────────────┘                       │
│                     │ (only if uncertain)                      │
│  ┌──────────────────▼──────────────────┐                       │
│  │           SMART LAYER               │  Deep thinking        │
│  │  • Complex reasoning                │  Expensive LLM        │
│  │  • Nuanced composition              │  Like: deliberate     │
│  │  • Called rarely                    │  reasoning            │
│  └─────────────────────────────────────┘                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Layer Details

| Layer | Purpose | Cost | Analogy |
|-------|---------|------|---------|
| **AUTONOMIC** | Neurons monitor state, emit signals on meaningful change | Zero | Brain stem, autonomic nervous system |
| **AGGREGATION** | Collect signals, detect patterns, decide if conscious thought needed | Zero | Thalamus, sensory gating |
| **COGNITION** | Fast understanding, simple decisions, or escalate | Cheap LLM | Prefrontal cortex (System 1) |
| **SMART** | Deep reasoning, complex composition | Expensive LLM | Deliberate thought (System 2) |

### Signal Flow

1. **Sensory input**: Channel receives data → emits Signal
2. **AUTONOMIC**: Neurons check state → emit internal Signals if meaningful change
3. **AGGREGATION**: Collects all Signals → decides if COGNITION should wake
4. **COGNITION** (if woken): Understands situation → responds or escalates
5. **SMART** (if escalated): Deep reasoning → quality response
6. **Motor output**: Intent → Channel sends message

Most ticks: only AUTONOMIC and AGGREGATION run. COGNITION wakes for user messages or threshold crossings. SMART engages rarely for complex situations.

---

## Neurons (AUTONOMIC Layer)

Neurons are like biological neurons — they monitor specific aspects of state and fire when something meaningful changes.

```typescript
// Each neuron monitors one thing
SocialDebtNeuron     → fires when social debt changes significantly
EnergyNeuron         → fires when energy level changes
ContactPressureNeuron → weighted combination, fires when pressure high
TimeNeuron           → fires on hour change, time-of-day transitions
AlertnessNeuron      → calculates alertness mode from multiple inputs
```

**Weber-Fechner Law**: Neurons use relative thresholds. A change from 0.1 to 0.2 (100% increase) is meaningful. A change from 0.8 to 0.81 (1.25% increase) is not. This matches human perception.

**Neurons only emit on meaningful change** — not every tick. This is energy conservation.

---

## CoreLoop (The Heartbeat)

Fixed 1-second tick. Like a heartbeat — steady, always running.

```typescript
while (running) {
  // 1. Collect signals from sensory organs
  const incoming = collectIncomingSignals();

  // 2. AUTONOMIC: neurons check state
  const autonomic = processAutonomic(incoming);

  // 3. AGGREGATION: collect, decide if COGNITION wakes
  const aggregation = processAggregation(autonomic.signals);

  // 4. COGNITION: (if woken) fast LLM processing
  if (aggregation.wakeCognition) {
    const cognition = processCognition(aggregation);

    // 5. SMART: (if escalated) expensive LLM
    if (cognition.escalateToSmart) {
      processSmart(cognition.smartContext);
    }
  }

  // 6. Apply all intents
  applyIntents(allIntents);

  // 7. Sleep 1 second
  await sleep(1000);
}
```

**Why fixed tick?** Simplicity. Dynamic tick rates added complexity without proportional benefit. The layers handle efficiency — AUTONOMIC and AGGREGATION are cheap, COGNITION/SMART only run when needed.

---

## Channels (Sensory Organs)

Channels are like eyes and ears — they perceive the external world and convert stimuli to Signals.

```typescript
// Telegram channel = ears
telegramChannel.onMessage((msg) => {
  const signal = createUserMessageSignal({
    text: msg.text,
    chatId: msg.chatId,
    channel: 'telegram',
    userId: msg.userId,
  });
  coreLoop.pushSignal(signal);
});
```

Channels also handle motor output (sending messages) via Intents.

---

## Signals (Neural Impulses)

Everything is a Signal. Unified model for all data flowing through the brain.

```typescript
interface Signal {
  id: string;
  type: SignalType;           // 'user_message', 'social_debt', 'tick', etc.
  source: SignalSource;       // 'sense.telegram', 'neuron.energy', etc.
  priority: Priority;
  data: SignalData;           // Type-specific payload
  metrics: SignalMetrics;     // value, previousValue, rateOfChange, confidence
  expiresAt?: Date;
  correlationId?: string;     // Groups signals from same tick
}
```

**Signal types**:
- `sensory`: From channels (user_message, channel_status)
- `internal`: From neurons (social_debt, energy, contact_pressure)
- `time`: Clock signals (tick, hour_changed, time_of_day)
- `meta`: From aggregation (pattern_break, threshold_crossed)

---

## Intent-Based Actions

Layers don't mutate state directly. They return **Intents** that the CoreLoop applies.

```typescript
interface Intent {
  type: 'UPDATE_STATE' | 'SEND_MESSAGE' | 'SCHEDULE_EVENT' | ...;
  payload: unknown;
}

// Layer returns intents
return {
  intents: [
    { type: 'UPDATE_STATE', payload: { key: 'socialDebt', value: -0.2, delta: true } },
    { type: 'SEND_MESSAGE', payload: { text: 'Hello!', target: chatId, channel: 'telegram' } },
  ],
};
```

This provides:
- **Traceability**: All state changes logged
- **Testability**: Layers are pure functions
- **Control**: CoreLoop validates and applies in order

---

## Energy & State (Physiology)

The agent has internal physiology:

```typescript
interface AgentState {
  energy: number;        // 0-1, drains with activity, recharges over time
  socialDebt: number;    // 0-1, accumulates when not talking to user
  alertnessMode: 'alert' | 'normal' | 'relaxed' | 'sleep';
}
```

**Energy affects everything**:
- Low energy → higher thresholds to act
- Low energy → simpler responses preferred
- Night time → energy recharges

**Social debt** accumulates naturally over time. When it crosses threshold + user is available + agent has energy → proactive contact emerges.

---

## User Model (Beliefs About User)

The agent maintains **beliefs** about the user (not truth):

```typescript
interface UserModel {
  energy: number;           // Estimated from time of day, response patterns
  availability: number;     // How available they seem
  mood: string;             // Detected from messages
  confidence: number;       // How sure agent is about these beliefs

  // Learned
  language: string;         // Detected from messages
  name: string;             // If mentioned
  timezoneOffset: number;   // For time-based availability
}
```

Beliefs decay over time. Agent becomes less confident about user state if no recent signals.

---

## File Structure

```
src/
├── core/
│   ├── core-loop.ts       # The heartbeat (4-layer pipeline)
│   ├── agent.ts           # Agent state & identity
│   ├── container.ts       # Dependency injection
│   └── event-bus.ts       # Pub/sub for internal events

├── layers/
│   ├── autonomic/         # AUTONOMIC layer
│   │   ├── processor.ts
│   │   ├── neuron-registry.ts
│   │   ├── change-detector.ts
│   │   └── neurons/
│   │       ├── social-debt.ts
│   │       ├── energy.ts
│   │       ├── contact-pressure.ts
│   │       ├── time.ts
│   │       └── alertness.ts
│   ├── aggregation/       # AGGREGATION layer
│   │   ├── processor.ts
│   │   ├── aggregator.ts
│   │   ├── threshold-engine.ts
│   │   └── pattern-detector.ts
│   ├── cognition/         # COGNITION layer
│   │   ├── processor.ts
│   │   ├── thought-synthesizer.ts
│   │   └── action-decider.ts
│   └── smart/             # SMART layer
│       ├── processor.ts
│       └── escalation-handler.ts

├── types/
│   ├── signal.ts          # Signal types & helpers
│   ├── layers.ts          # Layer interfaces
│   └── intent.ts          # Intent types

├── channels/
│   └── telegram.ts        # Telegram sensory organ

├── llm/
│   ├── provider.ts        # LLM provider interface
│   ├── composer.ts        # Message composition
│   └── openrouter.ts      # OpenRouter implementation

├── models/
│   └── user-model.ts      # Beliefs about user

├── storage/
│   ├── json-storage.ts    # Persistence
│   └── conversation-manager.ts

└── index.ts               # Entry point
```

---

## Key Insight Summary

**Old approach**: "Check every N minutes if I should contact user"

**This approach**: "Have internal state that naturally builds pressure, and act when threshold crossed"

This mirrors human psychology:
- We don't poll our brain asking "should I message friend?"
- Internal state (guilt, curiosity, need) accumulates
- Thought emerges when pressure exceeds threshold
- Social constraints gate the action

**The "aliveness" comes from:**
1. Layered processing (efficient, like biology)
2. State-based emergence (not scripted triggers)
3. Energy awareness (agent gets tired)
4. User modeling (respects their state)
5. Explainability (can trace why it acted)

---

## Tech Stack

| Component | Choice | Reason |
|-----------|--------|--------|
| Runtime | Node.js | Async, good for event-driven |
| Language | TypeScript | Type safety for complex state |
| Telegram | grammY | TypeScript-first, modern |
| Storage | JSON files | Simple, switch to DB later |
| LLM | OpenRouter / Local | Provider agnostic |
| Logging | Pino | Fast, structured JSON |

---

## Development Notes

- **Platform**: macOS (Darwin)
- **No `timeout` command**: Use `gtimeout` from coreutils or run without timeout
- **Build**: `npm run build`
- **Run**: `npm start`
- **Dev**: `npm run dev` (with hot reload)
