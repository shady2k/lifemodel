# Memory

The agent stores and retrieves information like human memory.

## Memory Types

| Type | Purpose | Example |
|------|---------|---------|
| **Fact** | Objective information | "Bitcoin dropped 15%" |
| **Thought** | Internal reasoning | "User seems interested in AI" |
| **Observation** | Behavioral pattern | "User active in evenings" |
| **Intention** | Pending insights for next conversation | "Want to ask about their new job" |
| **Commitment** | Promises the agent made | "Check in about interview" |
| **Desire** | Wants driving proactive behavior | "Learn about their new project" |
| **Opinion** | Agent's formed views | "I think X overstates the risk" |
| **Prediction** | Claims about the future | "They'll enjoy that restaurant" |

All these are stored as `MemoryEntry` facts with distinguishing tags and `metadata.kind`.

## Dual-Layer Architecture

Memory is split into two abstract stores:

### VectorStore (Retrieval/Index CRUD)

`src/storage/vector-store.ts` — handles storage, search, scoring, persistence.

Responsible for:
- Save/delete/getById/getAll — standard CRUD
- **Search with TF-IDF scoring**: term frequency normalized by document length, IDF via ephemeral inverted index
- Exact phrase match (+10), tag match (+3), recency boost (1-week decay), confidence boost, salience boost

The inverted index (`Map<term, Set<entryId>>`) is rebuilt on load, updated on save/delete. Never persisted — no corruption path.

**Scoring components:**
- Exact phrase: +10 if query appears verbatim in content
- TF-IDF: `tf(term, doc) * idf(term) * 10` per query term (normalized by doc length)
- Tag match: +3 per matching tag
- Recency: 0-1 decaying linearly over 168 hours (1 week)
- Confidence: `confidence * 3`
- Salience: `salience * 2` (when present)

**Salience vs Confidence:**
- `confidence` = truth-likelihood (stable). "How sure are we this fact is correct?"
- `salience` = retrieval priority (decays). "How important is this right now?"
- Both are 0-1 floats on `MemoryEntry`. Salience defaults to undefined (computed from recency at query time).

### GraphStore (Entities/Relations)

`src/storage/graph-store.ts` — stores entities (people, places, topics) and relations between them.

**Entity types:** person, place, organization, topic, event, concept, thing
**Relation types:** married_to, works_at, lives_in, friend_of, parent_of, etc.

**Internals:**
- Primary: `Map<id, GraphEntity>`, `Map<id, GraphRelation>`
- Adjacency: `outEdges: Map<entityId, Set<relationId>>`, `inEdges` same
- Name index: `Map<lowercase name/alias, entityId>` for O(1) lookup
- Persisted via DeferredStorage, key: `graph`, format: `{ version: 1, entities[], relations[] }`

**Graph algorithms:**
- `traverse()` — BFS with visited set, filter by minStrength/minConfidence/relationTypes
- `spreadingActivation()` — iterative propagation from seed nodes with per-hop decay (default 0.5), threshold cutoff (0.1), max 3 iterations

## Storage

Memories have:
- `content` - The information
- `confidence` - How certain (0-1), truth-likelihood (stable)
- `salience` - Retrieval priority (0-1), decays over time
- `tags` - For retrieval
- `provenance` - Where it came from
- `embedding` - Reserved for future vector search (never populated now)

## Retrieval Pipeline

### 1. Vector Search (default)

COGNITION searches memory via VectorStore:
- **TF-IDF scoring** (term frequency normalized by doc length, IDF via inverted index)
- **Recency boost** (recent memories get a boost, decaying over 1 week)
- **Confidence boost** (additive: `score += confidence * 3`)
- **Salience boost** (when present: `score += salience * 2`)

### 2. Graph Expansion (opt-in)

When `getAssociations()` is called (user-facing triggers):
1. Run vector search for direct matches
2. Extract key terms → `findEntity()` each → get seed entities
3. `spreadingActivation()` from seeds (decay 0.5, limit 5)
4. Fetch `sourceMemoryIds` from activated entities → `getById()` each
5. Merge: deduplicate by ID, apply hard caps (3 direct + 2 related + 2 commitments)

### 3. Prompt Injection (`<associations>`)

