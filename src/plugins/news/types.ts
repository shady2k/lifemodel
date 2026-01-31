/**
 * News Plugin Types
 *
 * Type definitions for news sources and fetch state tracking.
 * Plugin owns fetch tracking only - article data is stored in core memory (SRP).
 */

/**
 * Storage keys for news plugin data.
 */
export const NEWS_STORAGE_KEYS = {
  /** List of configured news sources */
  SOURCES: 'sources',
  /** Per-source fetch state (keyed by source ID) */
  SOURCE_STATE_PREFIX: 'state:',
} as const;

/**
 * Event kinds emitted by the news plugin.
 */
export const NEWS_EVENT_KINDS = {
  /** Scheduled poll event - triggers feed fetching */
  POLL_FEEDS: 'news:poll_feeds',
} as const;

/**
 * Plugin ID for news plugin.
 */
export const NEWS_PLUGIN_ID = 'news';

/**
 * Type of news source.
 */
export type NewsSourceType = 'rss' | 'telegram';

/**
 * Configuration for a news source.
 * Stored in plugin storage, managed via the news tool.
 */
export interface NewsSource {
  /** Unique source identifier (auto-generated) */
  id: string;

  /** Source type: RSS feed or Telegram channel */
  type: NewsSourceType;

  /** RSS URL or Telegram @channel_handle */
  url: string;

  /** Human-readable display name */
  name: string;

  /** Whether this source is actively monitored */
  enabled: boolean;

  /** When the source was added */
  createdAt: Date;
}

/**
 * Per-source fetch state for deduplication and health tracking.
 * Stored separately from source config to allow independent updates.
 * Note: Using explicit undefined unions for exactOptionalPropertyTypes compatibility.
 */
export interface SourceState {
  /** Source ID this state belongs to */
  sourceId: string;

  /** Last processed article/message ID (primary deduplication) */
  lastSeenId?: string | undefined;

  /** Fallback hash if source doesn't provide stable IDs */
  lastSeenHash?: string | undefined;

  /** When the source was last successfully fetched */
  lastFetchedAt: Date;

  /** Consecutive fetch failures (reset on success) */
  consecutiveFailures: number;

  /** Last error message if in failed state */
  lastError?: string | undefined;
}

/**
 * Article fetched from a news source.
 * Used internally during fetch/process cycle.
 * Not persisted by plugin - COGNITION stores interesting articles via core.remember.
 * Note: Using explicit undefined unions for exactOptionalPropertyTypes compatibility.
 */
export interface FetchedArticle {
  /** Unique article identifier from source (guid, link, or hash) */
  id: string;

  /** Article title */
  title: string;

  /** Article summary/description (sanitized) */
  summary?: string | undefined;

  /** Link to full article */
  url?: string | undefined;

  /** Source ID this article came from */
  sourceId: string;

  /** Source display name */
  sourceName: string;

  /** Publication date if available */
  publishedAt?: Date | undefined;
}

/**
 * Result from the news tool.
 * Note: Using explicit undefined unions for exactOptionalPropertyTypes compatibility.
 */
export interface NewsToolResult {
  success: boolean;
  action: string;
  sourceId?: string | undefined;
  sources?: NewsSummary[] | undefined;
  total?: number | undefined;
  error?: string | undefined;
  receivedParams?: string[] | undefined;
  schema?: Record<string, unknown> | undefined;
}

/**
 * Summary of a news source for list action.
 * Note: Using explicit undefined unions for exactOptionalPropertyTypes compatibility.
 */
export interface NewsSummary {
  id: string;
  type: NewsSourceType;
  name: string;
  url: string;
  enabled: boolean;
  lastFetchedAt?: Date | undefined;
  consecutiveFailures?: number | undefined;
}
