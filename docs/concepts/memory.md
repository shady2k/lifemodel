# Memory

The agent stores and retrieves information like human memory.

## Memory Types

| Type | Purpose | Example |
|------|---------|---------|
| **Fact** | Objective information | "Bitcoin dropped 15%" |
| **Thought** | Internal reasoning | "User seems interested in AI" |
| **Observation** | Behavioral pattern | "User active in evenings" |

## Storage

Memories have:
- `content` - The information
- `confidence` - How certain (0-1)
- `tags` - For retrieval
- `provenance` - Where it came from

## Retrieval

COGNITION searches memory by:
- **Relevance** (query matching in content/tags)
- **Recency** (recent memories get a boost, decaying over 1 week)
- **Confidence** (additive boost: `score += confidence * 3`)

### Search Features

The `core.memory` tool supports:

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

## Consolidation

During sleep mode:
- **Merge** duplicate memories
- **Decay** old memories (reduce confidence)
- **Forget** weak memories (low confidence, old)

This mirrors human memory consolidation during sleep.