For user-facing triggers (`user_message`, `contact_urge`), the `<associations>` XML section is injected into the trigger prompt after pending intentions:

```xml
<associations>
  <direct_memories>
    - [3 weeks ago] John is building an AI coding tool (confidence: 0.95)
  </direct_memories>
  <related_context>
    - John's wife Sarah recently started a new job (via: John → married_to → Sarah)
  </related_context>
  <open_commitments>
    - Promised to intro John to VC friend (2 weeks ago)
  </open_commitments>
Use naturally if relevant. Do not force.
</associations>
```

**Token budget:** Hard caps: max 3 direct matches + 2 related context + 2 commitments. Section omitted entirely when graph is empty.

### Search Features

The `core.memory` tool supports:

- **`search`** action — paginated TF-IDF search with filters
- **`associate`** action — graph-expanded context for a topic or person name. Returns direct matches + related context (via entity graph) + linked commitments.
- **`minConfidence`** parameter (default: 0.3) - Filters out low-confidence matches
- **Search metadata** returned with results:
  - `totalMatched` - Total matching entries
  - `highConfidence` / `mediumConfidence` / `lowConfidence` - Count by confidence tier
  - `hasMoreResults` - Whether more matches exist beyond the limit

### Confidence Thresholds

| Tier | Range | Use Case |
|------|-------|----------|
| High | ≥0.5 | User facts, important observations |
| Medium | 0.3-0.5 | Real news articles (0.4), recent thoughts |
| Low | <0.3 | Filtered topic mentions (0.2), peripheral awareness |

### Design Philosophy

**Peripheral awareness**: Low-confidence entries (like filtered news topics) are kept in memory but ranked lower. This allows the system to maintain "background awareness" of topics without cluttering primary results.

The LLM receives metadata about hidden results and can explicitly search with `minConfidence: 0` to access peripheral information when needed.

## Intentions & TTL

Intentions are non-urgent insights saved for the next user conversation. They surface as "Pending Insights" in the system prompt.

Each intention can carry a per-entry TTL via the `expiresAt` field on `MemoryEntry`:
- **Default (no `expiresAt`)**: 2-hour window from `timestamp` — suitable for thought-loop insights
- **Custom TTL**: set via `emitPendingIntention(content, recipientId, { ttlMs })` — e.g., daily agenda items use 18h

`getPendingIntentions` fetches a 24h window and filters by `expiresAt` (or the 2h default), ensuring long-lived intentions aren't prematurely expired while short-lived ones don't linger.

## Consolidation

During sleep mode:
1. **Merge** duplicate memories (same subject + predicate)
2. **Decay** old memories (reduce confidence via exponential decay, 7-day half-life)
3. **Forget** weak memories (confidence below 0.1 threshold)
4. **Extract entities** (LLM-based, populates GraphStore)

### Entity Extraction

After merge/decay/forget, the consolidator runs entity extraction on entries not yet processed (`!metadata.graphExtracted`):

1. Filter unextracted entries
2. Batch them (~20 per LLM call) and send to `LLMEntityExtractor`
3. LLM returns entities + relations as structured JSON
4. Apply guardrails:
   - **Zod schema validation** — rejects malformed JSON
   - **Source grounding** — entity names must appear as substrings in source text
   - **Confidence threshold** — minimum 0.5 for new entities
   - **Endpoint validation** — relations require both endpoints to exist
5. Upsert entities into GraphStore (merge aliases if existing)
6. Upsert relations (resolve names → entity IDs)
7. Mark entries with `metadata.graphExtracted = true`
8. Persist graph

**Graph freshness lag is intentional.** Entities/relations are populated during consolidation, not on live writes. This means the graph is always slightly behind — a freshly saved fact won't have graph entities until the next sleep cycle.

**First consolidation = implicit migration.** Since no existing entries have `metadata.graphExtracted`, the first sleep-cycle run processes ALL existing memories through entity extraction, populating the graph from scratch.

## Data Migration

No breaking migration needed:
- **`memory.json`** — Format unchanged. New optional fields (`salience`, `embedding`) default to `undefined` when absent.
- **`graph.json`** — Brand new file, starts empty. Created on first `graphStore.persist()`.
- **Rollback:** Delete `graph.json` and revert code. Memory data is untouched.
