# Energy Model

The agent has physiological states affecting behavior.

## Energy Level (0-100)

Affects:
- Processing speed
- Model selection (fast vs smart)
- Communication frequency
- Response verbosity

## Sleep/Wake Cycle

Binary alertness: **awake** or **sleeping**.

Transitions are clock-driven based on the user's sleep schedule (`sleepHour`/`wakeHour`):
- When the local hour enters the sleep window → agent transitions to `sleeping`
- When the local hour exits the sleep window → agent transitions to `awake`
- Disturbance wake sets a 5-minute grace period to prevent immediate re-sleep

Sleep mode triggers maintenance (memory consolidation, entity extraction).

## Energy Transitions

Energy changes based on:
- Time of day (faster recharge during sleep window)
- Activity level (LLM calls, messages drain energy)
- Positive feedback (recharges energy)

## Impact on Behavior

Low energy → prefer fast model, shorter responses, defer non-urgent signals

High energy → more proactive contact, detailed responses, process more signals
