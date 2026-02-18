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

## Completion Semantics

Reminders support a `complete` action to mark them as done:

### One-time Reminders

When a one-time reminder is completed:
- Status changes from `active` to `completed`
- Associated schedules are cancelled
- An occurrence record is created with `completedAt` timestamp
- `lastCompletedAt` and `completedCount` are updated on the parent

### Recurring Reminders

When a recurring reminder is completed:
- Status remains `active` (recurrence continues)
- `lastCompletedAt` and `completedCount` are updated
- An occurrence record is created or updated
- If completing **before** the scheduled fire time: schedule advances to next occurrence
- If completing **after** the scheduled fire time: no schedule change (already advanced)

The `complete` action returns `nextFireAt` for recurring reminders, allowing the agent to tell the user when the next occurrence will fire.

## Occurrence Ledger

Each reminder has an append-only occurrence ledger that tracks the history of fires and completions:

```
Reminder (parent)          ReminderOccurrence (ledger)
─────────────────          ────────────────────────────
id                         id
content                    reminderId → parent
recurrence                 sequence (1, 2, 3...)
status: active|cancelled   scheduledAt
lastCompletedAt (cache)    firedAt?
completedCount (cache)     completedAt?
                           status: fired|completed|skipped
```

This enables:
- History queries ("Did I complete the utilities reminder in January?")
- Completion tracking without losing recurrence state
- Audit trail of all reminder activity

## Overdue Detection via FireContext

When the scheduler fires a schedule, it passes a `FireContext` to the plugin's `onEvent`:

```typescript
interface FireContext {
  scheduledFor: Date;  // snapshot of nextFireAt BEFORE markFired()
  firedAt: Date;       // wall clock AFTER markFired()
  fireId: string;
  scheduleId: string;
}
```

**Why `scheduledFor` is snapshotted before `markFired`:** For recurring schedules, `markFired()` advances `nextFireAt` to the next occurrence. Without the snapshot, the plugin would see the *next* due time instead of the one that just fired.

**Overdue threshold:** If `firedAt - scheduledFor > 5 minutes`, the reminder intention includes a note: `"was due at 14:30, delayed ~17 minutes"`. This applies uniformly to both one-time and recurring reminders.

**Payload cloning:** The scheduler `structuredClone`s `entry.data` separately for the signal and the plugin callback, preventing cross-mutation between the two consumers.

**Backward compatibility:** If `fireContext` is not available (e.g., manually triggered events), overdue detection falls back to `data.scheduledAt`. If neither is available, overdue detection is skipped.

## Self-Scheduled Reminders (Phase 4)

The agent can schedule reminders for itself using the `internal: true` flag:

```typescript
core.schedule({
  content: "Follow up on their job interview",
  anchor: { type: "relative", relative: { unit: "hour", amount: 24 } },
  internal: true
})
```

Self-scheduled reminders fire as `reminder:self_scheduled` plugin events and produce a dedicated trigger:

```xml
<trigger type="self_scheduled">
<context>You scheduled this for yourself: "Follow up on their job interview"</context>
<task>Act on your own reminder. You set this because it mattered.</task>
</trigger>
```

This enables **agent autonomy** — the agent can decide to do something later and actually follow through.
