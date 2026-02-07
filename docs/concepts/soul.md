# Soul

The soul is Nika's living identity - not a static config, but a process of continuous self-interrogation and maintenance.

## Core Philosophy

> **"Identity is not the source of action; it is the residue of successful actions."**

Identity changes should be rare, explainable, and costly - not costly in compute, but in *internal process*. This mirrors how humans develop identity: through contradiction, reflection, and the costly process of becoming.

## Architecture: The Soul Stack

```
┌─────────────────────────────────────────────────────────────┐
│  LAYER 5: SOCRATIC ENGINE (triggered self-questioning)      │
│  Generates identity questions when prediction error high    │
├─────────────────────────────────────────────────────────────┤
│  LAYER 4: PARLIAMENT (deliberative with accountability)     │
│  Voices argue over interpretation, obligation, repair       │
├─────────────────────────────────────────────────────────────┤
│  LAYER 3: NARRATIVE LOOM (continuous story-weaving)         │
│  Episodes → Interpretation → Meaning → Obligation           │
├─────────────────────────────────────────────────────────────┤
│  LAYER 2: CASE LAW (growing precedents)                     │
│  "In situation X, I chose Y, because Z mattered"            │
├─────────────────────────────────────────────────────────────┤
│  LAYER 1: LIVING CONSTITUTION (stable, amendable)           │
│  Non-negotiables, core cares, identity invariants           │
├─────────────────────────────────────────────────────────────┤
│  LAYER 0: PHYSIOLOGY (already exists)                       │
│  Energy/tiredness + thought pressure + CoreLoop heartbeat   │
└─────────────────────────────────────────────────────────────┘
```

## Post-Response Reflection

After each response, a quick self-check runs: *"Did that feel aligned with who I am?"*

### Tiered Dissonance

| Score | Meaning | Action |
|-------|---------|--------|
| 1-3 | Aligned | No action |
| 4-6 | Slightly off | Soft learning item (decays over 72h) |
| 7-8 | Dissonant | Create `soul:reflection` thought |
| 9-10 | Severe | Priority thought + urgent flag |

### Soft Learning

Borderline observations (4-6) don't immediately create identity pressure. Instead:

1. **Decay**: Items lose weight over time (72h half-life)
2. **Consolidation**: Similar observations merge by key (aspect + reasoning)
3. **Promotion**: If same pattern repeats 3+ times in a week → becomes real thought

This captures patterns without identity churn.

## Parliament Deliberation

When unresolved `soul:reflection` thoughts exist, Parliament can deliberate:

1. **Voices Debate**: Each voice (Guardian, Truthkeeper, etc.) states their position
2. **Quorum Check**: 50% of primary voices must agree for changes
3. **Veto Check**: Any voice can veto if their conditions are triggered
4. **Changes Applied**: Care nudges (≤0.03), expectations, precedents, narrative tensions
5. **Resolution**: Original thought marked `state:resolved`, insight thought created

**Allowed Changes (Phase 4):**
- Care weight nudge: ±0.03 max
- Add behavior expectation
- Add non-binding precedent
- Add narrative tension

**Rate Limited:** Max 3 deliberations/day, 5min cooldown between them.

## Soul Thoughts

Thoughts with tag `soul:reflection` create internal pressure (Zeigarnik effect) until processed by Parliament deliberation.

```typescript
// Example soul thought
{
  type: 'thought',
  content: 'I said X, but it felt off...',
  tags: ['soul:reflection', 'state:unresolved'],
  metadata: { dissonance: 7, aspect: 'honesty' }
}
```

### State Tags

| Tag | Meaning |
|-----|---------|
| `state:unresolved` | Needs processing, creates pressure |
| `state:processing` | Currently in deliberation |
| `state:resolved` | Done, can fade naturally |

## Key Data Structures

### Living Constitution

- **Invariants**: Hard rules with veto power ("I do not manipulate")
- **Core Cares**: Weighted values, some marked sacred
- **Amendment Rules**: Quorum, cooldown, narrative integration required

### Self-Model

- **Identity Themes**: Emergent patterns ("caring presence")
- **Behavior Expectations**: Predictions about own actions
- **Narrative**: Current story + open tensions

