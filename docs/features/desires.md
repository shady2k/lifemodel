# Desires

Want-driven proactivity — the agent has things it wants, not just obligations.

## Core Concept

Desires replace guilt-driven social debt with want-driven initiative. Instead of "I should contact them because it's been a while," the agent thinks "I want to learn about their new project."

## Desire Record

| Field | Description |
|-------|-------------|
| `want` | What the agent wants ("Learn about their new job") |
| `intensity` | 0-1 scale of how strongly |
| `source` | `user_signal`, `self_inference`, or `commitment_followup` |
| `evidence` | Why the agent wants this ("They mentioned it Tuesday") |
| `status` | `active`, `satisfied`, `stale`, `dropped` |

## Signal Flow

```
core.desire tool → memory entry → updateDesirePressure() scans memory
    → agent.updateState({desirePressure}) → DesirePressureNeuron emits signal
    → threshold engine wakes at 0.6+ → proactive trigger with desires
```

## Pressure Calculation

Computed every 30 seconds from active desires:
- **Max intensity** (60%): Strongest want dominates
- **Count factor** (40%): More wants = more pressure (capped at 5)
- Formula: `pressure = min(1, maxIntensity * 0.6 + countFactor * 0.4)`

## Tool: `core.desire`

| Action | Description |
|--------|-------------|
| `create` | Record a new desire with want, intensity, source, evidence |
| `adjust` | Change intensity of an existing desire |
| `resolve` | Mark desire as satisfied |
| `list_active` | List all active desires |

## Prompt Integration

- **Context section** (`<active_desires>`): Top 3 desires by intensity
- **Proactive trigger**: "Pick one active desire or defer"
- **Contact pressure**: Desire pressure contributes with weight 0.2

## Files

```
src/types/agent/desire.ts                         # Types
src/layers/cognition/tools/core/desire.ts          # Tool
src/plugins/desire-pressure/index.ts               # Neuron plugin
src/core/core-loop.ts                              # Pressure computation + intent processing
src/layers/cognition/prompts/context-sections.ts   # <active_desires> section
```
