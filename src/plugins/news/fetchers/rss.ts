/**
 * RSS/Atom Feed Fetcher
 *
 * Fetches and parses RSS 2.0 and Atom feeds with:
 * - Timeout and size limits (5MB max)
 * - Content sanitization (XSS protection)
 * - XXE protection (external entities disabled)
 */

import { XMLParser } from 'fast-xml-parser';
import type { FetchedArticle } from '../types.js';

/**
 * Maximum feed size in bytes (5MB per spec).
 */
const MAX_FEED_SIZE = 5 * 1024 * 1024;

/**
 * Fetch timeout in milliseconds.
 */
const FETCH_TIMEOUT_MS = 30000;

/**
 * Result of fetching a feed.
 */
export interface FetchResult {
  success: boolean;
  articles: FetchedArticle[];
  error?: string | undefined;
  /** ID or hash of the most recent article (for lastSeenId tracking) */
  latestId?: string | undefined;
}

/**
 * Strip HTML tags from text for XSS protection.
 * Preserves text content only.
 */
function stripHtml(html: string | undefined | null): string {
  if (!html) return '';

  // Decode common HTML entities first
  let text = html
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 10)));

  // Remove all HTML tags
  text = text.replace(/<[^>]*>/g, ' ');

  // Normalize whitespace
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

/**
 * Truncate text to a maximum length, adding ellipsis if needed.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Generate a hash for content (for deduplication when no guid available).
 */
function hashContent(content: string): string {
  // Simple hash function - sufficient for deduplication
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return `hash_${Math.abs(hash).toString(36)}`;
}

/**
 * Parse a date string from various RSS/Atom formats.
 */
function parseDate(dateStr: string | undefined | null): Date | undefined {
  if (!dateStr) return undefined;

  const parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) return undefined;

  return parsed;
}

/**
 * Extract text content from a potentially complex XML node.
 * Handles both simple text and CDATA content.
 */
function extractText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (node === null || node === undefined) return '';
  if (typeof node !== 'object') return '';

  // Handle object with #text property (common in XML parsers)
  const obj = node as Record<string, unknown>;
  const textValue = obj['#text'];
  if (typeof textValue === 'string') return textValue;
  if (typeof textValue === 'number') return String(textValue);

  const underscoreValue = obj['_'];
  if (typeof underscoreValue === 'string') return underscoreValue;
  if (typeof underscoreValue === 'number') return String(underscoreValue);

  // Try to get any string value
  const values = Object.values(obj);
  for (const v of values) {
    if (typeof v === 'string') return v;
  }

  return '';
}

/**
 * Extract categories/tags from RSS feed items.
 * Handles both single category and array of categories.
 */
function extractCategories(categoryNode: unknown): string[] {
  if (!categoryNode) return [];

  const categories: string[] = [];

  // Handle array of categories
  if (Array.isArray(categoryNode)) {
    for (const cat of categoryNode) {
      const text = stripHtml(extractText(cat));
      if (text) categories.push(text);
    }
  } else {
    // Single category
    const text = stripHtml(extractText(categoryNode));
    if (text) categories.push(text);
  }

  return categories;
}

/**
 * Extract categories/tags from Atom feed entries.
 * Atom uses term attribute: <category term="tag" />
 */
function extractAtomCategories(categoryNode: unknown): string[] {
  if (!categoryNode) return [];

  const categories: string[] = [];

  const processCat = (cat: unknown) => {
    if (typeof cat !== 'object' || cat === null) {
      // Might be plain text
      const text = extractText(cat);
      if (text) categories.push(text);
      return;
    }

    const catObj = cat as Record<string, unknown>;
    // Atom category uses @_term or term attribute
    const term = catObj['@_term'] ?? catObj['term'] ?? catObj['@_label'] ?? catObj['label'];
    if (term) {
      const text = stripHtml(extractText(term));
      if (text) categories.push(text);
    }
  };

  if (Array.isArray(categoryNode)) {
    for (const cat of categoryNode) {
      processCat(cat);
    }
  } else {
    processCat(categoryNode);
  }

  return categories;
}

/**
 * Parse RSS 2.0 feed format.
 */
function parseRss2(
  data: Record<string, unknown>,
  sourceId: string,
  sourceName: string
): FetchedArticle[] {
  const articles: FetchedArticle[] = [];

  // Navigate to items: rss.channel.item
  const rss = data['rss'] as Record<string, unknown> | undefined;
  const channel = (rss?.['channel'] ?? data['channel']) as Record<string, unknown> | undefined;

  if (!channel) return articles;

  let items = channel['item'];
  if (!items) return articles;

  // Ensure items is an array
  if (!Array.isArray(items)) {
    items = [items];
  }

  for (const item of items as Record<string, unknown>[]) {
    const title = stripHtml(extractText(item['title']));
    const description = stripHtml(extractText(item['description'] ?? item['content:encoded']));
    const link = extractText(item['link']);
    const guid = extractText(item['guid']);
    const pubDate = extractText(item['pubDate'] ?? item['dc:date']);

    // Extract tags from category elements
    const tags = extractCategories(item['category']);

    // Skip items without title
    if (!title) continue;

    // Generate ID: prefer guid, then link, then hash of title+description
    const id = guid || link || hashContent(title + description);

    articles.push({
      id,
      title: truncate(title, 200),
      summary: description ? truncate(description, 500) : undefined,
      url: link || undefined,
      sourceId,
      sourceName,
      publishedAt: parseDate(pubDate),
      tags: tags.length > 0 ? tags : undefined,
    });
  }

  return articles;
}

