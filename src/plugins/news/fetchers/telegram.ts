/**
 * Telegram Channel Fetcher
 *
 * Fetches messages from public Telegram channels using the web preview.
 * Uses t.me/s/{channel} which provides public access without authentication.
 *
 * Comprehensive support for all message types based on RSSHub's implementation:
 * - Text messages
 * - Photos, videos, GIFs
 * - Voice messages, documents, music
 * - Stickers (static, animated, video)
 * - Polls, locations, contacts
 * - Forwarded messages, replies
 * - Link previews
 * - Unsupported content (with fallback)
 */

import type { HTMLElement } from 'node-html-parser';
import { parse } from 'node-html-parser';
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
  /** Cursor for fetching older messages (pagination) */
  nextBefore?: string | undefined;
}

/**
 * Message type detected from HTML.
 */
type MessageType =
  | 'text'
  | 'photo'
  | 'video'
  | 'gif'
  | 'voice'
  | 'document'
  | 'music'
  | 'sticker'
  | 'poll'
  | 'location'
  | 'contact'
  | 'unsupported'
  | 'service';

/**
 * Emoji tags for message types (optional display).
 */
const MESSAGE_TYPE_EMOJI: Record<MessageType, string> = {
  text: '',
  photo: '🖼',
  video: '🎬',
  gif: '🎞',
  voice: '🎤',
  document: '📎',
  music: '🎵',
  sticker: '🏷',
  poll: '📊',
  location: '📍',
  contact: '👤',
  unsupported: '⚠️',
  service: 'ℹ️',
};

/**
 * Text tags for message types.
 */
const MESSAGE_TYPE_TAG: Record<MessageType, string> = {
  text: '',
  photo: '[Photo]',
  video: '[Video]',
  gif: '[GIF]',
  voice: '[Voice]',
  document: '[Document]',
  music: '[Music]',
  sticker: '[Sticker]',
  poll: '[Poll]',
  location: '[Location]',
  contact: '[Contact]',
  unsupported: '[Unsupported]',
  service: '[Service]',
};

/**
 * Clean text by decoding HTML entities and normalizing whitespace.
 */
