# Web Search

Search the internet via configurable providers.

## Plugin

`web-search` - independent plugin for web searches.

## Tool: search

Find relevant pages (returns links, not content).

**Input:**
- `query` (required): Search query
- `provider`: Provider to use (optional, uses default)
- `limit`: Max results (default: 5, max: 10)
- `lang`: Language code (e.g., 'en')
- `country`: Country code (e.g., 'US')

**Output:** Array of results with title, url, snippet, publishedAt.

## Providers

| Provider | Env Var |
|----------|---------|
| serper | `SERPER_API_KEY` |
| tavily | `TAVILY_API_KEY` |
| brave | `BRAVE_API_KEY` |

## Configuration

Set `SEARCH_PROVIDER_PRIORITY` to customize default provider:

```bash
SEARCH_PROVIDER_PRIORITY=tavily,serper,brave
```

First available provider in list becomes the default.

## Design Principles

1. **No auto-fetch:** Returns links only. Call fetch separately for content.
2. **No failover:** If provider fails, error is returned.
3. **Explicit selection:** Caller can choose provider explicitly.
