/**
 * Telegram Channel Fetcher
 *
 * Fetches messages from public Telegram channels using the web preview.
 * Uses t.me/s/{channel} which provides public access without authentication.
 *
 * Features:
 * - No authentication required for public channels
 * - Rate limiting to avoid Telegram blocks
 * - HTML parsing to extract messages
 * - Content sanitization
 */

import type { FetchedArticle } from '../types.js';

/**
 * Fetch timeout in milliseconds.
 */
const FETCH_TIMEOUT_MS = 30000;

/**
 * Minimum delay between requests to same channel (rate limiting).
 */
const MIN_REQUEST_DELAY_MS = 2000;

/**
 * Track last request time per channel for rate limiting.
 */
const lastRequestTime = new Map<string, number>();

/**
 * Result of fetching a Telegram channel.
 */
export interface TelegramFetchResult {
  success: boolean;
  articles: FetchedArticle[];
  error?: string | undefined;
  /** ID of the most recent message (for lastSeenId tracking) */
  latestId?: string | undefined;
}

/**
 * Strip HTML tags and decode entities.
 */
function stripHtml(html: string): string {
  if (!html) return '';

  // Decode common HTML entities
  let text = html
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&#(\d+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 10)));

  // Remove all HTML tags
  text = text.replace(/<[^>]*>/g, ' ');

  // Normalize whitespace
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

/**
 * Truncate text to a maximum length.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Parse the HTML response from t.me/s/{channel}.
 * Extracts messages from the Telegram web preview format.
 */
function parseChannelHtml(
  html: string,
  channelHandle: string,
  channelName: string
): FetchedArticle[] {
  const articles: FetchedArticle[] = [];

  // Match message containers with data-post attribute
  // Format: <div class="tgme_widget_message" data-post="channel/123">
  const messagePattern =
    /<div[^>]*class="[^"]*tgme_widget_message[^"]*"[^>]*data-post="([^"]+)"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*tgme_widget_message|$)/gi;

  let match;
  while ((match = messagePattern.exec(html)) !== null) {
    const postId = match[1]; // e.g., "bbcnews/12345"
    const messageHtml = match[2];

    if (!postId || !messageHtml) continue;

    // Extract message ID from post ID (format: "channel/messageId")
    const messageId = postId.split('/')[1];
    if (!messageId) continue;

    // Extract message text
    const textMatch =
      /<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(
        messageHtml
      );
    const rawText = textMatch ? textMatch[1] : '';
    const text = stripHtml(rawText ?? '');

    // Skip empty messages (might be media-only)
    if (!text || text.length < 10) continue;

    // Extract date if available
    const dateMatch = /datetime="([^"]+)"/i.exec(messageHtml);
    const dateStr = dateMatch?.[1];
    const publishedAt = dateStr ? new Date(dateStr) : undefined;

    // Create article
    // Use first line or first 100 chars as title
    const lines = text.split('\n').filter((l) => l.trim());
    const title = truncate(lines[0] ?? text.slice(0, 100), 200);
    const summary = lines.length > 1 ? truncate(lines.slice(1).join(' '), 500) : undefined;

    articles.push({
      id: `tg_${channelHandle}_${messageId}`,
      title,
      summary,
      url: `https://t.me/${channelHandle}/${messageId}`,
      sourceId: `telegram:${channelHandle}`,
      sourceName: channelName,
      publishedAt: publishedAt && !isNaN(publishedAt.getTime()) ? publishedAt : undefined,
    });
  }

  // Sort by message ID descending (newest first)
  articles.sort((a, b) => {
    const idA = parseInt(a.id.split('_').pop() ?? '0', 10);
    const idB = parseInt(b.id.split('_').pop() ?? '0', 10);
    return idB - idA;
  });

  return articles;
}

/**
 * Alternative parsing using simpler patterns.
 * Fallback if the main parser doesn't find messages.
 */
