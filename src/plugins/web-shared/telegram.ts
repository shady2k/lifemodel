/**
 * Telegram Shared Parser
 *
 * Extracts and formats messages from Telegram's public web preview pages (t.me/s/channel).
 * Used by both web-fetch (generic URL fetching) and news plugin (feed polling).
 *
 * Comprehensive support for all message types based on RSSHub's implementation:
 * - Text messages, photos, videos, GIFs
 * - Voice messages, documents, music
 * - Stickers (static, animated, video)
 * - Polls, locations, contacts
 * - Forwarded messages, replies
 * - Link previews
 * - Unsupported content (with fallback)
 */

import type { HTMLElement } from 'node-html-parser';
import { parse } from 'node-html-parser';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

/**
 * Message type detected from HTML.
 */
export type MessageType =
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
 * A single parsed Telegram message.
 */
export interface TelegramParsedMessage {
  /** Numeric message ID string */
  id: string;
  /** Direct link t.me/channel/id */
  url: string;
  /** Main text content */
  text: string;
  /** ISO date string */
  date?: string | undefined;
  /** Detected content types (includes 'service' type) */
  mediaTypes: MessageType[];
  /** Pre-formatted "[photo][video]" etc. */
  mediaTags?: string | undefined;
  /** Source of forwarded message */
  forwardedFrom?: string | undefined;
  /** Reply context */
  replyTo?: string | undefined;
  /** Link preview info */
  linkPreview?: string | undefined;
  /** Poll question and options */
  poll?: string | undefined;
  /** Document/file info */
  document?: string | undefined;
  /** Contact name/phone */
  contact?: string | undefined;
  /** Location description */
  location?: string | undefined;
  /** Voice message duration */
  voiceDuration?: string | undefined;
}

/**
 * Result of parsing a Telegram channel page.
 */
export interface TelegramParsedContent {
  /** Channel display name */
  channelName?: string | undefined;
  /** Channel @handle */
  channelHandle?: string | undefined;
  /** Parsed messages (newest first) */
  messages: TelegramParsedMessage[];
  /** Pagination cursor — message ID for fetching older messages */
  nextBefore?: string | undefined;
}

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════

/**
 * Text tags for message types.
 */
