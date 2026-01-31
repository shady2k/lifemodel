/**
 * News Types
 *
 * Type definitions for the news processing pipeline.
 * NewsArticle is the structured data flowing through brain layers.
 *
 * Note: User interest configuration (topic weights, urgency) is defined
 * in src/types/user/interests.ts as generic user model data, not news-specific.
 */

/**
 * Article as processed for brain layer consumption.
 *
 * This is the signal payload format - enriched from raw fetched data
 * with topic extraction and breaking pattern detection.
 *
 * Note: Using explicit undefined unions for exactOptionalPropertyTypes compatibility.
 */
export interface NewsArticle {
  /** Unique article identifier from source */
  id: string;

  /** Article title */
  title: string;

  /** Source identifier (e.g., 'rss:techcrunch', 'telegram:@channel') */
  source: string;

  /** Extracted keywords/topics (lowercase, deduplicated) */
  topics: string[];

  /** Link to full article */
  url?: string | undefined;

  /** Article summary/description */
  summary?: string | undefined;

  /** Publication date if available */
  publishedAt?: Date | undefined;

  /** Contains urgent patterns like "BREAKING", "URGENT", etc. */
  hasBreakingPattern: boolean;
}

/**
 * Payload for news:article_batch plugin_event signals.
 */
export interface NewsArticleBatchPayload {
  /** Articles in this batch */
  articles: NewsArticle[];

  /** Source ID that produced these articles */
  sourceId: string;

  /** When the fetch occurred */
  fetchedAt: Date;
}
