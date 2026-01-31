# News Plugin v2 - Brain-Inspired Architecture

## Overview

A news monitoring system that processes articles like the human brain processes sensory input - through layers that filter, prioritize, and surface relevant information naturally.

**Core Value**: User never misses important news, but isn't overwhelmed by noise.

**Key Insight**: News articles flow through brain layers as signals, not batch dumps to COGNITION.

---

## Architecture: News as Sensory Input

```
┌─────────────────────────────────────────────────────────────────────────┐
│  News Plugin fetches articles                                           │
│       ↓                                                                 │
│  Emits plugin_event signal (eventKind: 'news:article_batch')            │
│       ↓                                                                 │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │  AUTONOMIC LAYER                                               │     │
│  │                                                                │     │
│  │  NewsSignalFilter (configured via tick context):               │     │
│  │    • Calculates interest score (do I care?)                    │     │
│  │    • Calculates urgency score (interrupt now?)                 │     │
│  │    • URGENT (urgency > 0.8) → immediate flag                   │     │
│  │    • INTERESTING (interest 0.4-0.8) → queue flag               │     │
│  │    • NOISE (interest < 0.4) → filtered (topic stored briefly)  │     │
│  │                                                                │     │
│  └────────────────────────────────────────────────────────────────┘     │
│       ↓                                                                 │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │  AGGREGATION LAYER                                             │     │
│  │                                                                │     │
│  │  • Groups related articles ("3 crypto articles today")         │     │
│  │  • Rate limiting (max 1 urgent per topic per 30 min)           │     │
│  │  • URGENT articles → wake COGNITION immediately                │     │
│  │  • INTERESTING articles → add to share queue in AgentState     │     │
│  │                                                                │     │
│  └────────────────────────────────────────────────────────────────┘     │
│       ↓                                                                 │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │  COGNITION (wakes for urgent OR during proactive contact)      │     │
│  │                                                                │     │
│  │  • Decides HOW to share (wording, timing)                      │     │
│  │  • Saves important articles to core memory                     │     │
│  │  • Learns from EXPLICIT user reactions → updates weights       │     │
│  │  • Handles "what did I miss?" queries                          │     │
│  │                                                                │     │
│  └────────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Signal Type

Use existing `plugin_event` signal type (no core type changes needed):

```typescript
{
  type: 'plugin_event',
  source: 'plugin.news',
  data: {
    kind: 'plugin_event',
    eventKind: 'news:article_batch',
    pluginId: 'news',
    payload: {
      articles: NewsArticle[],
      sourceId: string,
      fetchedAt: Date,
    }
  }
}

interface NewsArticle {
  id: string;
  title: string;
  source: string;
  topics: string[];        // Extracted keywords/topics
  url?: string;
  summary?: string;
  publishedAt?: Date;
  hasBreakingPattern: boolean;  // Contains "BREAKING", "URGENT", etc.
}
```

---

## Scoring: Interest vs Urgency (Independent)

Two separate scores, computed independently:

### Interest Score: "Do I care about this?"

```
interestScore =
    topicMatch × topicWeight × 0.5 +
    sourceReputation × 0.2 +
    noveltyBonus × 0.3
```

| Component | Description | Range |
|-----------|-------------|-------|
| **topicMatch** | Best matching topic from user interests | 0-1 |
| **topicWeight** | Learned weight for matched topic | 0-1 |
| **sourceReputation** | Trust in the source (default 0.5) | 0-1 |
| **noveltyBonus** | First time seeing this topic? | 0 or 0.3 |

### Urgency Score: "Should I interrupt NOW?"

```
urgencyScore =
    breakingBonus × 2.0 +
    volumeAnomaly × 1.5 +
    (interestScore × topicUrgencyWeight)
