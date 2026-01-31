/**
 * News Types
 *
 * Type definitions for the news processing pipeline.
 * NewsArticle is the structured data flowing through brain layers.
 * NewsInterests stores user preferences for scoring.
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

/**
 * User's news interest configuration.
 *
 * Stored in user model - beliefs about what the user cares about.
 * Used by NewsSignalFilter to score articles.
 */
export interface NewsInterests {
  /**
   * Topic weights (learned).
   * - weight > 0 means interested (higher = more interested)
   * - weight === 0 means suppressed/blocked
   * Keys are lowercase topic names.
   */
  weights: Record<string, number>;

  /**
   * Per-topic urgency multiplier.
   * Determines how aggressively to interrupt for this topic.
   * Range: 0-1 (0 = never interrupt, 1 = always interrupt if interesting)
   */
  urgency: Record<string, number>;

  /**
   * Source reputation scores.
   * Default 0.5 if not specified.
   * Range: 0-1 (0 = untrusted, 1 = highly trusted)
   */
  sourceReputation?: Record<string, number> | undefined;

  /**
   * Topic baselines for volume anomaly detection.
   * Used to detect unusual spikes in article volume.
   */
  topicBaselines: Record<
    string,
    {
      /** Average articles per fetch for this topic */
      avgVolume: number;
      /** When baseline was last updated */
      lastUpdated: Date;
    }
  >;
}

/**
 * Create default empty news interests.
 */
export function createDefaultNewsInterests(): NewsInterests {
  return {
    weights: {},
    urgency: {},
    topicBaselines: {},
  };
}
