/**
 * Telegram Channel Fetcher
 *
 * Fetches messages from public Telegram channels using the web preview.
 * Uses t.me/s/{channel} which provides public access without authentication.
 *
 * Parsing logic lives in web-shared/telegram.ts (shared with web-fetch plugin).
 * This module handles: fetching, rate limiting, pagination, and mapping to FetchedArticle.
 */

import type { FetchedArticle } from '../types.js';
import {
  parseTelegramHtml,
  truncate,
  type TelegramParsedMessage,
  type TelegramParsedContent,
} from '../../web-shared/telegram.js';

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
  /** Cursor for fetching older messages (pagination) */
  nextBefore?: string | undefined;
}

/**
 * Map a TelegramParsedMessage to a FetchedArticle.
 *
 * Reconstructs the same title/summary format as the original parseMessageElement:
 * - Title: media tags + forwarded indicator + text excerpt (or type-specific content)
 * - Summary: reply context + continuation text + poll details + link preview
 */
function telegramMsgToArticle(
  msg: TelegramParsedMessage,
  channelHandle: string,
  channelName: string
): FetchedArticle {
  // Build title
  let title = '';

  // Start with media tags
  if (msg.mediaTags) {
    title = msg.mediaTags + ' ';
  }

  // Add forwarded indicator
  if (msg.forwardedFrom) {
    title += `[Fwd: ${truncate(msg.forwardedFrom, 25)}] `;
  }

  // Add text content or type-specific content
  if (msg.text) {
    const firstLine = msg.text.split(/[\n.]/).find((l) => l.trim()) ?? msg.text;
    title += truncate(firstLine, 150);
  } else if (msg.mediaTypes.includes('poll')) {
    title += msg.poll ? truncate(msg.poll.split('\n')[0] ?? 'Poll', 150) : 'Poll';
  } else if (msg.mediaTypes.includes('document') || msg.mediaTypes.includes('music')) {
    title += msg.document ?? 'Document';
  } else if (msg.mediaTypes.includes('voice')) {
    title += msg.voiceDuration ? `Voice message (${msg.voiceDuration})` : 'Voice message';
  } else if (msg.mediaTypes.includes('location')) {
    title += msg.location ?? 'Shared location';
  } else if (msg.mediaTypes.includes('contact')) {
    title += msg.contact ?? 'Contact';
  } else if (msg.mediaTypes.includes('unsupported')) {
    title += 'View in Telegram';
  } else if (msg.mediaTypes.includes('sticker')) {
    title += 'Sticker';
  } else if (msg.mediaTypes.includes('photo')) {
    title += 'Photo';
  } else if (msg.mediaTypes.includes('video')) {
    title += 'Video';
  } else if (msg.mediaTypes.includes('gif')) {
    title += 'GIF';
  }

  title = title.trim();

  // Build summary
  const summaryParts: string[] = [];

  if (msg.replyTo) {
    summaryParts.push(`Reply to: ${msg.replyTo}`);
  }

  if (msg.text) {
    const lines = msg.text.split('\n').filter((l) => l.trim());
    if (lines.length > 1) {
      summaryParts.push(truncate(lines.slice(1).join(' '), 400));
    }
  }

  // Add poll details to summary
  if (msg.mediaTypes.includes('poll') && msg.poll) {
    const pollLines = msg.poll.split('\n').slice(1); // Skip question (in title)
    if (pollLines.length > 0) {
      summaryParts.push(pollLines.join(' | '));
    }
  }

  // Add link preview to summary
  if (msg.linkPreview) {
    summaryParts.push(`Link: ${msg.linkPreview}`);
  }

  const summary = summaryParts.length > 0 ? truncate(summaryParts.join(' — '), 500) : undefined;

  // Parse date
  const publishedAt = msg.date ? new Date(msg.date) : undefined;

  return {
    id: `tg_${channelHandle}_${msg.id}`,
    title: title || `Message ${msg.id}`,
    summary,
    url: `https://t.me/${channelHandle}/${msg.id}`,
    sourceId: `telegram:${channelHandle}`,
    sourceName: channelName,
    publishedAt: publishedAt && !isNaN(publishedAt.getTime()) ? publishedAt : undefined,
  };
}

/**
 * Convert parsed Telegram content to FetchedArticles.
 */
