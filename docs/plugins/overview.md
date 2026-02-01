# Plugin System

Modular extensions that add capabilities without touching core.

## Strict Isolation

- Core NEVER imports plugin types
- Plugins access core ONLY via PluginPrimitives API
- No direct calls between core and plugins

## Plugin Primitives API

What plugins can use:
- `scheduler` - Schedule future events
- `storage` - Persist plugin data
- `signalEmitter` - Emit signals to brain
- `logger` - Scoped logging

## Component Types

| Type | Purpose |
|------|---------|
| `neuron` | Monitor state, emit internal signals |
| `channel` | Sensory input (Telegram, etc.) |
| `tool` | COGNITION capabilities |
| `provider` | External services |
| `filter` | Signal transformation |

## Registration

Plugins declare capabilities via manifest. Core loads and wires them at startup.