```

| Component | Description | Range |
|-----------|-------------|-------|
| **breakingBonus** | Contains urgent patterns | 0 or 0.3 |
| **volumeAnomaly** | Unusual article volume (Weber-Fechner) | 0-1 |
| **topicUrgencyWeight** | Per-topic urgency multiplier | 0-1 |

### Classification Thresholds

| Interest | Urgency | Classification | Action |
|----------|---------|----------------|--------|
| any | > 0.8 | URGENT | Wake COGNITION immediately (rate limited) |
| 0.4 - 1.0 | ≤ 0.8 | INTERESTING | Add to share queue |
| < 0.4 | any | NOISE | Filter out, store topic briefly |

---

## NewsSignalFilter (Not a Neuron)

**Important**: This is a signal processor/filter, not a neuron. Neurons generate signals from state; this component filters incoming signals.

```typescript
// Located in: src/layers/autonomic/filters/news-signal-filter.ts

interface NewsSignalFilter {
  /**
   * Process news batch signal and classify articles.
   *
   * @param signal - The plugin_event signal with news:article_batch
   * @param config - News interests from user model (passed via tick context)
   * @returns Classified articles with scores
   */
  process(
    signal: Signal,
    config: NewsInterests
  ): {
    urgent: ScoredArticle[];
    interesting: ScoredArticle[];
    filtered: FilteredTopic[];
  };
}

interface ScoredArticle {
  article: NewsArticle;
  interestScore: number;
  urgencyScore: number;
}

interface FilteredTopic {
  topic: string;
  timestamp: Date;
}
```

---

## Configuration: Direct UserModel Injection ✅

**Implementation Decision**: Instead of passing interests as tick parameters, we inject `userModel` directly into the autonomic processor. This is cleaner and more extensible.

```typescript
// In container.ts (one-time setup)
layers.autonomic.setUserModel(userModel);

// In FilterContext (available to all filters)
interface FilterContext {
  state: AgentState;
  alertness: number;
  correlationId: string;
  userModel: FilterUserModel | null;  // Direct access
}

// FilterUserModel is a minimal interface
interface FilterUserModel {
  getInterests(): Interests | null;
}

// In NewsSignalFilter
const interests = context.userModel?.getInterests() ?? null;
```

**Benefits over tick-based approach:**
- Single wiring point (container setup, not every tick)
- Interface segregation (filters see `FilterUserModel`, not full `UserModel`)
- Extensible (add methods to interface without changing tick signature)

---

## User Model: Interest Storage ✅

**Implementation Decision**: Renamed `NewsInterests` → `Interests` and moved to `src/types/user/interests.ts`. This is generic user model data, not news-specific. Any plugin can use it.

```typescript
// Located in: src/types/user/interests.ts
interface Interests {
  // Topic weights (learned) - weight > 0 means interested
  // weight === 0 means suppressed/blocked
  weights: Record<string, number>;

  // Per-topic urgency multiplier (when to interrupt)
  urgency: Record<string, number>;

  // Source reputation (optional, default 0.5)
  sourceReputation?: Record<string, number>;

  // Topic baselines for volume anomaly detection
  topicBaselines: Record<string, {
    avgVolume: number;
    lastUpdated: Date;
  }>;
}

// UserModel methods:
userModel.getInterests(): Interests | null;
userModel.updateInterests(updates: Partial<Interests>): void;
userModel.setTopicWeight(topic: string, weight: number): void;
userModel.setTopicUrgency(topic: string, urgency: number): void;

// Example:
interests: {
  weights: {
    crypto: 0.9,
    AI: 0.85,
    programming: 0.7,
    celebrity: 0,      // suppressed (weight = 0)
  },
  urgency: {
    crypto: 0.9,       // always tell immediately
    AI: 0.3,           // can wait
  },
  topicBaselines: {
    crypto: { avgVolume: 5, lastUpdated: "2026-01-30" },
  }
}
```

**Note**: No separate `allow`/`block` lists needed. Weight > 0 = allowed, weight = 0 = blocked.

---

## Rate Limiting (Aggregation Layer)

Prevent urgent notification spam:

```typescript
interface UrgentDeliveryTracker {
  recentDeliveries: Map<string, Date>;  // topic → lastDeliveredAt

  canDeliverUrgent(topic: string): boolean {
    const last = this.recentDeliveries.get(topic);
    if (!last) return true;

    const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
    return last.getTime() < thirtyMinutesAgo;
  }
}

