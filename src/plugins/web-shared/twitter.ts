/**
 * Twitter/X Shared Helpers
 *
 * Detects Twitter/X URLs and rewrites them to the FxTwitter API
 * (api.fxtwitter.com) which returns clean JSON without auth or JS rendering.
 *
 * Unlike Telegram (which needs HTML parsing), FxTwitter returns structured JSON,
 * so we just need URL detection, rewriting, and JSON→markdown formatting.
 */

// ═══════════════════════════════════════════════════════════════
// URL DETECTION & NORMALIZATION
// ═══════════════════════════════════════════════════════════════

const TWITTER_HOSTS = new Set(['twitter.com', 'www.twitter.com', 'x.com', 'www.x.com']);

/**
 * Check if a URL points to Twitter/X.
 */
export function isTwitterUrl(url: URL): boolean {
  return TWITTER_HOSTS.has(url.hostname.toLowerCase());
}

/**
 * Check if a Twitter URL points to a specific tweet/status.
 * Pattern: /:username/status/:id
 */
export function isTwitterStatusUrl(url: URL): boolean {
  if (!isTwitterUrl(url)) return false;
  const segments = url.pathname.split('/').filter(Boolean);
  return segments.length >= 3 && segments[1] === 'status' && /^\d+$/.test(segments[2] ?? '');
}

/**
 * Rewrite a Twitter/X status URL to the FxTwitter JSON API.
 *
 * `x.com/user/status/123` → `api.fxtwitter.com/user/status/123`
 *
 * Non-status URLs (profiles, search, etc.) are returned unchanged since
 * FxTwitter only supports individual tweet fetches.
 */
export function normalizeTwitterUrl(url: URL): { url: URL; isApi: boolean } {
  if (!isTwitterUrl(url) || !isTwitterStatusUrl(url)) {
    return { url, isApi: false };
  }

  const segments = url.pathname.split('/').filter(Boolean);
  // segments = [username, 'status', tweetId, ...]
  const username = segments[0] ?? '';
  const tweetId = segments[2] ?? '';

  const apiUrl = new URL(`https://api.fxtwitter.com/${username}/status/${tweetId}`);
  return { url: apiUrl, isApi: true };
}

// ═══════════════════════════════════════════════════════════════
// JSON → MARKDOWN FORMATTING
// ═══════════════════════════════════════════════════════════════

/** Shape of the FxTwitter API response (relevant fields only). */
interface FxTweetResponse {
  code?: number;
  message?: string;
  tweet?: {
    url?: string;
    text?: string;
    author?: {
      name?: string;
      screen_name?: string;
    };
    created_at?: string;
    replies?: number;
    retweets?: number;
    likes?: number;
    views?: number;
    media?: {
      photos?: { url?: string }[];
      videos?: { url?: string; thumbnail_url?: string }[];
    };
    quote?: {
      text?: string;
      author?: { name?: string; screen_name?: string };
    };
  };
}

/**
 * Format FxTwitter JSON API response as readable markdown.
 */
export function formatTweetAsMarkdown(json: unknown): string {
  const data = json as FxTweetResponse;

  if (!data.tweet) {
    return data.message ?? 'Tweet not found';
  }

  const t = data.tweet;
  const author = t.author;
  const lines: string[] = [];

  // Author + handle
  if (author) {
    const name = author.name ?? author.screen_name ?? 'Unknown';
    const handle = author.screen_name ? `@${author.screen_name}` : '';
    lines.push(`**${name}** ${handle}`);
  }

  // Date
  if (t.created_at) {
    lines.push(`*${t.created_at}*`);
  }

  lines.push('');

  // Tweet text
  if (t.text) {
    lines.push(t.text);
  }

  // Quoted tweet
  if (t.quote) {
    lines.push('');
    const qAuthor = t.quote.author;
    const qName = qAuthor?.name ?? qAuthor?.screen_name ?? 'Unknown';
    const qHandle = qAuthor?.screen_name ? `@${qAuthor.screen_name}` : '';
    lines.push(`> **${qName}** ${qHandle}`);
    if (t.quote.text) {
      lines.push(`> ${t.quote.text.split('\n').join('\n> ')}`);
    }
  }

  // Media
  const photos = t.media?.photos;
  if (photos && photos.length > 0) {
    lines.push('');
    for (const photo of photos) {
      if (photo.url) lines.push(`![photo](${photo.url})`);
    }
  }

  const videos = t.media?.videos;
  if (videos && videos.length > 0) {
    lines.push('');
    for (const video of videos) {
      if (video.url) lines.push(`[Video](${video.url})`);
    }
  }

  // Engagement
  const stats: string[] = [];
  if (t.replies !== undefined) stats.push(`${String(t.replies)} replies`);
  if (t.retweets !== undefined) stats.push(`${String(t.retweets)} retweets`);
  if (t.likes !== undefined) stats.push(`${String(t.likes)} likes`);
  if (t.views !== undefined) stats.push(`${String(t.views)} views`);
  if (stats.length > 0) {
    lines.push('');
    lines.push(stats.join(' · '));
  }

  // Original URL
  if (t.url) {
    lines.push('');
    lines.push(`[View on X](${t.url})`);
  }

  return lines.join('\n');
}
