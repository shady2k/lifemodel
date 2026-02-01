# Signals

Signals are the nervous system's universal currency. Everything flowing through the brain is a Signal.

## Signal Categories

### Sensory (from Channels)
- `user_message` - User sent a message
- `channel_connected` / `channel_disconnected` / `channel_error`

### Internal (from Neurons)
- `social_debt` - Pressure from lack of contact
- `energy` - Agent's energy level changed
- `alertness` - Alertness mode changed
- `contact_pressure` - Combined contact urgency

### Time
- `tick` - Every second
- `hour_changed` - Hour boundary crossed
- `time_of_day` - Morning, afternoon, evening, night

### Meta
- `pattern_break` - Detected behavioral change
- `threshold_crossed` - Aggregation threshold exceeded
- `contact_urge` - Time to reach out
- `novelty` - Something new detected

### Plugin
- `plugin_event` - Namespaced events (e.g., `news:article_batch`)

### Thought
- Internal thoughts from COGNITION layer

## Signal Flow

```
Channel (sensory input)
    ↓
Signal created
    ↓
AUTONOMIC: filters classify/transform
    ↓
AGGREGATION: bucket, pattern detect, threshold check
    ↓
(if threshold) → COGNITION processes
```

## Acknowledgment

Signals can be acknowledged to prevent repetitive processing (like habituation):

- **handled** - Processed, clear it
- **deferred** - "Not now, but later" (with override on significant change)
- **suppressed** - Block indefinitely
