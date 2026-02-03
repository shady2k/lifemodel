# Social Debt

Tracks contact pressure - the human feeling of "I should reach out."

## How It Works

Time since last contact accumulates as social debt. Multiple factors combine into contact pressure. When pressure crosses threshold, the agent feels urge to initiate contact.

## Two-Threshold Architecture

The system uses two thresholds to separate "desire exists" from "act now":

| Layer | Threshold | Purpose |
|-------|-----------|---------|
| **Neuron** (Autonomic) | `emitThreshold: 0.2` | "Is there a desire worth signaling?" |
| **ThresholdEngine** (Aggregation) | `wakeThreshold: 0.35` | "Is this worth waking Cognition?" |

**Why two thresholds?**
- Neuron emits while desire exists, keeping aggregates fresh
- ThresholdEngine decides if desire is urgent enough to wake Cognition
- "Child doesn't know parent" - Neuron shouldn't know about ThresholdEngine's wake threshold

## Pressure Calculation

Contact pressure is a weighted combination:

| Factor | Weight | Description |
|--------|--------|-------------|
| `socialDebt` | 0.4 | How long since last interaction |
| `acquaintancePressure` | 0.3 | Pressure to learn user's name |
| `taskPressure` | 0.2 | Pending things to discuss |
| `curiosity` | 0.1 | Agent's desire to engage |

## Protection Mechanisms

Multiple layers prevent spam:

1. **Neuron refractory period (5s):** Minimum time between signal emissions
2. **ThresholdEngine cooldown (30min):** Minimum time between waking Cognition
3. **AckRegistry:** Cognition-controlled deferrals with custom durations

## Behavior

High social debt + appropriate time → proactive contact

The agent reaches out naturally, not on fixed schedule. Pressure builds organically like a human feeling "I haven't talked to them in a while."

## Balance

The system avoids:
- Spamming (respects time of day, recent contact, refractory periods)
- Neglect (debt accumulates if no contact, continuous signaling keeps aggregates fresh)
