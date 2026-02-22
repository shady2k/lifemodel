# ADR 005: LanceDB Vector Store

## Status

Accepted

## Context

The existing `JsonVectorStore` uses TF-IDF text scoring with a hand-rolled inverted index, persisted as a single JSON file via DeferredStorage. While functional, it lacks semantic understanding — searching "birthday" won't find "turns 30 next week." Memory contains both English and Russian entries, requiring multilingual support.

## Decision

Replace the JSON-backed TF-IDF vector store with **LanceDB** (embedded vector database) + **@huggingface/transformers** (local ONNX embedding model).

### Key choices

- **Embedding model:** `Xenova/paraphrase-multilingual-MiniLM-L12-v2` — 384 dimensions, supports 50+ languages, runs locally via ONNX (~50MB model cache)
- **Vector database:** LanceDB embedded — no server process, immediate durability, prebuilt native binaries
- **Search strategy:** Two-phase — vector retrieval from LanceDB, then re-ranking in JS with recency/confidence/salience boosts (preserving existing scoring behavior)
- **Interface:** The `VectorStore` interface is unchanged — `JsonMemoryProvider`, tools, and all consumers require zero modifications

### Storage

- **LanceDB files:** `data/state/memory/vector/` — LanceDB manages its own files, NOT routed through DeferredStorage
- **Model cache:** `data/models/` — ONNX model files downloaded on first run
- **`memory.json`:** Removed after one-time migration

### Migration

A standalone script (`src/scripts/migrate-memory-to-lance.ts`) embeds all entries from `memory.json` into LanceDB. Run once before first launch:

```bash
npx tsx src/scripts/migrate-memory-to-lance.ts
```

## Consequences

### Positive

- **Semantic search**: "birthday" now finds "turns 30 next week"
- **Multilingual**: Russian and English entries are searchable across languages
- **No interface changes**: All consumers (MemoryProvider, tools, consolidator) are unaffected
- **No server dependency**: LanceDB is embedded, same deployment model as before

### Negative

- **Second persistence path**: LanceDB files live outside the DeferredStorage system
- **~50MB model cache**: Downloaded on first run, cached at `data/models/`
- **Cold start**: 1-3s on first embedding call (model loading)
- **One-time migration required**: Must run migration script before first launch

### Neutral

- `JsonVectorStore` remains in codebase (not wired at runtime) for reference
- `persist()` is now a no-op — LanceDB writes are immediately durable
