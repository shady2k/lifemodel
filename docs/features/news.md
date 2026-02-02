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
   - FILTERED → save topic mention as low-confidence fact (peripheral awareness)
   - NOISE → filter out completely

3. **COGNITION** - When woken
   - Decides how to share urgent news
   - Searches memory for relevant facts during conversation
   - Learns from user reactions

## Classification

| Interest | Urgency | Result | Confidence |
|----------|---------|--------|------------|
| any | > 0.8 | URGENT - notify immediately | - |
| 0.4 - 1.0 | ≤ 0.8 | INTERESTING - save full article to memory | 0.4 |
| 0.2 - 0.4 | ≤ 0.8 | FILTERED - save topic mention only | 0.2 |
| < 0.2 | any | NOISE - filter out completely | - |

## Search Behavior

When asking about news ("есть интересные новости?"):

1. **Default search** (`minConfidence: 0.3`) returns:
   - Full articles (confidence 0.4) with full content
   - Filtered topics (confidence 0.2) are **excluded** by default

2. **Filtered topics** serve as "peripheral awareness":
   - They're stored but ranked lower due to low confidence
   - LLM gets metadata about hidden results
   - Can be accessed with `minConfidence: 0` if needed

This preserves the "topic mention" design pattern while preventing 850 filtered facts from overwhelming 72 real articles.

## Learning

The system learns from explicit user reactions:
- "I love crypto news" → increase crypto weight
- "Stop sending celebrity news" → set celebrity weight to 0

Silence is NOT treated as negative feedback (too ambiguous).

## Sources

- RSS feeds
- Telegram public channels
