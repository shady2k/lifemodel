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
| Parliament deliberation | Once per 5min |
| Daily tokens | 50,000 |

## Files

```
src/types/agent/soul.ts       # Core types
src/types/agent/parliament.ts # Parliament voices
src/types/agent/socratic.ts   # Socratic Engine
src/storage/soul-provider.ts  # Persistence
src/layers/cognition/soul/    # Reflection system
```

## Implementation Status

- ✅ Phase 1: Soul Foundation (types, storage)
- ✅ Phase 2: Soul Awareness (system prompt integration)
- ✅ Phase 2.5: Unresolved Tensions visibility
- ✅ Phase 3: Post-Response Reflection
- ✅ Phase 3.5: Soft Learning (tiered dissonance)
- ✅ Phase 4: Parliament Deliberation
- ⏳ Phase 5: Sleep Cycle Maintenance
- ⏳ Phase 6: Soul Tools for Nika
