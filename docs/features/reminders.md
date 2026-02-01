# Reminders

Schedule future notifications through natural conversation.

## How It Works

1. User requests reminder: "Remind me to call mom tomorrow at 5pm"
2. COGNITION parses intent, creates `SCHEDULE_EVENT` intent
3. CoreLoop schedules the event
4. At fire time, scheduler emits signal
5. COGNITION wakes and sends reminder

## Restart Safety

Reminders survive restarts:
- Schedules persisted to disk
- On restart, past-due reminders fire immediately
- Future reminders continue as planned

## Natural Language

COGNITION interprets various formats:
- "Remind me in 2 hours"
- "Remind me tomorrow morning"
- "Remind me at 3pm"
- "Remind me next Monday"