/**
 * Parse Atom feed format.
 */
function parseAtom(
  data: Record<string, unknown>,
  sourceId: string,
  sourceName: string
): FetchedArticle[] {
  const articles: FetchedArticle[] = [];

  // Navigate to entries: feed.entry
  const feed = (data['feed'] ?? data) as Record<string, unknown>;

  let entries = feed['entry'];
  if (!entries) return articles;

  // Ensure entries is an array
  if (!Array.isArray(entries)) {
    entries = [entries];
  }

  for (const entry of entries as Record<string, unknown>[]) {
    const title = stripHtml(extractText(entry['title']));

    // Atom summary/content can be complex
    const summaryNode = entry['summary'] ?? entry['content'];
    const summary = stripHtml(extractText(summaryNode));

    // Atom links can be objects with href attribute
    let link = '';
    const linkNode = entry['link'];
    if (Array.isArray(linkNode)) {
      // Find alternate link
      for (const l of linkNode as Record<string, unknown>[]) {
        if (l['@_rel'] === 'alternate' || !l['@_rel']) {
          link = extractText(l['@_href'] ?? l['href']);
          break;
        }
      }
    } else if (typeof linkNode === 'object' && linkNode !== null) {
      const l = linkNode as Record<string, unknown>;
      link = extractText(l['@_href'] ?? l['href']);
    } else {
      link = extractText(linkNode);
    }

    const id = extractText(entry['id']);
    const published = extractText(entry['published'] ?? entry['updated']);

    // Extract tags from category elements (Atom uses term attribute)
    const tags = extractAtomCategories(entry['category']);

    // Skip items without title
    if (!title) continue;

    // Generate ID: prefer id, then link, then hash
    const articleId = id || link || hashContent(title + summary);

    articles.push({
      id: articleId,
      title: truncate(title, 200),
      summary: summary ? truncate(summary, 500) : undefined,
      url: link || undefined,
      sourceId,
      sourceName,
      publishedAt: parseDate(published),
      tags: tags.length > 0 ? tags : undefined,
    });
  }

  return articles;
}

/**
 * Fetch and parse an RSS or Atom feed.
 *
 * @param url - Feed URL (must be validated before calling)
 * @param sourceId - Source identifier for tracking
 * @param sourceName - Human-readable source name
 * @returns Fetch result with articles or error
 */
export async function fetchRssFeed(
  url: string,
  sourceId: string,
  sourceName: string
): Promise<FetchResult> {
  try {
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'LifeModel-NewsBot/1.0 (RSS Feed Reader)',
          Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        },
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      return {
        success: false,
        articles: [],
        error: `HTTP ${String(response.status)}: ${response.statusText}`,
      };
    }

    // Check content length before reading body
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_FEED_SIZE) {
      return {
        success: false,
        articles: [],
        error: `Feed too large: ${contentLength} bytes (max ${String(MAX_FEED_SIZE)})`,
      };
    }

    // Read body with size limit
    const reader = response.body?.getReader();
    if (!reader) {
      return {
        success: false,
        articles: [],
        error: 'Unable to read response body',
      };
    }

    const chunks: Uint8Array[] = [];
    let totalSize = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      totalSize += value.length;
      if (totalSize > MAX_FEED_SIZE) {
        void reader.cancel();
        return {
          success: false,
          articles: [],
          error: `Feed too large: exceeded ${String(MAX_FEED_SIZE)} bytes`,
        };
      }

      chunks.push(value);
    }

    // Combine chunks and decode
    const combined = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    const xml = new TextDecoder().decode(combined);

    // Parse XML with XXE protection (external entities disabled by default in fast-xml-parser)
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      // XXE protection: fast-xml-parser doesn't expand external entities by default
    });

    let data: Record<string, unknown>;
    try {
      data = parser.parse(xml) as Record<string, unknown>;
    } catch (parseError) {
      return {
        success: false,
        articles: [],
        error: `XML parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      };
    }

    // Detect feed type and parse
    let articles: FetchedArticle[];

    if ('rss' in data || ('channel' in data && !('feed' in data))) {
      // RSS 2.0 format
      articles = parseRss2(data, sourceId, sourceName);
    } else if ('feed' in data) {
      // Atom format
      articles = parseAtom(data, sourceId, sourceName);
    } else {
      return {
        success: false,
        articles: [],
        error: 'Unknown feed format: not RSS 2.0 or Atom',
      };
    }

    // Sort by date (newest first) if dates available
    articles.sort((a, b) => {
      if (!a.publishedAt && !b.publishedAt) return 0;
      if (!a.publishedAt) return 1;
      if (!b.publishedAt) return -1;
      return b.publishedAt.getTime() - a.publishedAt.getTime();
    });

    return {
      success: true,
      articles,
      latestId: articles[0]?.id,
    };
  } catch (error) {
    // Handle abort (timeout)
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        success: false,
        articles: [],
        error: `Request timeout after ${String(FETCH_TIMEOUT_MS)}ms`,
      };
    }

    return {
      success: false,
      articles: [],
      error: `Fetch error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