function cleanText(text: string): string {
  if (!text) return '';

  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Truncate text to a maximum length.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Detect all media/content types present in a message.
 */
function detectMessageTypes(messageEl: HTMLElement): MessageType[] {
  const types: MessageType[] = [];

  // Service message (pinned, channel photo update, etc.)
  if (messageEl.classList.contains('service_message')) {
    types.push('service');
    return types;
  }

  // Video/GIF
  const videoPlayer = messageEl.querySelector('.tgme_widget_message_video_player');
  if (videoPlayer) {
    const hasPlayIcon = videoPlayer.querySelector('.message_video_play');
    types.push(hasPlayIcon ? 'video' : 'gif');
  }

  // Photo
  if (messageEl.querySelector('.tgme_widget_message_photo')) {
    types.push('photo');
  }

  // Voice message
  if (messageEl.querySelector('audio.tgme_widget_message_voice')) {
    types.push('voice');
  }

  // Document/Music
  const docWrap = messageEl.querySelector('.tgme_widget_message_document_wrap');
  if (docWrap) {
    const isMusic = docWrap.querySelector('.audio');
    types.push(isMusic ? 'music' : 'document');
  }

  // Sticker (regular, animated, video)
  if (
    messageEl.querySelector('.tgme_widget_message_sticker') ||
    messageEl.querySelector('.tgme_widget_message_tgsticker') ||
    messageEl.querySelector('.tgme_widget_message_videosticker')
  ) {
    types.push('sticker');
  }

  // Poll
  if (messageEl.querySelector('.tgme_widget_message_poll')) {
    types.push('poll');
  }

  // Location
  if (messageEl.querySelector('.tgme_widget_message_location_wrap')) {
    types.push('location');
  }

  // Contact
  if (messageEl.querySelector('.tgme_widget_message_contact_name')) {
    types.push('contact');
  }

  // Unsupported content
  const unsupported = messageEl.querySelector('.message_media_not_supported');
  if (unsupported) {
    // Check if there's partial support
    const hasPartialSupport = messageEl.querySelector('.media_supported_cont');
    if (!hasPartialSupport) {
      types.push('unsupported');
    }
  }

  // Text (check last, as most messages have text)
  if (messageEl.querySelector('.tgme_widget_message_text')) {
    types.push('text');
  }

  return types;
}

/**
 * Extract poll information.
 */
function extractPoll(messageEl: HTMLElement): string | null {
  const pollEl = messageEl.querySelector('.tgme_widget_message_poll');
  if (!pollEl) return null;

  const question = pollEl.querySelector('.tgme_widget_message_poll_question')?.text;
  const type = pollEl.querySelector('.tgme_widget_message_poll_type')?.text;
  const options = pollEl.querySelectorAll('.tgme_widget_message_poll_option');

  const optionTexts = options.map((opt) => {
    const percent = opt.querySelector('.tgme_widget_message_poll_option_percent')?.text ?? '';
    const text = opt.querySelector('.tgme_widget_message_poll_option_text')?.text ?? '';
    return `${percent} ${text}`.trim();
  });

  return [question, type ? `(${type})` : '', ...optionTexts].filter(Boolean).join('\n');
}

/**
 * Extract document/file information.
 */
function extractDocument(messageEl: HTMLElement): string | null {
  const docWrap = messageEl.querySelector('.tgme_widget_message_document_wrap');
  if (!docWrap) return null;

  const title = docWrap.querySelector('.tgme_widget_message_document_title')?.text;
  const extra = docWrap.querySelector('.tgme_widget_message_document_extra')?.text;

  return [title, extra].filter(Boolean).join(' - ');
}

/**
 * Extract voice message duration.
 */
function extractVoiceDuration(messageEl: HTMLElement): string | null {
  const duration = messageEl.querySelector('.tgme_widget_message_voice_duration')?.text;
  return duration ?? null;
}

/**
 * Extract location information.
 * Currently returns a simple string since the web preview only shows a map image.
 */
function extractLocation(_messageEl: HTMLElement): string {
  // Location shows as a map image in web preview, no additional details available
  return 'Shared location';
}

/**
 * Extract contact information.
 */
function extractContact(messageEl: HTMLElement): string | null {
  const name = messageEl.querySelector('.tgme_widget_message_contact_name')?.text;
  const phone = messageEl.querySelector('.tgme_widget_message_contact_phone')?.text;

  if (!name && !phone) return null;
  return [name, phone].filter(Boolean).join(': ');
}

/**
 * Extract forwarded source information.
 */
function extractForwardedFrom(messageEl: HTMLElement): string | null {
  const fwdEl = messageEl.querySelector('.tgme_widget_message_forwarded_from');
  if (!fwdEl) return null;

  const nameEl = fwdEl.querySelector('.tgme_widget_message_forwarded_from_name');
  const authorEl = fwdEl.querySelector('.tgme_widget_message_forwarded_from_author');

  const name = nameEl?.text ?? '';
  const author = authorEl?.text ?? '';

  const source = [name, author].filter(Boolean).join(' - ').replace('Forwarded from', '').trim();
  return source || null;
}

/**
 * Extract reply context.
 */
function extractReplyTo(messageEl: HTMLElement): string | null {
  const replyEl = messageEl.querySelector('.tgme_widget_message_reply');
  if (!replyEl) return null;

  const author = replyEl.querySelector('.tgme_widget_message_author_name')?.text;
  const text = replyEl.querySelector('.tgme_widget_message_metatext')?.text;

  return [author ? `@${author}` : '', text].filter(Boolean).join(': ') || null;
}

/**
 * Extract link preview information.
 */
function extractLinkPreview(messageEl: HTMLElement): string | null {
  const previewEl = messageEl.querySelector('.tgme_widget_message_link_preview');
  if (!previewEl) return null;

  const site = previewEl.querySelector('.link_preview_site_name')?.text;
  const title = previewEl.querySelector('.link_preview_title')?.text;
  const desc = previewEl.querySelector('.link_preview_description')?.text;
  const href = previewEl.getAttribute('href');

  const parts = [site, title, desc].filter(Boolean);
  if (parts.length === 0) return null;

  return parts.join(' - ') + (href ? ` (${href})` : '');
}

/**
 * Build media type tags for title.
 */
function buildMediaTags(types: MessageType[], useEmoji = false): string {
  const tags = types
    .filter((t) => t !== 'text') // Don't tag pure text
    .map((t) => (useEmoji ? MESSAGE_TYPE_EMOJI[t] : MESSAGE_TYPE_TAG[t]))
    .filter(Boolean);

  return tags.join(' ');
}

/**
 * Extract message data from a Telegram message element.
 */
function parseMessageElement(
  messageEl: HTMLElement,
  channelHandle: string,
  channelName: string
): FetchedArticle | null {
  // Get post ID (format: "channel/messageId")
  const postId = messageEl.getAttribute('data-post');
  if (!postId) return null;

  const messageId = postId.split('/')[1];
  if (!messageId) return null;

  // Detect all content types
  const types = detectMessageTypes(messageEl);

  // Skip if no content detected at all
  if (types.length === 0) return null;

  // Extract text content
  const textEl = messageEl.querySelector('.tgme_widget_message_text');
  const text = textEl ? cleanText(textEl.text) : '';

  // Extract metadata
  const forwardedFrom = extractForwardedFrom(messageEl);
  const replyTo = extractReplyTo(messageEl);

  // Extract date
  const dateEl = messageEl.querySelector('.tgme_widget_message_date time');
  const dateStr = dateEl?.getAttribute('datetime');
  const publishedAt = dateStr ? new Date(dateStr) : undefined;

  // Build title
  const mediaTags = buildMediaTags(types);
  let title = '';

  // Start with media tags
  if (mediaTags) {
    title = mediaTags + ' ';
  }

  // Add forwarded indicator
  if (forwardedFrom) {
    title += `[Fwd: ${truncate(forwardedFrom, 25)}] `;
  }

  // Add text content or type-specific content
  if (text) {
    const firstLine = text.split(/[\n.]/).find((l) => l.trim()) ?? text;
    title += truncate(firstLine, 150);
  } else if (types.includes('poll')) {
    const pollInfo = extractPoll(messageEl);
    title += pollInfo ? truncate(pollInfo.split('\n')[0] ?? 'Poll', 150) : 'Poll';
  } else if (types.includes('document') || types.includes('music')) {
    const docInfo = extractDocument(messageEl);
    title += docInfo ?? 'Document';
  } else if (types.includes('voice')) {
    const duration = extractVoiceDuration(messageEl);
    title += duration ? `Voice message (${duration})` : 'Voice message';
  } else if (types.includes('location')) {
    title += extractLocation(messageEl);
  } else if (types.includes('contact')) {
    const contactInfo = extractContact(messageEl);
    title += contactInfo ?? 'Contact';
  } else if (types.includes('unsupported')) {
    title += 'View in Telegram';
  } else if (types.includes('sticker')) {
    title += 'Sticker';
  } else if (types.includes('photo')) {
    title += 'Photo';
  } else if (types.includes('video')) {
    title += 'Video';
  } else if (types.includes('gif')) {
    title += 'GIF';
  }

  title = title.trim();

  // Build summary
  const summaryParts: string[] = [];

  if (replyTo) {
    summaryParts.push(`Reply to: ${replyTo}`);
  }

  if (text) {
    const lines = text.split('\n').filter((l) => l.trim());
    if (lines.length > 1) {
      summaryParts.push(truncate(lines.slice(1).join(' '), 400));
    }
  }

  // Add poll details to summary
  if (types.includes('poll')) {
    const pollInfo = extractPoll(messageEl);
    if (pollInfo) {
      const pollLines = pollInfo.split('\n').slice(1); // Skip question (in title)
      if (pollLines.length > 0) {
        summaryParts.push(pollLines.join(' | '));
      }
    }
  }

  // Add link preview to summary
  const linkPreview = extractLinkPreview(messageEl);
  if (linkPreview) {
    summaryParts.push(`Link: ${linkPreview}`);
  }

  const summary = summaryParts.length > 0 ? truncate(summaryParts.join(' — '), 500) : undefined;

  return {
    id: `tg_${channelHandle}_${messageId}`,
    title: title || `Message ${messageId}`,
    summary,
    url: `https://t.me/${channelHandle}/${messageId}`,
    sourceId: `telegram:${channelHandle}`,
    sourceName: channelName,
    publishedAt: publishedAt && !isNaN(publishedAt.getTime()) ? publishedAt : undefined,
  };
}

/**
 * Result of parsing channel HTML.
 */
interface ParseResult {
  articles: FetchedArticle[];
  /** Cursor for next page (older messages) */
  nextBefore: string | null;
}

/**
 * Parse the HTML response from t.me/s/{channel}.
 * Extracts all messages using proper HTML parsing.
 */
function parseChannelHtml(html: string, channelHandle: string, channelName: string): ParseResult {
  const root = parse(html);
  const articles: FetchedArticle[] = [];

  // Find all message elements (excluding service messages optionally)
  const messageElements = root.querySelectorAll('.tgme_widget_message');

  for (const messageEl of messageElements) {
    const article = parseMessageElement(messageEl, channelHandle, channelName);
    if (article) {
      articles.push(article);
    }
  }

  // Sort by message ID descending (newest first)
  articles.sort((a, b) => {
    const idA = parseInt(a.id.split('_').pop() ?? '0', 10);
    const idB = parseInt(b.id.split('_').pop() ?? '0', 10);
    return idB - idA;
  });

  // Extract pagination cursor for older messages
  const loadMoreEl = root.querySelector('.tme_messages_more');
  const nextBefore = loadMoreEl?.getAttribute('data-before') ?? null;

  return { articles, nextBefore };
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

    // Parse messages
    const { articles, nextBefore } = parseChannelHtml(html, handle, channelName);

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
  return parseChannelHtml(html, channelHandle, channelName).articles;
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

      // Stop if we've reached the last seen article
      if (lastSeenNumericId > 0 && articleNumericId <= lastSeenNumericId) {
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
