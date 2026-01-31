# News Plugin Specification

## Overview

A plugin that monitors news sources (Telegram channels, RSS feeds) on behalf of the user, filters by importance, and either:
- **Proactively contacts** the user for urgent/important news
- **Remembers** less important news to share when asked

**Core Value**: User never misses important news, but isn't overwhelmed by information noise.

---

## Architectural Principles

**Plugin Isolation:**
- Plugin interacts with core ONLY via `PluginPrimitives` API
- No direct imports from core modules
- No knowledge of other plugins
- If API is lacking → extend API, don't work around it
- No backward compatibility hacks or fallbacks

---

## Architecture Fit

This plugin uses existing mechanisms - no new neurons or signal types needed:

| Concept | News Plugin Application |
|---------|------------------------|
| **Scheduler** | Periodic feed checks (every 2 hours) |
| **Thought signal** | After fetching, create thought to trigger COGNITION |
| **Cognition** | LLM evaluates importance based on learned preferences |
| **Memory** | Not important → `core.remember` for later |
| **Proactive contact** | Very important → `SEND_MESSAGE` immediately |

### Key Insight: Use Existing Thought Mechanism

**Why thoughts?**
- `thought` signals already bypass the energy gate and wake COGNITION immediately
- No new signal types, no new neurons needed
- LLM is best suited to evaluate importance contextually
- Keeps architecture simple

```
┌─────────────────────────────────────────────────────────────────┐
│  Scheduler fires every 2 hours                                  │
│       ↓                                                         │
│  News plugin fetches from all sources                           │
│       ↓                                                         │
│  Creates THOUGHT signal: "I fetched N new articles, here they   │
│  are: [summaries]. I should evaluate their importance."         │
│       ↓                                                         │
│  Thought signal wakes COGNITION (bypasses energy gate)          │
│       ↓                                                         │
│  LLM evaluates each article:                                    │
│    • Not important → core.remember (save for "what did I miss") │
│    • Very important → SEND_MESSAGE (proactive notification)     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. SCHEDULER fires every 2 hours                                │
│    → 'news:poll_feeds' plugin event                             │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│ 2. News Plugin onEvent() handler                                 │
│    → Fetch RSS feeds (standard HTTP)                             │
│    → Fetch Telegram channels (Telegram API)                      │
│    → Compare against lastSeenId per source                       │
│    → If new articles found:                                      │
│        → Emit THOUGHT signal with article summaries              │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│ 3. THOUGHT signal bypasses energy gate                           │
│    → Wakes COGNITION immediately                                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│ 4. COGNITION LAYER (LLM)                                         │
│    → Receives thought: "New articles fetched: [summaries]"       │
│    → Evaluates each article against learned user interests       │
│    → For IMPORTANT: SEND_MESSAGE → proactive notification        │
│    → For INTERESTING: core.remember → save for later             │
│    → For NOISE: no_action → discard                              │
│    → Can DEFER if user seems busy (will retry later)             │
└─────────────────────────────────────────────────────────────────┘

Alternative path (user asks for news):
┌─────────────────────────────────────────────────────────────────┐
│ User: "What news did I miss?"                                    │
│    → COGNITION searches its own memory (core.memory)             │
│    → Retrieves remembered news summaries                         │
│    → Summarizes and responds                                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Design Decisions

### 1. Self-Learning Importance Model

The agent learns what's important through interaction, not pre-defined rules:

**Cold Start (knows nothing about user):**
- Agent uses its own judgment to suggest potentially interesting news
- Casts a wider net initially, shares more to learn preferences
- Can proactively ask: "I noticed several AI articles today. Is AI a topic you'd like me to track?"

**Learning Loop:**
```
Agent shares news → User reacts → Agent updates model

Positive signals:
- User asks follow-up questions
- User says "tell me more"
- User engages with the topic