function parseChannelHtmlSimple(
  html: string,
  channelHandle: string,
  channelName: string
): FetchedArticle[] {
  const articles: FetchedArticle[] = [];

  // Look for message bubbles with simpler pattern
  // data-post="channel/id" appears in the message widget
  const postPattern = /data-post="([^"/]+)\/(\d+)"/g;
  const foundIds = new Set<string>();

  let postMatch;
  while ((postMatch = postPattern.exec(html)) !== null) {
    const messageId = postMatch[2];
    if (!messageId || foundIds.has(messageId)) continue;
    foundIds.add(messageId);
  }

  // For each found ID, try to extract the message text
  for (const messageId of foundIds) {
    // Find the message text near this ID
    const idIndex = html.indexOf(`data-post="${channelHandle}/${messageId}"`);
    if (idIndex === -1) continue;

    // Look for message text in the surrounding area (within 5000 chars)
    const searchArea = html.slice(idIndex, idIndex + 5000);

    const textMatch =
      /<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(
        searchArea
      );

    if (!textMatch) continue;

    const text = stripHtml(textMatch[1] ?? '');
    if (!text || text.length < 10) continue;

    // Extract date
    const dateMatch = /datetime="([^"]+)"/i.exec(searchArea);
    const dateStr = dateMatch?.[1];
    const publishedAt = dateStr ? new Date(dateStr) : undefined;

    const lines = text.split('\n').filter((l) => l.trim());
    const title = truncate(lines[0] ?? text.slice(0, 100), 200);
    const summary = lines.length > 1 ? truncate(lines.slice(1).join(' '), 500) : undefined;

    articles.push({
      id: `tg_${channelHandle}_${messageId}`,
      title,
      summary,
      url: `https://t.me/${channelHandle}/${messageId}`,
      sourceId: `telegram:${channelHandle}`,
      sourceName: channelName,
      publishedAt: publishedAt && !isNaN(publishedAt.getTime()) ? publishedAt : undefined,
    });
  }

  // Sort by message ID descending
  articles.sort((a, b) => {
    const idA = parseInt(a.id.split('_').pop() ?? '0', 10);
    const idB = parseInt(b.id.split('_').pop() ?? '0', 10);
    return idB - idA;
  });

  return articles;
}

/**
 * Apply rate limiting before making a request.
 */
async function applyRateLimit(channelHandle: string): Promise<void> {
  const lastTime = lastRequestTime.get(channelHandle);
  if (lastTime) {
    const elapsed = Date.now() - lastTime;
    if (elapsed < MIN_REQUEST_DELAY_MS) {
      await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_DELAY_MS - elapsed));
    }
  }
  lastRequestTime.set(channelHandle, Date.now());
}

/**
 * Fetch messages from a public Telegram channel.
 *
 * @param channelHandle - Channel handle (with or without @)
 * @param channelName - Human-readable channel name
 * @returns Fetch result with articles or error
 */
export async function fetchTelegramChannel(
  channelHandle: string,
  channelName: string
): Promise<TelegramFetchResult> {
  // Normalize handle (remove @ if present)
  const handle = channelHandle.startsWith('@') ? channelHandle.slice(1) : channelHandle;

  try {
    // Apply rate limiting
    await applyRateLimit(handle);

    // Fetch channel page
    const url = `https://t.me/s/${handle}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
    } finally {
      clearTimeout(timeoutId);
    }

    // Check for errors
    if (!response.ok) {
      if (response.status === 404) {
        return {
          success: false,
          articles: [],
          error: `Channel not found: @${handle}`,
        };
      }
      if (response.status === 429) {
        return {
          success: false,
          articles: [],
          error: 'Rate limited by Telegram. Will retry later.',
        };
      }
      return {
        success: false,
        articles: [],
        error: `HTTP ${String(response.status)}: ${response.statusText}`,
      };
    }

    const html = await response.text();

    // Check if this is a valid channel page
    if (!html.includes('tgme_page_title') && !html.includes('tgme_channel_info')) {
      // Might be a private channel or invalid handle
      if (html.includes('This channel is private') || html.includes('not accessible')) {
        return {
          success: false,
          articles: [],
          error: `Channel @${handle} is private or not accessible`,
        };
      }
    }

    // Parse messages
    let articles = parseChannelHtml(html, handle, channelName);

    // Try fallback parser if main one didn't find anything
    if (articles.length === 0) {
      articles = parseChannelHtmlSimple(html, handle, channelName);
    }

    return {
      success: true,
      articles,
      latestId: articles[0]?.id,
    };
  } catch (error) {
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

/**
 * Clear rate limit tracking (useful for testing).
 */
export function clearRateLimitTracking(): void {
  lastRequestTime.clear();
}
