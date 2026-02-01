# Intents

Layers don't mutate state directly. They return Intents that CoreLoop applies.

## Intent Types

| Intent | Purpose |
|--------|---------|
| `UPDATE_STATE` | Modify agent state |
| `SAVE_TO_MEMORY` | Store facts, thoughts, observations |
| `SCHEDULE_EVENT` | Queue future action |
| `CANCEL_EVENT` | Remove scheduled event |
| `SEND_MESSAGE` | Message the user |
| `ACK_SIGNAL` | Mark signal as handled |
| `DEFER_SIGNAL` | Postpone signal processing |
| `EMIT_THOUGHT` | Share internal thinking with memory |
| `SET_INTEREST` | Update topic interest weight |

## Why Intents?

1. **Testability** - Layers are pure functions returning data
2. **Traceability** - Every state change has explicit intent
3. **Composability** - Multiple layers can contribute intents per tick
4. **Rollback** - Intents can be validated before application
