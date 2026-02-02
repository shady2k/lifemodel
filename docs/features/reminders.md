# Reminders

Schedule future notifications through natural conversation.

## How It Works

1. User requests reminder: "Remind me to call mom tomorrow at 5pm"
2. LLM extracts time expression into a **SemanticDateAnchor**
3. Reminder plugin resolves anchor to concrete UTC timestamp
4. Scheduler persists and fires at the right time
5. COGNITION wakes and sends reminder

## Semantic Date Anchors

The LLM doesn't calculate timestamps directly. Instead, it extracts time expressions into structured anchors:

```typescript
// "Remind me tomorrow" →
{
  type: "absolute",
  absolute: { special: "tomorrow" },
  confidence: 0.9,
  originalPhrase: "tomorrow"
}

// "Remind me in 2 hours" →
{
  type: "relative",
  relative: { unit: "hour", amount: 2 },
  confidence: 0.9,
  originalPhrase: "in 2 hours"
}

// "Remind me every Monday at 9am" →
{
  type: "recurring",
  recurring: { frequency: "weekly", daysOfWeek: [1], hour: 9 },
  confidence: 0.9,
  originalPhrase: "every Monday at 9am"
}
```

The `date-parser.ts` module then resolves these anchors to concrete timestamps with proper timezone handling.

## Anchor Types

| Type | Description | Example Phrases |
|------|-------------|-----------------|
| `relative` | Offset from now | "in 30 minutes", "in 2 hours", "in 3 days" |
| `absolute` | Specific time | "tomorrow", "next Monday", "at 3pm", "January 15" |
| `recurring` | Repeating schedule | "every day at 9am", "every Monday", "monthly on the 1st" |

## Restart Safety

Reminders survive restarts:
- Schedules persisted to disk
- On restart, past-due reminders fire immediately
- Future reminders continue as planned

## Tool Schema

The reminder tool uses `rawParameterSchema` to provide OpenAI with proper JSON Schema structure for the anchor parameter. This ensures the LLM generates correctly structured anchors instead of guessing from description text.
