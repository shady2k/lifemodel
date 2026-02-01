# Thinking

The agent has internal thoughts that influence behavior.

## How It Works

1. **Thought Creation** - Via `core.thought` tool during conversation, or from memory consolidation
2. **Context Priming** - Recent thoughts (30 min) automatically included in COGNITION context
3. **Thought Pressure** - Accumulated thoughts create mental pressure (ThoughtsNeuron)
4. **Proactive Behavior** - High pressure can trigger COGNITION to process/share thoughts

## Flow

```
Thought created (conversation, memory consolidation, etc.)
    |
Stored in memory + updates AgentState.thoughtPressure
    |
+-------------------------------------------------------------+
| AUTONOMIC: ThoughtsNeuron monitors thoughtPressure          |
|   - Emits thought_pressure signal on significant change     |
|   - High pressure can trigger COGNITION                     |
+-------------------------------------------------------------+
    |
+-------------------------------------------------------------+
| COGNITION: Recent thoughts auto-included in context         |
|   - "Recent Thoughts" section in prompt                     |
|   - LLM sees what agent was thinking about                  |
+-------------------------------------------------------------+
```

## Thought Pressure

Like human "mental load" - unresolved thoughts create pressure:
- More thoughts = higher pressure
- Older thoughts = higher pressure
- Low energy = thoughts feel heavier

Pressure formula:
```
countFactor = min(1, thoughtCount / 5)
ageFactor = min(1, oldestAge / 2hours)
energyAmplifier = 1 + (1 - energy) * 0.3
pressure = (countFactor * 0.6 + ageFactor * 0.4) * energyAmplifier
```

When pressure crosses threshold (70%), agent may:
- Process thoughts internally
- Share thoughts with user
- Defer to later

## Context Priming

Recent thoughts (last 30 min) appear in COGNITION's trigger prompt:

```
## Recent Thoughts
- [5m ago] Need to follow up on user's interview
- [15m ago] User seems interested in local AI models
NOTE: Your recent internal thoughts. Background context, not visible to user.
```

This allows the agent to:
- Reference ongoing concerns naturally
- Maintain continuity across conversations
- Process accumulated internal thoughts

## Biological Inspiration

Based on the **Zeigarnik Effect** - incomplete tasks and unresolved thoughts persist in memory and create cognitive pressure until processed or resolved. Just as humans experience mental load from unfinished business, the agent accumulates thought pressure that motivates processing.
