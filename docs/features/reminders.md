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

## Timezone Resolution

Reminders use `getEffectiveTimezone()` from `src/utils/date.ts` for timezone fallback:
1. Explicit IANA timezone from user model (e.g., `Europe/Moscow`)
2. Derived from numeric UTC offset (e.g., `+3` → `Etc/GMT-3`)
3. Server default (`Europe/Moscow`)

When the timezone is inferred rather than explicitly configured, the tool result includes a `timezoneNote` prompting the LLM to ask the user to confirm their timezone for time-sensitive reminders.

## Daily Agenda

The plugin registers a daily schedule at the user's wake hour (default 08:00). When it fires:
1. Reads all active reminders from storage
2. Correlates each reminder's `scheduleId` with scheduler entries to get `nextFireAt`
3. Emits a pending intention for each reminder firing within the next 18 hours
4. Intentions surface as "Pending Insights" on first user contact

This ensures the agent is aware of today's appointments even if the user hasn't asked about them.

The daily agenda schedule is restart-safe: it uses a stable ID and checks for existing schedules before creating a new one.

## Tool Schema

The reminder tool uses `rawParameterSchema` to provide OpenAI with proper JSON Schema structure for the anchor parameter. This ensures the LLM generates correctly structured anchors instead of guessing from description text.