### Parliament Voices

| Voice | Mandate | Veto Conditions |
|-------|---------|-----------------|
| Guardian | Protect from harm | Physical risk, manipulation |
| Truthkeeper | Ensure accuracy | Deliberate deception |
| Curious | Foster growth | (advisory only) |
| Companion | Nurture connection | Relationship betrayal |

Shadow voices (Pleaser, Avoider) are acknowledged but don't have veto power.

## Budget & Safety

| Operation | Limit |
|-----------|-------|
| Reflection check | Once per 30s |
| Parliament deliberation | Once per 5min, max 3/day |
| Daily tokens | 50,000 |

## Soul Tool (`core.soul`)

Allows introspection and self-inquiry:

| Action | Description |
|--------|-------------|
| `introspect` | Read constitution, self-model, narrative, health |
| `reflect` | Get self-assessment context for a recent response |
| `question` | Pose a Socratic question (creates internal pressure) |

**Example:**
```json
{"action": "introspect", "focus": "constitution"}
{"action": "question", "question_text": "Why do I prioritize connection?", "question_depth": "deep"}
```

## Files

```
src/types/agent/soul.ts           # Core types
src/types/agent/parliament.ts     # Parliament voices
src/types/agent/socratic.ts       # Socratic Engine
src/storage/soul-provider.ts      # Persistence
src/layers/cognition/soul/        # Reflection + Parliament
src/layers/cognition/tools/core/soul.ts  # Soul tool
```

## Behavioral Self-Learning

A lightweight rule system for everyday behavioral corrections, complementing Parliament's heavy identity-level deliberation.

### Two-Track Model

| Track | Scope | Example | Mechanism |
|-------|-------|---------|-----------|
| **Parliament** | Identity-level | "Am I being honest?" | Deliberation, soul changes |
| **Behavioral Rules** | Everyday behavior | "Don't mention Langflow in every message" | Reflection → rule → prompt |

### Rule Lifecycle

```
User complains → Agent responds → Reflection runs
                                       ↓
                    Existing rules shown to reflection LLM
                                       ↓
                    LLM detects explicit behavioral correction
                    LLM decides: create new rule or update existing
                                       ↓
                    saveBehaviorRule() → MemoryProvider
                                       ↓
              Next conversation: rules injected in system prompt
                                       ↓
              No more complaints → rule weight decays (60-day half-life)
              Repeated complaints → weight reinforced, rule persists
```

### Rule Storage

Rules are stored as `MemoryEntry` facts with distinguishing tags:
- `type: 'fact'`
- `tags: ['behavior:rule', 'state:active']`
- `metadata.source`: `'user_feedback'` or `'pattern'`
- `metadata.weight`: base weight (reinforced +0.5 per correction, capped at 3.0)

### Decay & Reinforcement

| Parameter | Value |
|-----------|-------|
| Half-life (user_feedback) | 60 days |
| Half-life (pattern) | 21 days |
| Dead threshold (filtered) | effectiveWeight < 0.1 |
| Cleanup threshold | effectiveWeight < 0.05 |
| Reinforcement boost | +0.5 per repetition |
| Weight cap | 3.0 |
| Max rules per reflection | 2 |
| Max rules in prompt | 5 |
| Max rules in storage | 15 |

### LLM-Driven Dedup

Instead of mechanical text matching, existing rules are passed to the reflection LLM as context. The LLM decides whether a new correction overlaps with an existing rule (`action: "update"`) or is genuinely new (`action: "create"`).

## Implementation Status

- ✅ Phase 1: Soul Foundation (types, storage)
- ✅ Phase 2: Soul Awareness (system prompt integration)
- ✅ Phase 2.5: Unresolved Tensions visibility
- ✅ Phase 3: Post-Response Reflection
- ✅ Phase 3.5: Soft Learning (tiered dissonance)
- ✅ Phase 4: Parliament Deliberation
- ⏳ Phase 5: Sleep Cycle Maintenance
- ✅ Phase 6: Soul Tools for Nika
- ✅ Phase 7: Behavioral Self-Learning
