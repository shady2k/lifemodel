# Commitment Tracking

The agent makes promises, tracks them, and either keeps or repairs them.

## Core Concept

When the agent explicitly promises something ("I'll check in about your interview tomorrow"), it creates a commitment record. The system then tracks whether the promise is kept, and if not, ensures the agent acknowledges and repairs the breach.

## Commitment Lifecycle

```
Created → Due → Kept/Repaired/Cancelled
           ↓ (if not fulfilled)
         Overdue → Breach acknowledged → Repaired
```

### Two-Stage Signal Flow

| Stage | Signal | Timing | Priority | Trigger |
|-------|--------|--------|----------|---------|
| Due | `commitment:due` | At `dueAt` | HIGH | "Act on your commitment now" |
| Overdue | `commitment:overdue` | At `dueAt` + 1 hour | HIGH | "Acknowledge breach and repair" |

## Storage

Commitments are stored as `MemoryEntry` facts:
- Tags: `['commitment', 'state:active']`
- Metadata: `kind: 'commitment'`, `dueAt`, `source`, `confidence`
- Status transitions update tags: `state:kept`, `state:repaired`, `state:cancelled`

## Tool: `core.commitment`

| Action | Description |
|--------|-------------|
| `create` | Record a new commitment with text, dueAt, source, confidence |
| `mark_kept` | Mark commitment as fulfilled |
| `mark_repaired` | Mark breach as repaired (requires `repairNote`) |
| `cancel` | Cancel commitment (circumstances changed) |
| `list_active` | List all active commitments |

## Prompt Integration

- **Context section** (`<commitments>`): Shows active commitments with `[OVERDUE]` flags
- **Trigger section**: Dedicated triggers for `commitment:due` and `commitment:overdue` events
- **Operating principle**: "I only promise what I can actually do"

## Scanner

CoreLoop checks for overdue commitments every 60 seconds:
1. Queries memory for active commitments
2. If `dueAt` passed → emits `commitment:due` signal (once, deduped)
3. If `dueAt` + 1 hour passed → emits `commitment:overdue` signal (once, deduped)
4. Dedup sets cleared when commitment status changes

## Files

```
src/types/agent/commitment.ts                    # Types
src/layers/cognition/tools/core/commitment.ts     # Tool
src/layers/cognition/intent-compiler.ts           # Intent compilation
src/core/core-loop.ts                             # Intent processing + scanner
src/layers/cognition/prompts/context-sections.ts  # <commitments> section
src/layers/cognition/prompts/trigger-sections.ts  # Trigger handlers
```
