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

## Advanced Tool Features

### rawParameterSchema

For tools with complex nested parameters (discriminated unions, nested objects), use `rawParameterSchema` instead of the simple `parameters` array:

```typescript
const myTool: PluginTool = {
  name: 'myTool',
  description: '...',
  rawParameterSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'delete'] },
      config: {
        type: ['object', 'null'],
        properties: { /* nested props */ },
        additionalProperties: false
      }
    },
    required: ['action', 'config'],
    additionalProperties: false
  },
  parameters: [...],  // Keep for documentation
  validate: ...,
  execute: ...
};
```

This ensures OpenAI's strict mode enforces the nested structure at generation time, rather than relying on description text.

## Provider Compatibility

The `OpenRouterProvider` includes Gemini-specific message sanitization (see [ADR-001](../adr/001-gemini-message-sanitization.md)):
- Leading system messages are left as-is (OpenRouter collapses them into Gemini's `system_instruction`)
- Mid-conversation system messages are converted to `user` role with `[System]` prefix
- First content message is ensured to be `user` role (synthetic `[autonomous processing]` message inserted if needed)

These transformations only apply to `google/*` models. Other models are unaffected.

## Available Plugins

| Plugin | Type | Description |
|--------|------|-------------|
| `reminder` | tool | Create and manage reminders with natural language and recurrence |
| `thoughts` | neuron | Monitor thought pressure from accumulated unprocessed thoughts |
| `social-debt` | neuron | Monitor social pressure from lack of interaction |
| `calories` | tool + neuron | Track food intake, calories, and body weight with proactive deficit monitoring |
| `news` | tool + filter | Fetch and filter news articles by user interests |