function parsedToArticles(
  parsed: TelegramParsedContent,
  channelHandle: string,
  channelName: string
): { articles: FetchedArticle[]; nextBefore: string | null } {
  const articles = parsed.messages.map((msg) =>
    telegramMsgToArticle(msg, channelHandle, channelName)
  );

  return {
    articles,
    nextBefore: parsed.nextBefore ?? null,
  };
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
 * @param beforeId - Optional message ID to fetch older messages (pagination)
 * @returns Fetch result with articles or error
 */
export async function fetchTelegramChannel(
  channelHandle: string,
  channelName: string,
  beforeId?: string
): Promise<TelegramFetchResult> {
  // Normalize handle (remove @ if present)
  const handle = channelHandle.startsWith('@') ? channelHandle.slice(1) : channelHandle;

  try {
    // Apply rate limiting
    await applyRateLimit(handle);

    // Build URL with optional pagination
    let url = `https://t.me/s/${handle}`;
    if (beforeId) {
      url += `?before=${beforeId}`;
    }

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

    // Check for empty results
    if (html.includes('tme_no_messages_found')) {
      return {
        success: true,
        articles: [],
      };
    }

    // Parse messages using shared parser
    const parsed = parseTelegramHtml(html, handle);
    const { articles, nextBefore } = parsedToArticles(parsed, handle, channelName);

    return {
      success: true,
      articles,
      latestId: articles[0]?.id,
      nextBefore: nextBefore ?? undefined,
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

/**
 * Parse HTML string directly (exported for testing).
 */
export function parseHtml(
  html: string,
  channelHandle: string,
  channelName: string
): FetchedArticle[] {
  const parsed = parseTelegramHtml(html, channelHandle);
  return parsedToArticles(parsed, channelHandle, channelName).articles;
}

/**
 * Maximum pages to fetch in a single polling operation.
 * Prevents infinite loops on very active channels.
 */
const MAX_POLL_PAGES = 10;

/**
 * Fetch messages from a Telegram channel until we reach a known message ID.
 * Used for polling to catch all new messages since last fetch.
 *
 * @param channelHandle - Channel handle (with or without @)
 * @param channelName - Human-readable channel name
 * @param lastSeenId - Stop when we reach this message ID (e.g., "tg_channel_12345")
 * @param maxPages - Maximum pages to fetch (default: 10)
 * @returns Fetch result with all new articles
 */
export async function fetchTelegramChannelUntil(
  channelHandle: string,
  channelName: string,
  lastSeenId?: string,
  maxPages: number = MAX_POLL_PAGES
): Promise<TelegramFetchResult> {
  const allArticles: FetchedArticle[] = [];
  let currentBefore: string | undefined;
  let pagesLoaded = 0;
  let latestId: string | undefined;
  let foundLastSeen = false;

  // Extract the numeric message ID from lastSeenId (format: "tg_channel_12345")
  const lastSeenNumericId = lastSeenId ? parseInt(lastSeenId.split('_').pop() ?? '0', 10) : 0;

  while (pagesLoaded < maxPages) {
    const result = await fetchTelegramChannel(channelHandle, channelName, currentBefore);

    if (!result.success) {
      // If we already have some articles, return them with a warning
      if (allArticles.length > 0) {
        return {
          success: true,
          articles: allArticles,
          latestId,
          error: `Partial fetch: ${result.error ?? 'unknown error'}`,
        };
      }
      return result;
    }

    // Track the latest ID from the first page
    if (pagesLoaded === 0 && result.latestId) {
      latestId = result.latestId;
    }

    // Filter and add articles
    for (const article of result.articles) {
      const articleNumericId = parseInt(article.id.split('_').pop() ?? '0', 10);

      // Stop only if we find the EXACT lastSeenId.
      // Using === instead of <= because deleted messages can leave lastSeenId
      // higher than the current max ID (e.g., lastSeenId=26580 but max post is 26573).
      // The MAX_POLL_PAGES limit prevents infinite pagination in edge cases.
      if (lastSeenNumericId > 0 && articleNumericId === lastSeenNumericId) {
        foundLastSeen = true;
        break;
      }

      allArticles.push(article);
    }

    pagesLoaded++;

    // Stop conditions
    if (foundLastSeen) {
      break; // Found the last seen article
    }

    if (!result.nextBefore) {
      break; // No more pages
    }

    if (result.articles.length === 0) {
      break; // Empty page
    }

    // Move to next page
    currentBefore = result.nextBefore;
  }

  // Sort all articles by ID descending (newest first)
  allArticles.sort((a, b) => {
    const idA = parseInt(a.id.split('_').pop() ?? '0', 10);
    const idB = parseInt(b.id.split('_').pop() ?? '0', 10);
    return idB - idA;
  });

  return {
    success: true,
    articles: allArticles,
    latestId: latestId ?? allArticles[0]?.id,
  };
}