export const MESSAGE_TYPE_TAG: Record<MessageType, string> = {
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
 * Emoji tags for message types.
 */
export const MESSAGE_TYPE_EMOJI: Record<MessageType, string> = {
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
 * Telegram reserved path prefixes that are NOT channel handles.
 */
const TELEGRAM_RESERVED_PATHS = new Set([
  'joinchat',
  'addstickers',
  'addtheme',
  'share',
  'proxy',
  'socks',
  'setlanguage',
  'addemoji',
  'login',
  'addlist',
  'boost',
  'c', // private channel links
  'iv', // instant view
  'dl', // download
  'msg', // message links via bot
]);

// ═══════════════════════════════════════════════════════════════
// URL HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Check if a URL points to a Telegram channel or post.
 */
export function isTelegramUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === 't.me' || host === 'telegram.me';
}

/**
 * Normalize a Telegram URL for fetching.
 *
 * Rewrites `t.me/channel/123` → `t.me/s/channel` (public preview page).
 * Extracts postId when a specific message is requested.
 * Returns unchanged URL for non-rewritable paths (invites, private links, etc.).
 */
export function normalizeTelegramUrl(url: URL): { url: URL; postId?: string | undefined } {
  if (!isTelegramUrl(url)) {
    return { url };
  }

  // Force HTTPS
  const normalized = new URL(url.href);
  normalized.protocol = 'https:';

  const segments = normalized.pathname.split('/').filter(Boolean);

  // Already a /s/ URL — pass through
  if (segments[0] === 's') {
    return { url: normalized };
  }

  // No path segments — homepage
  if (segments.length === 0) {
    return { url: normalized };
  }

  const firstSegment = segments[0] ?? '';

  // Invite links: t.me/+xxx
  if (firstSegment.startsWith('+')) {
    return { url: normalized };
  }

  // Reserved paths (joinchat, share, c, addstickers, etc.)
  if (TELEGRAM_RESERVED_PATHS.has(firstSegment.toLowerCase())) {
    return { url: normalized };
  }

  // Channel handle: must be alphanumeric + underscore, 4+ chars
  // (Telegram handles are 5-32 chars, but we use 4 to be slightly permissive)
  if (!/^[A-Za-z0-9_]{4,}$/.test(firstSegment)) {
    return { url: normalized };
  }

  // Extract post ID if present (t.me/channel/123)
  let postId: string | undefined;
  const secondSegment = segments[1];
  if (secondSegment !== undefined && /^\d+$/.test(secondSegment)) {
    postId = secondSegment;
  }

  // Rewrite to /s/ URL
  normalized.pathname = `/s/${firstSegment}`;
  // Clear any existing search params (post URLs don't need them)
  if (postId) {
    normalized.search = '';
  }

  return { url: normalized, postId };
}

// ═══════════════════════════════════════════════════════════════
// TEXT HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Clean text by decoding HTML entities and normalizing whitespace.
 */
export function cleanText(text: string): string {
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
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

// ═══════════════════════════════════════════════════════════════
// HTML ELEMENT EXTRACTORS
// ═══════════════════════════════════════════════════════════════

/**
 * Detect all media/content types present in a message.
 */
export function detectMessageTypes(messageEl: HTMLElement): MessageType[] {
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
  const unsupported = messageEl.querySelector('.media_supported_cont');
  if (messageEl.querySelector('.message_media_not_supported') && !unsupported) {
    types.push('unsupported');
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
export function extractPoll(messageEl: HTMLElement): string | null {
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
export function extractDocument(messageEl: HTMLElement): string | null {
  const docWrap = messageEl.querySelector('.tgme_widget_message_document_wrap');
  if (!docWrap) return null;

  const title = docWrap.querySelector('.tgme_widget_message_document_title')?.text;
  const extra = docWrap.querySelector('.tgme_widget_message_document_extra')?.text;

  return [title, extra].filter(Boolean).join(' - ');
}

/**
 * Extract voice message duration.
 */
export function extractVoiceDuration(messageEl: HTMLElement): string | null {
  const duration = messageEl.querySelector('.tgme_widget_message_voice_duration')?.text;
  return duration ?? null;
}

/**
 * Extract location information.
 */
export function extractLocation(_messageEl: HTMLElement): string {
  return 'Shared location';
}

/**
 * Extract contact information.
 */
export function extractContact(messageEl: HTMLElement): string | null {
  const name = messageEl.querySelector('.tgme_widget_message_contact_name')?.text;
  const phone = messageEl.querySelector('.tgme_widget_message_contact_phone')?.text;

  if (!name && !phone) return null;
  return [name, phone].filter(Boolean).join(': ');
}

/**
 * Extract forwarded source information.
 */
export function extractForwardedFrom(messageEl: HTMLElement): string | null {
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
export function extractReplyTo(messageEl: HTMLElement): string | null {
  const replyEl = messageEl.querySelector('.tgme_widget_message_reply');
  if (!replyEl) return null;

  const author = replyEl.querySelector('.tgme_widget_message_author_name')?.text;
  const text = replyEl.querySelector('.tgme_widget_message_metatext')?.text;

  return [author ? `@${author}` : '', text].filter(Boolean).join(': ') || null;
}

/**
 * Extract link preview information.
 */
export function extractLinkPreview(messageEl: HTMLElement): string | null {
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
 * Build media type tags for display.
 */
export function buildMediaTags(types: MessageType[], useEmoji = false): string {
  const tags = types
    .filter((t) => t !== 'text')
    .map((t) => (useEmoji ? MESSAGE_TYPE_EMOJI[t] : MESSAGE_TYPE_TAG[t]))
    .filter(Boolean);

  return tags.join(' ');
}

// ═══════════════════════════════════════════════════════════════
// MESSAGE PARSER
// ═══════════════════════════════════════════════════════════════

/**
 * Parse a single Telegram message element into a TelegramParsedMessage.
 */
function parseMessageElement(
  messageEl: HTMLElement,
  channelHandle: string
): TelegramParsedMessage | null {
  const postId = messageEl.getAttribute('data-post');
  if (!postId) return null;

  const messageId = postId.split('/')[1];
  if (!messageId) return null;

  const types = detectMessageTypes(messageEl);
  if (types.length === 0) return null;

  // Text content
  const textEl = messageEl.querySelector('.tgme_widget_message_text');
  const text = textEl ? cleanText(textEl.text) : '';

  // Date
  const dateEl = messageEl.querySelector('.tgme_widget_message_date time');
  const dateStr = dateEl?.getAttribute('datetime');

  // Metadata
  const forwardedFrom = extractForwardedFrom(messageEl);
  const replyTo = extractReplyTo(messageEl);
  const linkPreview = extractLinkPreview(messageEl);
  const mediaTags = buildMediaTags(types);

  // Type-specific content
  const poll = types.includes('poll') ? (extractPoll(messageEl) ?? undefined) : undefined;
  const document =
    types.includes('document') || types.includes('music')
      ? (extractDocument(messageEl) ?? undefined)
      : undefined;
  const contact = types.includes('contact') ? (extractContact(messageEl) ?? undefined) : undefined;
  const location = types.includes('location') ? extractLocation(messageEl) : undefined;
  const voiceDuration = types.includes('voice')
    ? (extractVoiceDuration(messageEl) ?? undefined)
    : undefined;

  return {
    id: messageId,
    url: `https://t.me/${channelHandle}/${messageId}`,
    text,
    date: dateStr ?? undefined,
    mediaTypes: types,
    mediaTags: mediaTags || undefined,
    forwardedFrom: forwardedFrom ?? undefined,
    replyTo: replyTo ?? undefined,
    linkPreview: linkPreview ?? undefined,
    poll,
    document,
    contact,
    location,
    voiceDuration,
  };
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════

/**
 * Parse HTML from a Telegram channel page (t.me/s/channel).
 *
 * @param html - Raw HTML string from the channel page
 * @param handle - Channel handle (without @). If omitted, extracted from HTML.
 * @returns Parsed content with messages sorted newest-first
 */
export function parseTelegramHtml(html: string, handle?: string): TelegramParsedContent {
  const root = parse(html);

  // Extract channel info from page (try multiple selectors — Telegram uses different classes)
  const channelName =
    root.querySelector('.tgme_channel_info_header_title')?.text.trim() ??
    root.querySelector('.tgme_page_title')?.text.trim();

  // Try to detect handle from HTML if not provided
  let channelHandle = handle;
  if (!channelHandle) {
    // Look for canonical link or channel info link
    const channelLink = root.querySelector('.tgme_channel_info_header_username a');
    const href = channelLink?.getAttribute('href');
    if (href) {
      // e.g., "https://t.me/channelname"
      const match = /t\.me\/([A-Za-z0-9_]+)/.exec(href);
      if (match?.[1]) {
        channelHandle = match[1];
      }
    }
    // Fallback: extract from first message's data-post
    if (!channelHandle) {
      const firstMsg = root.querySelector('.tgme_widget_message');
      const post = firstMsg?.getAttribute('data-post');
      if (post) {
        channelHandle = post.split('/')[0];
      }
    }
    channelHandle = channelHandle ?? 'unknown';
  }

  // Parse all messages
  const messages: TelegramParsedMessage[] = [];
  const messageElements = root.querySelectorAll('.tgme_widget_message');

  for (const messageEl of messageElements) {
    const msg = parseMessageElement(messageEl, channelHandle);
    if (msg) {
      messages.push(msg);
    }
  }

  // Sort by message ID descending (newest first)
  messages.sort((a, b) => {
    const idA = parseInt(a.id, 10);
    const idB = parseInt(b.id, 10);
    return idB - idA;
  });

  // Extract pagination cursor
  const loadMoreEl = root.querySelector('.tme_messages_more');
  const nextBefore = loadMoreEl?.getAttribute('data-before') ?? undefined;

  return {
    channelName,
    channelHandle,
    messages,
    nextBefore,
  };
}

/**
 * Format parsed Telegram content as readable markdown.
 *
 * Produces a structured document suitable for the web-fetch response.
 */
export function formatTelegramAsMarkdown(parsed: TelegramParsedContent): string {
  const lines: string[] = [];

  // Header
  if (parsed.channelName) {
    lines.push(`# ${parsed.channelName}`);
    if (parsed.channelHandle) {
      lines.push(`**@${parsed.channelHandle}** on Telegram`);
    }
    lines.push('');
  }

  if (parsed.messages.length === 0) {
    lines.push('*No messages found.*');
    return lines.join('\n');
  }

  // Messages
  for (const msg of parsed.messages) {
    lines.push('---');
    lines.push('');

    // Message header: media tags + date
    const headerParts: string[] = [];
    if (msg.mediaTags) {
      headerParts.push(msg.mediaTags);
    }
    if (msg.date) {
      const d = new Date(msg.date);
      if (!isNaN(d.getTime())) {
        headerParts.push(
          d
            .toISOString()
            .replace('T', ' ')
            .replace(/\.\d+Z$/, ' UTC')
        );
      }
    }
    if (headerParts.length > 0) {
      lines.push(`**${headerParts.join(' | ')}**`);
    }

    // Forwarded indicator
    if (msg.forwardedFrom) {
      lines.push(`> Forwarded from: ${msg.forwardedFrom}`);
    }

    // Reply context
    if (msg.replyTo) {
      lines.push(`> Reply to: ${msg.replyTo}`);
    }

    // Main text
    if (msg.text) {
      lines.push('');
      lines.push(msg.text);
    }

    // Poll details
    if (msg.poll) {
      lines.push('');
      lines.push(msg.poll);
    }

    // Document info
    if (msg.document) {
      lines.push('');
      lines.push(`Document: ${msg.document}`);
    }

    // Voice duration
    if (msg.voiceDuration) {
      lines.push('');
      lines.push(`Voice message (${msg.voiceDuration})`);
    }

    // Contact
    if (msg.contact) {
      lines.push('');
      lines.push(`Contact: ${msg.contact}`);
    }

    // Location
    if (msg.location) {
      lines.push('');
      lines.push(msg.location);
    }

    // Link preview
    if (msg.linkPreview) {
      lines.push('');
      lines.push(`Link: ${msg.linkPreview}`);
    }

    // Message link
    lines.push('');
    lines.push(`[View message](${msg.url})`);
    lines.push('');
  }

  // Pagination footer
  if (parsed.nextBefore && parsed.channelHandle) {
    lines.push('---');
    lines.push(
      `*[Load older messages](https://t.me/s/${parsed.channelHandle}?before=${parsed.nextBefore})*`
    );
  }

  return lines.join('\n');
}
