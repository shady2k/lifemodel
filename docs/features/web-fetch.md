# Web Fetch

Fetch web pages and convert to markdown.

## Plugin

`web-fetch` - independent plugin for fetching web content.

## Tool: fetch

Get markdown content from a URL.

**Input:**
- `url` (required): URL to fetch (http/https only)
- `timeoutMs`: Timeout (default: 30000, max: 30000)
- `maxBytes`: Max response size (default: 1MB, max: 1MB)
- `maxMarkdownBytes`: Max output size (default: 32KB, max: 32KB)
- `respectRobots`: Honor robots.txt (default: true)

**Output:** Markdown content, final URL, redirects, charset.

## Safety

- SSRF protection (blocks private IPs, validates redirects)
- Content-type filtering (text/html, text/plain, json only)
- robots.txt compliance
- All content marked `untrusted: true`
- No API keys required

## Design Principles

Content is fetched and sanitized but never trusted. Use for reading public web pages.
