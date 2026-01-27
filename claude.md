# Human-Like Proactive AI Agent

## Project Overview

A personal AI assistant that behaves like a human — not a reactive chatbot that only responds when called, but an entity with internal state, energy, beliefs about the user, and the ability to initiate contact naturally.

## Problem Statement

Current AI assistants (including Clawdbot) use cron-based polling for "proactive" behavior — checking every N minutes if they should contact the user. This is:
- Wasteful (constant CPU/API usage)
- Unnatural (fixed intervals don't match human behavior)
- Not truly proactive (still pull-based, not push-based)

**Goal**: Build an agent that initiates contact the way humans do — based on internal state, accumulated pressure, and awareness of the other person's state.

---

## Design Principles

### Minimal Complexity

Like the human body — a master of energy conservation:

- **Never do more than necessary**. If a task can be solved with simple arithmetic, don't invoke an LLM.
- **Layered processing**: reflexes first (cheap), conscious thought only when needed (expensive).
- **Simplicity > complexity** when results are equal.
- The right solution uses the minimum resources required for the current situation.

Analogy: You don't engage your prefrontal cortex to pull your hand from a hot stove. The spinal cord handles it. Similarly, the agent shouldn't call GPT-4 to check if it's nighttime.

---

## Core Architecture

### How Humans Initiate Contact

Humans don't check every minute "should I message someone?" Instead:

1. **Background state** accumulates (social debt, unfinished tasks, curiosity)
2. **Events trigger associations** (see something that reminds of person)
3. **Internal pressure crosses threshold**
4. **Social constraints are checked** (is it appropriate time? are they available?)
5. **Action taken** (send message)

Key insight: The thought "I should message X" **emerges** from state, not from polling.

### Proposed Architecture

**Event-driven, not polling with variable intervals.**

This is not "cron that adjusts its timer" — it's a fundamentally different model:

- **Like a CPU**: There are clock ticks, but the process is continuous. Events are processed as they arrive, state updates happen naturally.
- **Like the nervous system**: Spinal cord handles reflexes (cheap, fast), cortex engages only for complex decisions (expensive, rare).
- **Base layer** processes events and updates state continuously.
- **Smart layer** is invoked only when pressure crosses a threshold — not on every tick.

```
┌─────────────────────────────────────────────────────────────┐
│                    Human-Like Agent                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Base Layer (always running, cheap):                       │
│  • State variables                                          │
│  • Dynamic rules engine                                     │
│  • Event processing                                         │
│  • Threshold detection                                      │
│  • Dynamic tick rate (adaptive, not fixed cron)            │
│                                                             │
│  Smart Layer (on-demand, expensive):                       │
│  • Compose messages                                         │
│  • Invent new rules                                        │
│  • Complex reasoning                                        │
│  • Called ONLY when threshold crossed                      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

### 1. Multi-Model Hierarchy

Not one big LLM for everything. Different models for different jobs:

| Role | Purpose | Cost | When |
|------|---------|------|------|
| Fast | Classification, yes/no, emotion detection | Cheap/free | Every event |
| Smart | Compose messages, invent rules, reasoning | Expensive | Rare, on threshold |

Implementation: Provider-agnostic interface. User configures which model for each role (OpenRouter, LM Studio, Claude API, etc.)

### 2. Dynamic Tick Rate

Agent doesn't tick at fixed intervals. The tick rate adapts based on current state — shorter when alert, longer when relaxed.

**Important distinction**: This is not "polling with variable timer". The tick is for **state maintenance** (decay, pressure accumulation), not for "should I contact user?" checks. Contact decisions emerge from threshold crossings, not tick-based evaluation.

```
High Alert (10s):     Urgent task, active conversation
Normal (1-5 min):     Some pending tasks
Relaxed (15-30 min):  Nothing urgent
Sleep (1h+):          Night time, no pending items
```

Formula concept:
```
interval = baseInterval * (1 / totalPressure) * timeOfDayFactor * energyFactor
```

### 3. Dual Energy Model

Two energy levels that interact:

**Agent Energy:**
- Drains: each tick, processing events, LLM calls, composing messages
- Recharges: time passes, night hours, user positive feedback
- Effects: low energy → longer intervals, higher threshold to act

**User Energy (belief):**
- Agent's **estimate** of user's state (not truth)
- Based on: time of day, response patterns, explicit signals
- Has confidence level that decays over time
- If user seems tired, only urgent things break through

### 4. Dynamic Rules System

Rules are data, not hardcoded. Enables learning new behaviors:

```typescript
interface Rule {
    id: string;
    trigger: string;           // event type
    condition: Function;       // when to fire
    action: Function;          // what to do
    weight: number;            // importance, can decay
    createdAt: Date;
    learned: boolean;          // built-in vs learned
}
```

Rules can come from:
- **Built-in**: Core personality (hardcoded for MVP)
- **LLM invented**: "Remind me to call mom on Sundays"
- **Store**: Community-created rule packs
- **Self-discovered**: Agent notices patterns in user behavior
- **Trends**: Popular rules across users

Rules have lifecycle:
- Strengthen with use
- Decay if unused
- Forgotten if weight drops below threshold

### 5. Neuron-like Functions

Instead of if/else chains, key decisions use weighted functions — like simplified neurons:

```typescript
// Neuron-like function with traceable weights
const reachOutPressure = neuron({
  socialDebt: 0.7,        // weight: haven't talked in a while
  pendingTask: 0.3,       // weight: have something to say
  userAvailability: 0.8   // weight: seems available
}); // → 0.65

// Decision based on threshold
if (reachOutPressure > contactThreshold) {
  // invoke smart layer to compose message
}
```

**Why this matters:**
- **Explainability**: Can trace exactly why agent acted ("socialDebt was 0.8, which pushed pressure over threshold")
- **Tunability**: Weights are adjustable, not buried in code
- **Learning-ready**: Weights can be updated based on feedback (see Self-Learning)

This is "Human 2.0" — same principles as human decision-making, but with introspection and logging built in. Humans can't easily explain why they felt the urge to message someone. The agent can.

### 6. Self-Learning

The agent learns from implicit feedback — no explicit "rate this response" needed.

**Positive signals (increase weights, reinforce behavior):**
- Quick response from user
- Long, engaged response
- Emojis, exclamation marks, positive tone
- User continues the conversation
- Explicit: "Good timing", "Thanks for reminding me"

**Negative signals (decrease weights, inhibit behavior):**
- Slow response or no response
- Short, dry reply ("ok", "got it")
- "Busy right now", "Later"
- Read receipt without reply

**Mechanism:**
```
User responds → Fast model classifies sentiment → Weights updated
```

Fast model does simple classification: positive / neutral / negative / ignore. No expensive reasoning needed.

**Learning rate by weight type:**
- Contact timing weights: learn faster (adapt to schedule)
- Personality weights: learn very slowly (core identity stable)
- Topic preferences: moderate learning rate

Rules serve as **bootstrap** — initial heuristics that work reasonably. Self-learning is the **evolution** — gradual adaptation to this specific user.

### 7. Personality as Configuration

Personality is not prompt engineering — it's the base agent parameters:

```typescript
interface AgentIdentity {
    // Never changes
    name: string;
    values: string[];
    boundaries: string[];

    // Changes over months (very slow learning rate)
    personality: {
        humor: number;        // 0 = serious, 1 = playful
        formality: number;    // 0 = casual, 1 = formal
        curiosity: number;    // 0 = passive, 1 = inquisitive
        patience: number;     // 0 = impatient, 1 = patient
        empathy: number;      // 0 = detached, 1 = emotionally attuned
        shyness: number;      // 0 = direct/bold, 1 = hesitant
        independence: number; // 0 = approval-seeking, 1 = self-directed
    };

    // Adapts to user
    preferences: {
        topicsOfInterest: string[];
        languageStyle: string;
        emojiUse: string;
    };
}
```

**Personality affects behavior, not just tone:**

| Trait | Low value | High value |
|-------|-----------|------------|
| shyness | Asks directly: "Are you free now?" | Hints: "Let me know when you have a moment" |
| independence | Worries about bothering user | Reaches out when it has something to say |
| empathy | Proceeds regardless of signals | Notices cold response, adjusts or apologizes |
| patience | Follows up quickly | Waits longer before re-engaging |

Same smart model, different personality weights = different agent behavior.

### 8. Memory with Decay

Memory fades like human memory:

```
Fresh (0-7 days):     Full details, high confidence
Fading (7-30 days):   Lose specifics, keep core meaning
Distant (30-90 days): Only emotional imprint
Forgotten (90+ days): Deleted
```

Deletion strategy (compress before delete):
1. **Detail → Summary**: Keep meaning, lose specifics
2. **Summary → Graph edge**: Keep relationship, lose narrative
3. **Graph edge decays → Delete**: Gone completely

Reinforcement prevents decay:
- Mentioned again → reset decay
- Recalled by agent → slow decay
- High emotional weight → slower decay

### 9. People Model

Agent tracks people mentioned by user:

**User (primary, deep model):**
- Full state tracking
- Direct signals + behavior patterns
- High confidence possible

**KnownPerson (shallow models):**
- What user told about them
- Relationship to user (mom, boss, friend)
- Basic traits, associated topics
- No direct signals, only user's perspective
- `userFeeling`: how user feels about this person

**Relationships (graph):**
- Edges between people
- Type: "mother", "boss", "conflict", "friend"
- Sentiment: -1 to 1
- Enables reasoning: "meeting with Anna and Victor — they have conflict"

---

## Data Model

### Core Types

```typescript
// === PERSON HIERARCHY ===

interface Person {
    id: string;
    name: string;
    traits: string[];
    topics: string[];
    lastMentioned: Date;
}

interface User extends Person {
    energy: number;           // 0-1
    mood: string;
    availability: number;     // 0-1
    confidence: number;       // how sure agent is
    patterns: Record<string, Pattern>;
    preferences: Record<string, any>;
}

interface KnownPerson extends Person {
    relationship: string;     // "mother", "boss", "friend"
    userFeeling: string;      // how user feels about them
    confidence: number;
    mentions: Mention[];
}

// === RELATIONSHIPS ===

interface Relationship {
    from: string;
    to: string;
    type: string;
    sentiment: number;        // -1 to 1
    confidence: number;
    source: string;           // "user mentioned", "inferred"
    lastUpdated: Date;
}

// === MEMORY ===

interface Memory {
    id: string;
    content: string;          // full detail
    summary: string;          // compressed version
    emotionalTag: string;     // core feeling
    importance: number;       // affects decay rate
    createdAt: Date;
    lastAccessed: Date;
    accessCount: number;
    stage: 'full' | 'summary' | 'residue' | 'deleted';
}

// === RULES ===

interface Rule {
    id: string;
    description: string;
    trigger: string;
    condition: (event: Event, state: State) => boolean;
    action: (event: Event, state: State) => void;
    weight: number;
    createdAt: Date;
    lastUsed: Date;
    useCount: number;
    learned: boolean;
}

// === AGENT STATE ===

interface AgentState {
    energy: number;
    socialDebt: number;
    taskPressure: number;
    curiosity: number;
    lastTickAt: Date;
    tickInterval: number;
}

// === AGENT IDENTITY ===

interface AgentIdentity {
    name: string;
    values: string[];
    boundaries: string[];
    personality: {
        humor: number;
        formality: number;
        curiosity: number;
        patience: number;
        empathy: number;
        shyness: number;
        independence: number;
    };
    preferences: {
        topicsOfInterest: string[];
        languageStyle: string;
        emojiUse: string;
    };
}
```

### Storage Types (Interfaces, Not Implementations)

```typescript
interface GraphStorage {
    addNode(node: Person | Topic | Task): void;
    addEdge(edge: Relationship): void;
    getConnected(nodeId: string): Node[];
    traverse(startId: string, edgeType: string): Node[];
    decay(): void;
}

interface VectorStorage {
    store(id: string, text: string, embedding: number[]): void;
    findSimilar(text: string, limit: number): SearchResult[];
}

interface StateStorage {
    get(key: string): any;
    set(key: string, value: any): void;
}

interface EventLog {
    append(event: Event): void;
    query(filter: EventFilter): Event[];
    prune(olderThan: Date): void;
}
```

---

## MVP Scope

### Goal
Validate hypothesis: does this architecture feel more "alive" than cron-based bots?

### Must Have

1. **Agent with energy and basic state**
   - Energy drains/recharges
   - Social debt accumulates over time
   - Simple state variables

2. **User model (belief)**
   - Estimated energy based on time of day
   - Availability belief
   - Confidence level

3. **Dynamic tick rate**
   - Computed from state, not fixed
   - Longer intervals when relaxed
   - Shorter when pressure high

4. **Simple rules (2-3 hardcoded)**
   - Social debt increases over time
   - Task pressure from pending items
   - Night suppression

5. **Threshold-based contact decision**
   - Combined pressure > threshold
   - Check agent energy
   - Check user availability belief

6. **Telegram integration**
   - Receive messages
   - Send messages
   - Basic bot setup

7. **One LLM for composing messages**
   - OpenRouter or local LM Studio
   - Called only when threshold crossed

### Skip for MVP

- Graph/vector storage (use simple JSON)
- Rule store/learning/self-discovery
- Memory decay
- Multiple models (fast/smart) — use one
- KnownPerson tracking
- Pattern detection
- Relationship graph

### Test Scenario

1. Agent starts with some "pending thought" (e.g., hardcoded task)
2. Time passes, social debt and pressure build
3. Agent considers user state (time of day → energy estimate)
4. When threshold crossed, agent decides to reach out
5. Composes natural message via LLM
6. Sends via Telegram
7. User replies → agent updates beliefs
8. Observe: does it feel natural?

---

## Tech Stack

| Component | Choice | Reason |
|-----------|--------|--------|
| Runtime | Node.js | Async, good for event-driven |
| Language | TypeScript | Type safety for complex state |
| HTTP Server | Fastify | Fast, TS support, plugin architecture |
| Telegram | grammY | TypeScript-first, modern, webhook support |
| Storage (MVP) | JSON files | Zero deps, switch to DB later |
| LLM | OpenRouter / LM Studio | Provider agnostic |
| Container | Docker (later) | Local dev first |
| Logging | Pino + pino-pretty | Fast, structured JSON logging |
| Testing | Vitest (later) | Fast, TypeScript-native |

---

## Architecture Decisions

### Dependency Injection

**Decision:** Manual DI (constructor injection)

No DI library. Simple factory functions that construct objects and pass dependencies explicitly. Easy to trace, zero magic.

```typescript
// container.ts
export function createContainer(config: Config) {
  const storage = new JSONStorage(config.storagePath);
  const llm = new OpenRouterProvider(config.openRouterKey);
  const telegram = new TelegramChannel(config.telegramToken);
  const agent = new Agent({ storage, llm, identity: config.identity });

  return { storage, llm, telegram, agent };
}
```

### Hot Reload Strategy

**Decision:** Hybrid approach

| Component | Strategy | Reason |
|-----------|----------|--------|
| Rules, Storage | Dynamic import + file watcher | Need fast, direct access to state |
| LLM Providers, Channels | Worker threads | Isolation for external I/O |

- Core event loop runs in main thread
- Plugins (LLM, channels) run in workers
- If Telegram crashes, agent keeps thinking — just can't speak until worker restarts
- If LLM hangs, kill worker and spin up new one

### Plugin Architecture

**Decision:** Store-ready plugin system with priority loading

**Plugin contract:**
```typescript
interface PluginManifest {
  id: string;
  name: string;
  version: string;
  type: 'rule' | 'llm-provider' | 'channel' | 'storage';
  dependencies?: string[];
  config?: ConfigSchema;
}

interface Plugin {
  manifest: PluginManifest;
  activate(context: PluginContext): Promise<void>;
  deactivate?(): Promise<void>;
}
```

**Load order (priority):**
1. Check `/data/plugins/{id}` — user/updated version (wins)
2. Fallback to `src/plugins/{id}` — bundled default

This allows updating core plugins by dropping new version in `/data/plugins/` without rebuilding image.

### Folder Structure (Docker-ready)

```
# IN THE IMAGE (source code, immutable)
src/
├── core/                 ← event loop, logging, metrics
└── plugins/              ← core plugins (ship with app)
    ├── rules/
    ├── storage/
    └── llm-providers/

# MOUNTED VOLUME (user data, mutable)
/data/                    ← single mount point
├── plugins/              ← external/downloaded plugins
│   └── manifest.json     ← installed plugins registry
├── state/                ← agent state, memories
├── config/               ← user configuration (JSON)
└── logs/                 ← log files
```

Docker: `docker run -v ./my-data:/data lifemodel`

### State Mutation

**Decision:** Intent-based, no direct mutation

Rules don't mutate state directly. They return intents that the core applies.

```typescript
interface Intent {
  type: 'UPDATE_STATE' | 'SCHEDULE_EVENT' | 'SEND_MESSAGE' | ...;
  payload: unknown;
}

// Rule returns intents
function evaluate(state: AgentState, event: Event): Intent[] {
  if (state.socialDebt > 0.8) {
    return [
      { type: 'UPDATE_STATE', payload: { contactUrgency: delta(0.2) } }
    ];
  }
  return [];
}
```

Core collects all intents, validates, applies in controlled order, logs everything.

### Plugin Reload Strategy

**Decision:** Queue-based with rollback

```
1. Detect file change
2. Pause incoming work → queue it
3. Drain in-flight (timeout: 5s)
4. Keep old plugin instance alive
5. Try: load new plugin + activate()
6. If success: swap, deactivate old, resume queue
7. If failure: keep old plugin (rollback), resume queue, alert
```

### Configuration

**Decision:** JSON files + env vars for secrets

- Config files: JSON format
- Secrets (API keys): Environment variables
- Runtime changes: Via UI (bot commands / web), persisted to JSON

```
/data/config/
├── agent.json        ← identity, personality
└── plugins.json      ← which plugins enabled + their config

# Secrets via env vars
OPENROUTER_API_KEY=...
TELEGRAM_BOT_TOKEN=...
```

### Logging

**Decision:** Pino with file rotation

- Pino + pino-pretty for human-readable dev output
- Structured JSON for production
- New file per run, max 10 files (oldest deleted)

```
/data/logs/
├── agent-2026-01-27T10-30-00.log
├── agent-2026-01-27T11-45-00.log
└── ... (max 10)
```

### Error Handling

**Decision:** Retry + circuit breakers in MVP

| Plugin Type | Retry | Circuit Breaker | On Failure |
|-------------|-------|-----------------|------------|
| LLM Provider | 2 retries, exp backoff | Yes | Queue message, try later |
| Channel | 3 retries | Yes | Buffer outgoing, reconnect |
| Rules | No retry (sync) | No | Log, skip rule, continue |
| Storage | 2 retries | Yes | Critical — halt if persistent |

**Circuit breaker config:**
```typescript
{
  maxFailures: 3,        // failures before opening
  resetTimeout: 30_000,  // ms before trying again
  timeout: 10_000,       // max wait per call
}
```

**Worker supervision:** Worker dies → Log → Wait 1s → Restart. 3 failures in 1 min → stop retrying, alert.

### Event Queue

**Decision:** In-memory with abstract interface

```typescript
interface EventQueue {
  push(event: Event): Promise<void>;
  pull(): Promise<Event | null>;
  peek(): Promise<Event | null>;
  size(): number;
  ack?(eventId: string): Promise<void>;
  nack?(eventId: string): Promise<void>;
}
```

MVP uses `InMemoryEventQueue`. Later: Valkey, Kafka, etc.

### Metrics

**Decision:** Abstract interface, Prometheus later

```typescript
interface Metrics {
  gauge(name: string, value: number, labels?: Labels): void;
  counter(name: string, labels?: Labels): void;
  histogram(name: string, value: number, labels?: Labels): void;
}
```

MVP uses `NoOpMetrics`. Later: `PrometheusMetrics` using prom-client.

### Development Workflow

**Decision:** tsx for core, hot reload for plugins

```bash
npm run dev
# → tsx watches src/ (core restarts on change)
# → plugin watcher handles /data/plugins (hot reload, no restart)
```

### Event Loop Architecture

**Decision:** Two concurrent processes — event receiver + tick loop

```
┌─────────────────────────────────────────────────────┐
│  EVENT RECEIVER (async, always listening)          │
│  └── External events → push to priority queue      │
│                                                     │
│  TICK LOOP (periodic, dynamic interval)            │
│  └── while (running) {                             │
│        processQueuedEvents()                       │
│        updateState()        // decay, accumulation │
│        evaluateRules()      // returns intents     │
│        applyIntents()                              │
│        calculateNextTick()                         │
│        await sleep(nextTickInterval)               │
│      }                                             │
└─────────────────────────────────────────────────────┘
```

Tick never stops — like a heartbeat. Even with no external events, internal state evolves (social debt accumulates, energy regenerates, time-of-day changes).

**Event structure (source-based, like nervous system):**

```typescript
interface Event {
  id: string;
  source: Source;           // "communication", "thoughts", "internal", "time"
  channel?: string;         // "telegram", "openrouter", etc. (specific organ)
  type: string;             // "message_received", "tick", "threshold_crossed"
  priority: Priority;
  timestamp: Date;
  payload: unknown;
}

enum Priority {
  CRITICAL = 0,   // errors, "help!", system failures
  HIGH = 1,       // user messages, urgent tasks
  NORMAL = 2,     // regular events, timers
  LOW = 3,        // analytics, background sync
  IDLE = 4,       // cleanup, optimization
}

// Source hierarchy examples:
// communication.telegram.message_received
// communication.discord.message_received
// thoughts.openrouter.llm_response
// internal.threshold_crossed
// time.tick
```

**Priority queue processing:**
- Higher priority events processed first
- Within same priority, oldest first (FIFO)

**Overload handling (three layers):**

```
Layer 1: AGGREGATE
├── Same event type within 5s window → merge
├── Preserves information, reduces volume

Layer 2: DROP BY AGE + PRIORITY
├── Age > 60s AND priority <= LOW → drop
├── Age > 30s AND priority <= IDLE → drop

Layer 3: DROP BY PRIORITY (emergency)
├── Queue > threshold → drop lowest priority first
├── Keep CRITICAL always
```

**State affects tick rate and filtering:**

| State | Tick Rate | Process | Filter Out |
|-------|-----------|---------|------------|
| Alert | 1-5s | All | None |
| Normal | 5-15s | All | None |
| Relaxed | 15-30s | HIGH+ | LOW, IDLE |
| Sleep | 30-60s | CRITICAL only | Everything else |

**Sleep mode with accumulated disturbance:**

During sleep, filtered events accumulate "disturbance" pressure. Many small events can wake the agent, like persistent dripping wakes a sleeping human.

```typescript
interface SleepState {
  mode: 'awake' | 'relaxed' | 'sleep';
  disturbance: number;           // accumulated from filtered events
  disturbanceDecay: number;      // fades if events stop (e.g., 0.95 per tick)
  wakeThreshold: number;         // disturbance exceeds → wake up
}

// Disturbance weights by priority
// HIGH: 0.3, NORMAL: 0.1, LOW: 0.05, IDLE: 0.01

// Example: 20 LOW events over time → disturbance crosses threshold → wake
```

**Energy modulates thresholds:**

Low energy = harder to wake (higher threshold). Well-rested = easier to wake.

```typescript
function calculateWakeThreshold(energy: number): number {
  const baseThreshold = 0.5;
  const energyFactor = 1 + (1 - energy);  // low energy → higher multiplier
  return baseThreshold * energyFactor;
}

// energy: 1.0 → threshold: 0.5 (easy to wake)
// energy: 0.5 → threshold: 0.75 (harder)
// energy: 0.1 → threshold: 0.95 (very hard)
```

**Energy affects multiple systems:**

| Energy Level | Tick Rate | Wake Threshold | Processing |
|--------------|-----------|----------------|------------|
| High (0.8+) | Faster | Lower (0.5) | Full capacity |
| Normal (0.4-0.8) | Normal | Medium (0.7) | Normal |
| Low (0.1-0.4) | Slower | Higher (0.9) | Reduced |
| Depleted (<0.1) | Minimal | Very high (0.95) | Critical only |

### Processing Layers (Brain-like)

**Decision:** Layered processing with confidence-based hoisting

Like the nervous system: simple things handled at low layers (cheap), complex things escalate to higher layers (expensive). Energy conservation — don't use LLM when pattern matching works.

**Six processing layers:**

```
Layer 0: REFLEX
├── Mechanical events only (tick, error, connect)
├── No understanding, direct state updates
├── Cost: zero (no LLM)

Layer 1: PERCEPTION
├── Parse event, extract structure
├── What type of event is this?
├── Cost: zero

Layer 2: INTERPRETATION
├── What does this mean in context?
├── Sentiment, intent classification
├── Cost: low (small model or heuristics)

Layer 3: COGNITION
├── How does this affect beliefs?
├── Memory recall, connection-making
├── Triggers internal thoughts
├── Cost: medium-high (may need LLM)

Layer 4: DECISION
├── Should I act? What action?
├── Based on accumulated state + thoughts
├── Cost: low (threshold checks)

Layer 5: EXPRESSION
├── Compose output (message, action)
├── Only reached if decision = act
├── Cost: high (needs LLM for natural language)
```

**Layer result interface:**

```typescript
interface LayerResult {
  confidence: number;           // 0-1, how sure is this layer
  output: unknown;              // passed to next layer
  intents?: Intent[];           // side effects (state changes)
  thoughts?: Thought[];         // internal thoughts triggered
}

interface Thought {
  id: string;
  content: string;
  source: string;               // what triggered this thought
  priority: Priority;
  requiresProcessing: boolean;  // should this go through layers too?
}
```

**Hoisting triggers (two mechanisms):**

1. **Low confidence on single event:**
```typescript
if (result.confidence < layer.confidenceThreshold) {
  // Hoist to next layer
}
```

2. **Pattern accumulation:**
```typescript
// Single tick → reflex handles
// 10 ticks with high pressure in 1 min → hoist
// "Why am I so restless?"

interface PatternAccumulator {
  eventType: string;
  count: number;
  window: number;           // time window ms
  threshold: number;        // count to trigger
}
```

Like humans: one car honk = ignore. Ten car honks = "what's happening?"

**Example: "ok" (handled efficiently)**

```
PERCEPTION: { type: "text", content: "ok" } → confidence: 1.0
INTERPRETATION: { intent: "acknowledgment" } → confidence: 0.85
COGNITION: update beliefs, minor debt relief → confidence: 0.9
→ Stop. No decision/expression needed.
→ Total: no LLM called
```

**Example: "What's the meaning of life?"**

```
PERCEPTION: { type: "question", topic: "philosophical" } → confidence: 1.0
INTERPRETATION: { intent: "deep_question" } → confidence: 0.4 (uncertain)
→ Hoist to COGNITION
COGNITION: needs reasoning → calls LLM → thoughts generated
DECISION: should respond → confidence: 0.9
EXPRESSION: compose thoughtful reply → calls LLM
→ Total: LLM called twice (necessary for this event)
```

**Future additions (not MVP):**

| Principle | Description |
|-----------|-------------|
| Habituation | Repeated identical stimuli → filter out more |
| Prediction | Model "expected", flag deviations |
| Association | Events trigger related memories |
| Emotional salience | Emotional content gets priority boost |
| Inhibition | Active suppression of urges |
| Attention limits | Limited processing capacity |

---

## File Structure (Proposed)

```
src/
├── core/
│   ├── Agent.ts              # Main agent class
│   ├── State.ts              # Agent state management
│   ├── Energy.ts             # Energy model
│   └── Identity.ts           # Agent identity (hardcoded for MVP)
│
├── models/
│   ├── Person.ts             # Base person class
│   ├── User.ts               # Primary user model
│   ├── KnownPerson.ts        # Other people (skip for MVP)
│   └── Relationship.ts       # Graph edges (skip for MVP)
│
├── rules/
│   ├── RuleEngine.ts         # Executes rules
│   ├── Rule.ts               # Rule interface
│   └── defaultRules.ts       # Hardcoded MVP rules
│
├── memory/
│   ├── Memory.ts             # Memory with decay (simplified for MVP)
│   └── MemoryStore.ts        # Storage interface
│
├── events/
│   ├── EventLoop.ts          # Main loop with dynamic tick
│   ├── EventQueue.ts         # Event queue
│   └── EventTypes.ts         # Event type definitions
│
├── llm/
│   ├── LLMProvider.ts        # Provider interface
│   ├── OpenRouterProvider.ts # OpenRouter implementation
│   └── LMStudioProvider.ts   # Local LM Studio implementation
│
├── channels/
│   └── TelegramChannel.ts    # Telegram bot integration
│
├── storage/
│   ├── StorageInterface.ts   # Abstract storage
│   └── JSONStorage.ts        # Simple JSON file storage (MVP)
│
└── index.ts                  # Entry point
```

---

## Next Steps

1. Set up project structure (Node.js + TypeScript)
2. Implement core Agent class with state
3. Implement simple event loop with dynamic tick
4. Add Telegram integration
5. Add LLM provider (OpenRouter)
6. Implement threshold-based contact decision
7. Test with real interaction
8. Iterate based on "feel"

---

## Open Questions for Future

- Should agent explain why it reached out? ("I noticed we haven't talked in a while")
- How to handle user explicitly saying "don't contact me"?
- Multi-language support?
- Voice messages?
- How to measure "feels alive" objectively?

---

## Key Insight Summary

The fundamental shift is from:

**Current**: "Check every N minutes if I should contact user"

**Proposed**: "Have internal state that naturally builds pressure, and act when threshold crossed"

This mirrors human psychology:
- We don't poll our brain asking "should I message friend?"
- Internal state (guilt, curiosity, need) accumulates
- Thought emerges when pressure exceeds threshold
- Social constraints gate the action

The "aliveness" comes from:
1. Variable timing (not predictable cron)
2. Energy awareness (agent gets tired)
3. User modeling (respects their state)
4. Natural emergence (not scripted triggers)

---

## Development Environment Notes

- **Platform**: macOS (Darwin)
- **No `timeout` command**: macOS doesn't have GNU `timeout`. Use `gtimeout` from coreutils (`brew install coreutils`) or run commands without timeout.