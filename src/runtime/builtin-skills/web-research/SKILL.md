---
name: web-research
description: Research a topic using web search and page fetching. Searches for information, reads relevant pages, and produces a structured summary with citations. Use when the agent needs to gather information from the web autonomously.
---
# Web Research

## Instructions

1. **Plan search queries** — Break the topic into 2-3 focused search queries that cover different angles.

2. **Search** — Use `websearch` for each query. Collect the top results.

3. **Fetch pages** — Use `fetch` to read the 3-5 most relevant URLs from search results. Prefer authoritative sources (official docs, reputable publications).

4. **Extract key facts** — From each fetched page, identify the most important facts, data points, and quotes relevant to the research topic.

5. **Synthesize and respond** — Combine findings into a structured summary as your final response:
   - Start with a brief overview (2-3 sentences)
   - Organize findings by subtopic
   - Include specific data, quotes, and facts
   - Cite sources inline as [Source Title](URL)
   - Return the full research as your final text response (do NOT save to a file)

## Important notes

- Use `fetch` for web requests, not curl/wget
- Use `websearch` to discover URLs before fetching them
- If a domain is blocked, use `ask_user` to request access
- Focus on factual, verifiable information
- Always cite sources with URLs