// Exception: urgencyScore > 0.95 bypasses rate limit (true emergency)
```

---

## Interesting News → Facts in Memory ✅

**Implementation Decision**: No ShareQueue. Interesting articles become **facts** in memory.

**Biological rationale:**
- The brain doesn't have a "share queue" - it has memory
- When you read something interesting, you remember the **fact**, not the article
- Later, during conversation, relevant facts surface naturally via memory retrieval

**Signal flow:**
```
news:interesting articles
         ↓
NewsSignalFilter transforms ScoredArticle → Fact (generic type)
         ↓
Emits signal with FactBatchData { kind: 'fact_batch', facts: Fact[] }
         ↓
Aggregation layer saves to memory as type='fact'
         ↓
Later: COGNITION searches memory during proactive contact
```

**Types (in core - plugin-agnostic):**
```typescript
// src/types/signal.ts
interface Fact {
  content: string;      // "Bitcoin dropped 15%" - what the brain remembers
  confidence: number;   // Interest score → memory confidence
  tags: string[];       // Topics → retrieval tags
  provenance: {
    source: string;
    url?: string;
    originalId?: string;
    timestamp?: Date;
  };
}

interface FactBatchData {
  kind: 'fact_batch';
  pluginId: string;
  eventKind: string;  // For logging, e.g., 'news:interesting'
  facts: Fact[];
}
```

**Plugin transforms its own types:**
```typescript
// In NewsSignalFilter (plugin code)
private toFact(scored: ScoredArticle, sourceId: string): Fact {
  return {
    content: scored.article.title,  // The fact
    confidence: scored.interestScore,
    tags: ['news', ...scored.article.topics],
    provenance: { source: sourceId, url: scored.article.url, ... }
  };
}
```

**Key benefit**: Core never imports plugin types. Plugin transforms ScoredArticle → Fact internally.

---

## Filtered Topics Storage (Brief)

Store topics of filtered articles for learning (when user mentions them later).

```typescript
// In autonomic layer state (in-memory)
filteredTopics: Map<string, {
  topic: string;
  firstSeen: Date;
  lastSeen: Date;
  count: number;
  mentionDetected: boolean;
}>;

// Cleanup: Remove topics older than 48 hours where mentionDetected === false
// Purpose: If user mentions a filtered topic, we can boost its weight
```

---

## Source Health Monitoring

Track source reliability in plugin storage:

```typescript
// In plugin storage: plugin:news:source-health.json
interface SourceHealth {
  [sourceId: string]: {
    consecutiveFailures: number;
    lastSuccess: Date | null;
    lastFailure: Date | null;
    disabledUntil: Date | null;  // Temporary disable after N failures
  };
}

// Policy:
// - 3 consecutive failures → disable for 1 hour
// - 5 consecutive failures → disable for 6 hours
// - 10 consecutive failures → emit thought to inform user
```

---

## Learning Loop

### Phase 1: Explicit Reactions Only

Start simple - only learn from clear user statements:

**Positive signals** (increase weight):
- "I like crypto news"
- "Tell me more about AI articles"
- "Keep sending me programming stuff"

**Negative signals** (decrease weight or set to 0):
- "I don't care about this"
- "Stop sending celebrity news"
- "I'm not interested in sports"

**Important**: Silence/ignoring is NOT treated as negative feedback (too ambiguous).

### Phase 2: Filtered Topic Discovery (Future)

When user mentions a previously filtered topic:

```
Day 1: Article about quantum computing → filtered (low interest)
       Store: { topic: "quantum_computing", ... }

Day 2: User mentions "quantum computing" in conversation
       System detects topic match!

       Options:
       A) Silently increase weight
       B) "I actually saw something about quantum computing
           yesterday. Want me to watch for that topic?"
```

### Phase 3: Implicit Learning (Future)

More sophisticated reaction detection:
- Follow-up questions = positive
- Engagement duration = positive
- Changing topic immediately = neutral (not negative)

---

## Cold Start Handling

### Option A: Bonuses Only (Simple)

With no learned preferences, rely on:
- **noveltyBonus** - catches first-time topics
- **breakingBonus** - catches urgent patterns
- **volumeAnomaly** - catches big events (once baseline exists)

**Limitation**: Day 1 everything is "novel", could surface irrelevant content.

### Option B: Explicit Onboarding (Recommended)

COGNITION can proactively ask on first news source add:

```
Agent: "What topics interest you most? For example:
        - Technology & programming
        - Finance & crypto
        - Science & research
        - Politics & current events
        - Sports
        Just tell me what you'd like to follow!"