Negative signals:
- "I don't care about this"
- "Stop sending me [topic] news"
- User ignores/dismisses
- "This isn't important"
```

**Storage of learned preferences:**
- Use existing `core.remember` with structured facts
- `{ subject: "user", predicate: "interested_in", object: "AI", confidence: 0.85 }`
- `{ subject: "user", predicate: "not_interested_in", object: "celebrity_gossip", confidence: 0.95 }`
- Confidence increases/decreases with repeated signals

### 2. Urgency Determination

Agent judges urgency based on:
- **Time-sensitivity**: Is this happening NOW? Will it be irrelevant in hours?
- **Learned high-interest topics**: Topics user has strongly engaged with before
- **User availability**: Don't interrupt if user is busy/sleeping (existing energy system)
- **News severity**: Major events vs routine updates

### 3. Deferral Handling

If user is busy and COGNITION defers:
- COGNITION saves article summaries to memory via `core.remember` before deferring
- Articles are retrieved later via `core.memory` when user asks "what did I miss?" or when COGNITION retries

### 4. Self-Learning (Topic-Level)

Learning is at **topic level**, not individual article tracking:
- Positive engagement → `{ subject: "user", predicate: "interested_in", object: "crypto", confidence: +0.1 }`
- Negative feedback → `{ subject: "user", predicate: "not_interested_in", object: "celebrity", confidence: 0.9 }`
- COGNITION retrieves preferences via `core.memory` tool when evaluating news (not injected)

**Cold start**: No special mode. COGNITION checks memory for preferences, finds none, and can decide to ask user about their interests before sharing news. All decision-making stays in COGNITION.

### 5. Batching by Character Count

Articles are batched by **character count**, not quantity:
- Split into thoughts when batch exceeds ~4000 characters
- Ensures consistent thought size regardless of article summary length
- Handles variable-length content better than fixed article counts

### 6. Error Handling

- **Transient failures**: Silent retry with exponential backoff (max 3 attempts per fetch)
- **Persistent failures**: Track failure count per source. After N consecutive failed fetches, emit thought to inform user about broken source

### 7. Security

**URL Validation (SSRF Protection):**
- Only allow public IP addresses (block private ranges: 10.x.x.x, 192.168.x.x, 172.16-31.x.x, localhost)
- Block cloud metadata endpoints (169.254.169.254)
- Only allow http/https protocols (block file://, javascript:, data:)

**Content Sanitization (XSS Protection):**
- Strip HTML tags from article titles
- Sanitize article summaries (allow only safe tags: p, br, b, i, em, strong)
- Validate article URLs before displaying

**XML Parsing (XXE Protection):**
- Disable external entity processing in RSS parser
- Set content size limits (max 5MB per feed)

### 8. Source Management

Conversational approach (natural language):
- "Follow @techcrunch for me"
- "Add this RSS feed: [url]"
- "Stop following BBC"
- "What news sources am I following?"

Agent handles via unified `news` tool internally.

### 9. Telegram Channels

**Phase 1**: Public channels only (simpler, no auth complexity)
**Future**: Could expand to private channels if needed

### 10. Fetch Frequency

**Start simple**: Fixed 2-hour interval for all sources
**Future enhancement**: Per-source config if needed

---

## Proposed Plugin Structure

```
src/plugins/news/
├── index.ts              # Plugin manifest + lifecycle + onEvent handler
├── types.ts              # NewsSource, SourceState types
├── fetchers/
│   ├── rss.ts            # RSS/Atom feed parser
│   └── telegram.ts       # Telegram channel reader (Phase 4)
└── tools/
    └── news-tool.ts      # Unified news tool with action pattern
