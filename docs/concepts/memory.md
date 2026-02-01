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
- Tags (topic matching)
- Recency (recent memories prioritized)
- Confidence (high confidence first)

## Consolidation

During sleep mode:
- **Merge** duplicate memories
- **Decay** old memories (reduce confidence)
- **Forget** weak memories (low confidence, old)

This mirrors human memory consolidation during sleep.