```

Store responses as initial weights.

### Option C: Observation Period (Conservative)

First 48-72 hours: observe only, no proactive notifications.
- Build topic baselines
- Let patterns emerge
- Then start notifications with better calibration

---

## Delivery Mechanisms

### Urgent News (Interrupt)

```
Urgent article detected (urgencyScore > 0.8)
      ↓
Rate limit check (max 1 per topic per 30 min)
      ↓
COGNITION wakes immediately
      ↓
Evaluates: Is user available? Is it really urgent?
      ↓
SEND_MESSAGE: "🚨 Bitcoin dropped 15%! Given your interest in crypto..."
```

### Interesting News (Opportunistic)

```
Interesting article detected (interestScore 0.4-0.8)
      ↓
Added to share queue in AgentState
      ↓
Later: proactive contact fires (social debt) OR user messages
      ↓
COGNITION sees: "You have 3 items in share queue"
      ↓
Weaves naturally: "Hey! How are you? By the way, saw something
                   interesting about AI research..."
```

### On-Demand ("What did I miss?")

```
User: "What news did I miss?"
      ↓
COGNITION searches core memory for saved articles
      ↓
Also checks share queue for unmentioned items
      ↓
Summarizes and responds
```

---

## Storage Responsibilities (SRP)

| Storage | Owner | Contents |
|---------|-------|----------|
| **Plugin storage** | News plugin | Source configs, fetch state, source health |
| **User model** | Core | Interest weights, urgency weights, topic baselines |
| **Core memory** | COGNITION | Saved articles (user asked to remember) |
| **AgentState** | Core | Share queue (in-memory, not persisted) |
| **Autonomic state** | Autonomic | Filtered topics (in-memory, 48h decay) |

---

## Out of Scope

| Request | Response |
|---------|----------|
| "Search for news about X" | Web search plugin (different responsibility) |
| Filtered article content | Gone - only topics stored briefly for learning |
| Per-source fetch frequency | Future enhancement |
| Private Telegram channels | Phase 2+ |

---

## Implementation Phases

### Phase 0: Infrastructure ✅ COMPLETE

**0.1 Signal handling for news batches**
- [x] Define `NewsArticle` interface in `src/types/news.ts`
- [x] Update news plugin to emit `plugin_event` with `eventKind: 'news:article_batch'`

**0.2 User model schema**
- [x] Add `Interests` interface (renamed from NewsInterests) in `src/types/user/interests.ts`
- [x] Add `interests` field to User type
- [x] Add `getInterests()`, `updateInterests()` methods to UserModel

**0.3 FilterContext with UserModel** (revised approach)
- [x] Create `FilterUserModel` interface in `src/layers/autonomic/filter-registry.ts`
- [x] Add `userModel` to `FilterContext`
- [x] Wire via `layers.autonomic.setUserModel(userModel)` in container

### Phase 1: NewsSignalFilter ✅ COMPLETE

- [x] Create `FilterRegistry` in `src/layers/autonomic/filter-registry.ts`
- [x] Create `NewsSignalFilter` in `src/plugins/news/news-signal-filter.ts`
- [x] Implement interest scoring algorithm
- [x] Implement urgency scoring algorithm
- [x] Signal transformation: `news:article_batch` → `news:urgent_articles` / `news:interesting_articles`
- [x] Novelty tracking (seenTopics set)
- [ ] Filtered topic storage (in-memory, 48h decay) - deferred to Phase 5

### Phase 2: Aggregation Layer Updates (IN PROGRESS)

- [ ] **Fix ThresholdEngine** - Only wake for `news:urgent_articles`, not interesting
- [ ] Create `ShareQueue` class in `src/layers/aggregation/share-queue.ts`
- [ ] Integrate ShareQueue into AggregationProcessor
- [ ] Add rate limiting for urgent notifications (max 1/topic/30min)
- [ ] Article grouping logic ("3 crypto articles")
- [ ] Integration tests

### Phase 3: News Plugin Simplification

- [x] Emit structured `plugin_event` signals (done in Phase 0)
- [ ] Add source health monitoring
- [ ] Register event schemas for validation

### Phase 4: COGNITION Integration (3-4 days)

- [ ] Handle urgent news wake (decide wording, send)
- [ ] Handle share queue during proactive contact
- [ ] Save important articles to core memory
- [ ] "What did I miss?" query handling
- [ ] Cold start onboarding prompt

### Phase 5: Learning Loop (3-4 days)

- [ ] Detect explicit preference statements
- [ ] Update weights in user model via intent
- [ ] Filtered topic mention detection
- [ ] "I saw something about X" response
- [ ] Integration tests for learning

### Phase 6: Telegram Channels (Future)

- [ ] Telegram public channel fetcher
- [ ] Message pagination/history
- [ ] Rate limiting

**Total estimate**: 17-22 days

---

## Files to Create/Modify

### New Files

| File | Purpose | Status |
|------|---------|--------|
| `src/types/user/interests.ts` | Generic `Interests` interface | ✅ Done |
| `src/layers/autonomic/filter-registry.ts` | FilterRegistry, FilterContext, SignalFilter | ✅ Done |
| `src/plugins/news/news-signal-filter.ts` | NewsSignalFilter implementation | ✅ Done |

### Modified Files

| File | Change | Status |
|------|--------|--------|
| `src/types/signal.ts` | Add `Fact`, `FactBatchData` interfaces | ✅ Done |
| `src/types/news.ts` | NewsArticle, NewsArticleBatchPayload | ✅ Done |
| `src/types/user/user.ts` | Add `interests` field | ✅ Done |
| `src/models/user-model.ts` | Add `getInterests()`, `updateInterests()` methods | ✅ Done |
| `src/layers/autonomic/processor.ts` | Add setUserModel(), filter integration | ✅ Done |
| `src/layers/autonomic/index.ts` | Export filter types | ✅ Done |
| `src/core/container.ts` | Wire userModel to autonomic layer | ✅ Done |
| `src/plugins/news/index.ts` | Emit structured signals, FilterPluginV2 | ✅ Done |
| `src/layers/aggregation/threshold-engine.ts` | Handle fact_batch signals, filter urgent news | ✅ Done |
| `src/layers/aggregation/processor.ts` | Save facts to memory, rate limiting | In Progress |

---

## Key Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Signal type | `plugin_event` / `fact_batch` | Facts use generic FactBatchData, urgent uses PluginEventData |
| Component name | NewsSignalFilter | It filters signals, not generates them |
| Config mechanism | **Direct UserModel injection** | Single wiring point, interface segregation, extensible |
| Interest type | **`Interests` (generic)** | Renamed from NewsInterests - any plugin can use |
| Interest vs Urgency | Separate scores | Different questions, different answers |
| User model | Weights only (no allow list) | weight > 0 = allowed, simpler |
| Interesting news | **Facts in memory** | Brain stores facts, not queues. Natural retrieval via memory search |
| Generic fact type | **`Fact` interface in core** | Plugin transforms ScoredArticle → Fact. Core never imports plugin types |
| Rate limiting | Max 1 urgent/topic/30min | Prevent notification spam |
| Learning (Phase 1) | Explicit reactions only | Implicit is too ambiguous |
| Cold start | Explicit onboarding recommended | Bonuses alone insufficient |

---

## Verification Checklist

- [x] NewsSignalFilter correctly scores articles
- [x] Interest and urgency scores computed independently
- [ ] Rate limiting prevents urgent spam
- [x] Interesting articles transformed to generic Fact type
- [x] Facts saved to memory (not a queue)
- [ ] Memory search retrieves recent news facts
- [ ] Filtered topics decay after 48h
- [ ] Source health disables failing sources
- [ ] COGNITION wakes for urgent articles
- [ ] Share queue surfaced during proactive contact
- [ ] "What did I miss?" searches memory + queue
- [ ] Explicit reactions update weights
- [ ] Cold start onboarding works
