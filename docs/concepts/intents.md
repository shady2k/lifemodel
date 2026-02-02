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

## Immediate Intent Processing

Most intents are batched and processed after the agentic loop completes. However, some intents need **immediate visibility** to subsequent tools in the same loop:

| Intent | Why Immediate |
|--------|---------------|
| `REMEMBER` | User facts should be queryable by following tools |
| `SET_INTEREST` | Topic weights should be visible for interest-based decisions |

### The Problem

Without immediate processing:
```
1. LLM calls core.remember(gender="male") → returns {success: true}
2. LLM calls plugin_calories(calculate_from_stats) → gender NOT FOUND!
3. TDEE calculation fails because intent not yet applied
```

### The Solution

`REMEMBER` and `SET_INTEREST` intents are applied immediately via callback during loop execution. The result is marked `immediatelyApplied = true` to skip duplicate processing in final intent compilation.

```
1. LLM calls core.remember(gender="male") → returns {success: true}
2. Intent applied immediately → UserModel updated
3. LLM calls plugin_calories(calculate_from_stats) → gender FOUND ✓
4. TDEE calculated successfully
```
