# Opinions & Predictions

The agent forms views, writes them down, and learns when wrong.

## Core Concept

Opinions give the agent perspective — it doesn't just relay information, it has views. Predictions give the agent skin in the game — it can be wrong, surprised, and learn from mistakes.

## Opinions

| Field | Description |
|-------|-------------|
| `topic` | What the opinion is about |
| `stance` | The agent's position |
| `confidence` | 0-1 scale |
| `rationale` | Why the agent holds this view |
| `status` | `active`, `revised`, `dropped` |

### Case Law Promotion

Opinions validated 3+ times (revised with same-or-higher confidence) are automatically promoted to soul precedents:

```
Opinion revised upward → validationCount++ → at 3 → SoulProvider.addPrecedent()
```

Promoted precedents are non-binding (can be overridden) and scoped to the opinion's topic.

## Predictions

| Field | Description |
|-------|-------------|
| `claim` | What the agent predicts |
| `horizonAt` | When the prediction should be resolved |
| `confidence` | 0-1 scale |
| `outcome` | `pending`, `confirmed`, `missed`, `mixed` |

### Resolution Flow

```
Prediction created → horizonAt passes → prediction_due signal
    → LLM resolves → if missed → reflection thought enqueued
```

When a prediction is missed, CoreLoop automatically enqueues a `soul:reflection` thought: "My prediction was wrong: '...'. What can I learn from this?"

## Tool: `core.perspective`

| Action | Description |
|--------|-------------|
| `set_opinion` | Record a new opinion with topic, stance, confidence |
| `predict` | Make a prediction with claim, horizonAt, confidence |
| `resolve_prediction` | Resolve with outcome: confirmed/missed/mixed |
| `revise_opinion` | Update stance and/or confidence of existing opinion |
| `list` | List all opinions and predictions |

## Prompt Integration

- **Context section** (`<perspectives>`): Active opinions with confidence labels + pending predictions with overdue flags
- **Trigger sections**: Dedicated triggers for `perspective:prediction_due` and `perspective:prediction_missed`

## Scanner

CoreLoop checks for overdue predictions every 60 seconds:
1. Queries memory for pending predictions
2. If `horizonAt` passed → emits `perspective:prediction_due` signal (once, deduped)
3. Dedup set cleared on resolution

## Files

```
src/types/agent/perspective.ts                     # Types
src/layers/cognition/tools/core/perspective.ts      # Tool
src/core/core-loop.ts                              # Scanner + intent processing + case law promotion
src/layers/cognition/prompts/context-sections.ts   # <perspectives> section
src/layers/cognition/prompts/trigger-sections.ts   # Trigger handlers
src/storage/soul-provider.ts                       # addPrecedent() for case law
```