```

**Unified Tool Design** (consistent with reminder plugin):
```typescript
{
  name: 'news',
  parameters: [
    { name: 'action', type: 'string', enum: ['add_source', 'remove_source', 'list_sources'], required: true },
    { name: 'type', type: 'string', enum: ['rss', 'telegram'], required: false },  // for add_source
    { name: 'url', type: 'string', required: false },                               // for add_source
    { name: 'name', type: 'string', required: false },                              // for add_source
    { name: 'sourceId', type: 'string', required: false },                          // for remove_source
  ]
}
```

**Note:** No `get_recent` action needed. COGNITION stores interesting articles in core memory and retrieves them naturally when user asks "what did I miss?"

### Thought Signal for News Processing

When news is fetched, the plugin emits a **thought signal** via the plugin API:

```typescript
// In onEvent() handler after fetching news
if (newArticles.length > 0) {
  // Use plugin API to emit thought - plugin knows nothing about core internals
  const result = primitives.intentEmitter.emitThought(
    `I just fetched ${newArticles.length} new articles:\n` +
    newArticles.map(a => `- ${a.source}: "${a.title}"`).join('\n') +
    `\n\nI should evaluate if any of these are important enough to tell the user about.`
  );

  if (!result.success) {
    logger.warn({ error: result.error }, 'Failed to emit thought for news');
  }
}
```

**Why this works:**
- Plugin only uses the `IntentEmitterPrimitive` API (no core imports)
- `thought` signals wake COGNITION immediately (bypass energy gate)
- LLM evaluates importance in context of learned user preferences
- Uses existing SEND_MESSAGE for proactive contact
- Clean separation: plugin doesn't know how thoughts work internally

---

## User Interaction Examples

**Adding sources:**
> User: "Follow @bbcbreaking on Telegram for me"
> Agent: "Added @bbcbreaking to your news sources. I'll check it every 2 hours and let you know about important updates."

**Cold start - Agent exploring interests:**
> Agent: "I noticed several articles about cryptocurrency regulations today. Is this something you'd like me to keep an eye on?"
> User: "Yes, crypto is important to me"
> Agent: "Got it! I'll prioritize crypto news for you."

**Proactive notification (urgent):**
> Agent: "🚨 Bitcoin just dropped 15% in the last hour. Given your interest in crypto, thought you'd want to know. [link]"

**Proactive notification (interesting, not urgent):**
> Agent: "Found an interesting article about new AI research from DeepMind. Want me to summarize it, or save it for later?"

**On-demand catch-up:**
> User: "What news did I miss today?"
> Agent: "Here's what caught my attention today:
> - Crypto: SEC announced new regulations (3 articles)
> - AI: GPT-5 rumors circulating
> - Tech: Apple event announced for next week
> Want details on any of these?"

**Learning from negative feedback:**
> Agent: "There's news about the royal family visiting..."
> User: "I don't care about celebrity news"
> Agent: "Noted! I'll skip celebrity and entertainment news in the future."

**Learning from engagement:**
> Agent shares AI article → User asks follow-up questions → Agent internally notes higher interest in AI

**Agent proactively asking:**
> Agent: "I've been following your news sources for a week now. I'm noticing you engage most with tech and finance news. Should I focus more on those and share less general news?"

---

## Implementation Phases

### Phase 0: Core Improvements

**0.1 Thought Deduplication (improve core):**
- [ ] Replace "first 50 chars" dedupeKey with **similarity-based deduplication**
- [ ] Implement text similarity algorithm (e.g., Jaccard similarity on word tokens)
- [ ] Threshold: thoughts with similarity > 0.85 are considered duplicates
- [ ] Update `src/types/signal.ts` - remove `dedupeKey` field from `ThoughtData`
- [ ] Update deduplication logic in `src/core/core-loop.ts`
- [ ] Delete old dedupeKey generation code

**0.2 Plugin API Extension:**
- [ ] Add `emitThought(content: string): EmitSignalResult` to `IntentEmitterPrimitive` in `src/types/plugin.ts`
- [ ] Add `'plugin'` to `ThoughtData.triggerSource` union in `src/types/signal.ts`
- [ ] Implement `emitThought()` in `createIntentEmitter()` in `src/core/plugin-loader.ts`
  - Create thought signal with proper structure (depth=0, rootThoughtId)
  - Core handles deduplication via similarity
- [ ] Test: verify thought signals from plugins wake COGNITION

### Phase 1: Core Infrastructure & Types
- [ ] Plugin scaffold with manifest (`src/plugins/news/index.ts`)
- [ ] Type definitions (`src/plugins/news/types.ts`)
  - NewsSource, SourceState interfaces
- [ ] Basic plugin storage (sources, sourceState per source)
- [ ] Unified `news` tool with actions: add_source, remove_source, list_sources
- [ ] URL validation (SSRF protection: block private IPs, cloud metadata)

### Phase 2: RSS Fetching & Thought-Based Processing
- [ ] RSS fetcher with lastSeenId tracking (`src/plugins/news/fetchers/rss.ts`)
- [ ] Scheduler setup (every 2 hours)
- [ ] `onEvent()` handler for scheduled polls:
  - Fetch new articles from all sources
  - Compare against lastSeenId for deduplication
  - Emit **thought signal** with article summaries
- [ ] COGNITION processes thought:
  - Evaluates importance based on learned preferences
  - Important → SEND_MESSAGE (proactive notification)
  - Interesting → core.remember (save for later)
  - Noise → discard

### Phase 3: Self-Learning Feedback Loop
- [ ] Track user reactions to shared news (engagement, dismissal)
- [ ] Store learned preferences as structured facts via `core.remember`
  - `{ subject: "user", predicate: "interested_in", object: "AI", confidence: 0.85 }`
- [ ] LLM uses learned preferences when evaluating news importance
- [ ] Agent can ask clarifying questions about interests
- [ ] Negative feedback handling ("I don't care about X")

### Phase 4: Telegram Channels
- [ ] Telegram public channel fetcher (`src/plugins/news/fetchers/telegram.ts`)
- [ ] Handle message pagination/history
- [ ] Rate limiting to avoid API limits

### Phase 5: Advanced Features (Future)
- [ ] Per-source fetch frequency configuration
- [ ] News categorization/grouping for summaries
- [ ] Daily digest option (morning summary)
- [ ] Private Telegram channels support

---

## Technical Considerations

### Storage Schema (SRP)

**Plugin Storage** (owned by plugin - fetch tracking only):
```typescript
// Source configuration
interface NewsSource {
  id: string;
  type: 'rss' | 'telegram';
  url: string;              // RSS URL or @channel_handle
  name: string;             // Display name
  enabled: boolean;
}

