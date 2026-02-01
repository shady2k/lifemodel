# News Monitoring

A news monitoring system that processes articles like sensory input - through brain layers that filter, prioritize, and surface relevant information.

## Core Value

User never misses important news, but isn't overwhelmed by noise.

## How It Works

Articles flow through brain layers as signals:

1. **AUTONOMIC** - NewsSignalFilter scores each article
   - Interest score: "Do I care about this?"
   - Urgency score: "Should I interrupt NOW?"

2. **AGGREGATION** - Decides what to do
   - URGENT → wake COGNITION immediately
   - INTERESTING → save as fact to memory
   - NOISE → filter out

3. **COGNITION** - When woken
   - Decides how to share urgent news
   - Searches memory for relevant facts during conversation
   - Learns from user reactions

## Classification

| Interest | Urgency | Result |
|----------|---------|--------|
| any | > 0.8 | URGENT - notify immediately |
| 0.4 - 1.0 | ≤ 0.8 | INTERESTING - save to memory |
| < 0.4 | any | NOISE - filter out |

## Learning

The system learns from explicit user reactions:
- "I love crypto news" → increase crypto weight
- "Stop sending celebrity news" → set celebrity weight to 0

Silence is NOT treated as negative feedback (too ambiguous).

## Sources

- RSS feeds
- Telegram public channels