// Per-source state (for deduplication and health tracking)
interface SourceState {
  lastSeenId?: string;      // Last processed article ID
  lastSeenHash?: string;    // Fallback hash if no ID available
  lastFetchedAt: Date;
  consecutiveFailures: number;
}
```

**Core Memory** (owned by COGNITION - via core.remember):
```typescript
// Article summaries (saved by COGNITION when evaluating news)
// { subject: "news", predicate: "interesting_article", object: "Bitcoin drops 15%",
//   metadata: { source: "coindesk", url: "...", savedAt: "..." } }

// Learned preferences
// { subject: "user", predicate: "interested_in", object: "AI", confidence: 0.85 }
// { subject: "user", predicate: "not_interested_in", object: "celebrity", confidence: 0.92 }
//
// Confidence adjusts based on:
// - Positive engagement → increase
// - Negative feedback → decrease or flip to not_interested
// - Explicit statements → high confidence immediately
```

**Why this separation:**
- Plugin only tracks what it needs to fetch correctly (SRP)
- COGNITION owns all "remembered" content
- No `news.get_recent` tool needed - COGNITION searches its own memory
- No data duplication

---

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| **Core Improvements (Phase 0)** | | |
| `src/types/signal.ts` | Modify | Remove `dedupeKey` from `ThoughtData`, add `'plugin'` to `triggerSource` |
| `src/core/core-loop.ts` | Modify | Replace dedupeKey with similarity-based deduplication |
| `src/core/utils/text-similarity.ts` | Create | Text similarity algorithm (Jaccard or similar) |
| `src/types/plugin.ts` | Modify | Add `emitThought()` to `IntentEmitterPrimitive` |
| `src/core/plugin-loader.ts` | Modify | Implement `emitThought()` in `createIntentEmitter()` |
| **New Plugin Files** | | |
| `src/plugins/news/index.ts` | Create | Plugin manifest + lifecycle + onEvent handler |
| `src/plugins/news/types.ts` | Create | NewsSource, SourceState type definitions |
| `src/plugins/news/fetchers/rss.ts` | Create | RSS/Atom feed parser |
| `src/plugins/news/fetchers/telegram.ts` | Create | Telegram channel reader (Phase 4) |
| `src/plugins/news/tools/news-tool.ts` | Create | Unified news tool (add_source, remove_source, list_sources) |
| **Config** | | |
| `src/config/default.ts` | Modify | Add news plugin config |
| Plugin loader | Modify | Register news plugin |

### Plugin API Extension Required

The current plugin API cannot emit thought signals - `emitSignal()` only creates `plugin_event` signals.

**New method needed in `IntentEmitterPrimitive`:**

```typescript
interface IntentEmitterPrimitive {
  // ... existing methods ...

  /**
   * Emit a thought signal for COGNITION to process.
   * Thoughts bypass energy gate and wake COGNITION immediately.
   */
  emitThought(content: string): EmitSignalResult;
}
```

**Core changes required:**
| File | Change |
|------|--------|
| `src/types/plugin.ts` | Add `emitThought(content: string)` to `IntentEmitterPrimitive` |
| `src/types/signal.ts` | Add `'plugin'` to `ThoughtData.triggerSource` union |
| `src/core/plugin-loader.ts` | Implement `emitThought` in `createIntentEmitter()` |

This keeps the plugin isolated - it just calls `primitives.intentEmitter.emitThought("...")` without knowing anything about core internals.

---

## Verification Plan

**Areas to test:**
- RSS/Telegram fetching (parsing, error handling, deduplication)
- URL validation (SSRF protection)
- Content sanitization (XSS protection)
- Thought emission and COGNITION wake
- Self-learning feedback loop (preference updates)
- Scheduler integration (periodic polling)
- Tool actions (add/remove/list sources)
- Error recovery (retries, persistent failure notification)
