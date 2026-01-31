/**
 * NewsSignalFilter - processes news article batches through scoring algorithms.
 *
 * This filter runs in the AUTONOMIC layer and classifies articles into:
 * - URGENT (urgency > 0.8): Wake COGNITION immediately
 * - INTERESTING (interest 0.4-1.0): Add to share queue
 * - NOISE (interest < 0.4): Filter out
 *
 * The filter receives user Interests via context.userModel.getInterests(),
 * populated by core from UserModel. This keeps the plugin decoupled from core.
 *
 * Scoring algorithms per spec:
 * - Interest: topicMatch × topicWeight × 0.5 + sourceReputation × 0.2 + noveltyBonus × 0.3
 * - Urgency: breakingBonus × 2.0 + volumeAnomaly × 1.5 + interestScore × topicUrgencyWeight
 */

import type { SignalFilter, FilterContext } from '../../layers/autonomic/filter-registry.js';
import type { Signal, PluginEventData, SignalType } from '../../types/signal.js';
import { createSignal } from '../../types/signal.js';
import type { NewsArticle } from '../../types/news.js';
import type { Interests } from '../../types/user/interests.js';
import type { Logger } from '../../types/logger.js';
import { NEWS_PLUGIN_ID, NEWS_EVENT_KINDS } from './types.js';

// ============================================================
// Types
// ============================================================

/**
 * Article with computed scores.
 */
export interface ScoredArticle {
  article: NewsArticle;
  interestScore: number;
  urgencyScore: number;
}

/**
 * Configuration for score thresholds.
 */
interface NewsFilterConfig {
  urgentThreshold: number;
  interestThreshold: number;
  defaultSourceReputation: number;
  noveltyBonus: number;
  breakingBonus: number;
}

const DEFAULT_CONFIG: NewsFilterConfig = {
  urgentThreshold: 0.8,
  interestThreshold: 0.4,
  defaultSourceReputation: 0.5,
  noveltyBonus: 0.3,
  breakingBonus: 0.3,
};

// ============================================================
// NewsSignalFilter
// ============================================================

/**
 * NewsSignalFilter implementation.
 */
export class NewsSignalFilter implements SignalFilter {
  readonly id = 'news-signal-filter';
  readonly description = 'Scores and classifies news articles by interest and urgency';
  readonly handles: SignalType[] = ['plugin_event'];

  private readonly logger: Logger;
  private readonly config: NewsFilterConfig;

  /** Topics seen in current session (for novelty detection) */
  private readonly seenTopics = new Set<string>();

  /** Article volume per topic in current batch (for anomaly detection) */
  private readonly batchVolumes = new Map<string, number>();

  constructor(logger: Logger, config: Partial<NewsFilterConfig> = {}) {
    this.logger = logger.child({ component: 'news-signal-filter' });
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Process signals - classify news article batches.
   */
  process(signals: Signal[], context: FilterContext): Signal[] {
    const result: Signal[] = [];

    // Get user interests from context (populated by core from UserModel)
    const interests = context.userModel?.getInterests() ?? null;

    for (const signal of signals) {
      const data = signal.data as PluginEventData | undefined;

      // Only process news:article_batch signals
      if (
        data?.kind !== 'plugin_event' ||
        data.eventKind !== NEWS_EVENT_KINDS.ARTICLE_BATCH ||
        data.pluginId !== NEWS_PLUGIN_ID
      ) {
        // Pass through unchanged
        result.push(signal);
        continue;
      }

      // Process the article batch
      const classified = this.classifyBatch(signal, data, interests ?? null, context);
      result.push(...classified);
    }

    return result;
  }

  /**
   * Classify a batch of articles into urgent/interesting signals.
   */
  private classifyBatch(
    originalSignal: Signal,
    data: PluginEventData,
    interests: Interests | null,
    context: FilterContext
  ): Signal[] {
    const payload = data.payload as {
      articles: NewsArticle[];
      sourceId: string;
      fetchedAt: Date;
    };

    const articles = payload.articles;
    const sourceId = payload.sourceId;

    if (articles.length === 0) {
      return [];
    }

    this.logger.debug(
      { articleCount: articles.length, sourceId, hasInterests: !!interests },
      'Classifying article batch'
    );

    // Reset batch volumes for anomaly detection
    this.batchVolumes.clear();

    // Count articles per topic for volume anomaly
    for (const article of articles) {
      for (const topic of article.topics) {
        const normalized = topic.toLowerCase();
        this.batchVolumes.set(normalized, (this.batchVolumes.get(normalized) ?? 0) + 1);
      }
    }

    const urgentArticles: ScoredArticle[] = [];
    const interestingArticles: ScoredArticle[] = [];

    // Score and classify each article
    for (const article of articles) {
      const { interestScore, urgencyScore } = this.scoreArticle(article, sourceId, interests);

      const scored: ScoredArticle = { article, interestScore, urgencyScore };

      if (urgencyScore > this.config.urgentThreshold) {
        urgentArticles.push(scored);
      } else if (interestScore >= this.config.interestThreshold) {
        interestingArticles.push(scored);
      }
      // NOISE: articles below interest threshold are dropped

      // Mark topics as seen
      for (const topic of article.topics) {
        this.seenTopics.add(topic.toLowerCase());
      }
    }

    // Sort by score (highest first)
    urgentArticles.sort((a, b) => b.urgencyScore - a.urgencyScore);
    interestingArticles.sort((a, b) => b.interestScore - a.interestScore);

    this.logger.info(
      {
        total: articles.length,
        urgent: urgentArticles.length,
        interesting: interestingArticles.length,
        filtered: articles.length - urgentArticles.length - interestingArticles.length,
      },
      'Batch classified'
    );

    // Create output signals
    const outputSignals: Signal[] = [];

    if (urgentArticles.length > 0) {
      outputSignals.push(
        createSignal(
          'plugin_event',
          `plugin.${NEWS_PLUGIN_ID}`,
          { value: urgentArticles.length },
          {
            priority: 1, // HIGH priority - wake COGNITION
            correlationId: context.correlationId,
            parentId: originalSignal.id,
            data: {
              kind: 'plugin_event',
              eventKind: 'news:urgent_articles',
              pluginId: NEWS_PLUGIN_ID,
              payload: {
                articles: urgentArticles,
                sourceId,
                fetchedAt: payload.fetchedAt,
              },
            },
          }
        )
      );
    }

    if (interestingArticles.length > 0) {
      outputSignals.push(
        createSignal(
          'plugin_event',
          `plugin.${NEWS_PLUGIN_ID}`,
          { value: interestingArticles.length },
          {
            priority: 3, // LOW priority - queue for later
            correlationId: context.correlationId,
            parentId: originalSignal.id,
            data: {
              kind: 'plugin_event',
              eventKind: 'news:interesting_articles',
              pluginId: NEWS_PLUGIN_ID,
              payload: {
                articles: interestingArticles,
                sourceId,
                fetchedAt: payload.fetchedAt,
              },
            },
          }
        )
      );
    }

    return outputSignals;
  }

  /**
   * Score a single article for interest and urgency.
   */
  private scoreArticle(
    article: NewsArticle,
    sourceId: string,
    interests: Interests | null
  ): { interestScore: number; urgencyScore: number } {
    // === INTEREST SCORE ===
    const { topicMatch, topicWeight, bestTopic } = this.findBestTopicMatch(
      article.topics,
      interests
    );
    const sourceReputation = this.getSourceReputation(sourceId, interests);
    const noveltyBonus = this.calculateNoveltyBonus(article.topics);

    const interestScore = Math.min(
      1,
      topicMatch * topicWeight * 0.5 + sourceReputation * 0.2 + noveltyBonus * 0.3
    );

    // === URGENCY SCORE ===
    const breakingBonus = article.hasBreakingPattern ? this.config.breakingBonus : 0;
    const volumeAnomaly = this.calculateVolumeAnomaly(article.topics, interests);
    const topicUrgencyWeight = this.getTopicUrgencyWeight(bestTopic, interests);

    const urgencyScore = Math.min(
      1,
      breakingBonus * 2.0 + volumeAnomaly * 1.5 + interestScore * topicUrgencyWeight
    );

    this.logger.trace(
      {
        title: article.title.slice(0, 30),
        interestScore: interestScore.toFixed(2),
        urgencyScore: urgencyScore.toFixed(2),
        bestTopic,
        hasBreaking: article.hasBreakingPattern,
      },
      'Article scored'
    );

    return { interestScore, urgencyScore };
  }

  /**
   * Find the best matching topic and its weight.
   */
  private findBestTopicMatch(
    topics: string[],
    interests: Interests | null
  ): { topicMatch: number; topicWeight: number; bestTopic: string | null } {
    if (!interests || Object.keys(interests.weights).length === 0) {
      return { topicMatch: 0, topicWeight: 0, bestTopic: null };
    }

    let bestWeight = 0;
    let bestTopic: string | null = null;

    for (const topic of topics) {
      const normalized = topic.toLowerCase();
      const weight = interests.weights[normalized];

      if (weight !== undefined && weight > bestWeight) {
        bestWeight = weight;
        bestTopic = normalized;
      }
    }

    const topicMatch = bestWeight > 0 ? 1 : 0;
    return { topicMatch, topicWeight: bestWeight, bestTopic };
  }

  /**
   * Get source reputation from interests or use default.
   */
  private getSourceReputation(sourceId: string, interests: Interests | null): number {
    if (!interests?.sourceReputation) {
      return this.config.defaultSourceReputation;
    }
    return interests.sourceReputation[sourceId] ?? this.config.defaultSourceReputation;
  }

  /**
   * Calculate novelty bonus for first-time topics.
   */
  private calculateNoveltyBonus(topics: string[]): number {
    for (const topic of topics) {
      if (!this.seenTopics.has(topic.toLowerCase())) {
        return this.config.noveltyBonus;
      }
    }
    return 0;
  }

  /**
   * Calculate volume anomaly using Weber-Fechner law.
   */
  private calculateVolumeAnomaly(topics: string[], interests: Interests | null): number {
    if (!interests || Object.keys(interests.topicBaselines).length === 0) {
      return 0;
    }

    let maxAnomaly = 0;

    for (const topic of topics) {
      const normalized = topic.toLowerCase();
      const baseline = interests.topicBaselines[normalized];
      const currentVolume = this.batchVolumes.get(normalized) ?? 0;

      if (baseline && baseline.avgVolume > 0) {
        const relativeChange = (currentVolume - baseline.avgVolume) / baseline.avgVolume;

        if (relativeChange > 0) {
          const anomaly = Math.min(1, relativeChange / (1 + relativeChange));
          maxAnomaly = Math.max(maxAnomaly, anomaly);
        }
      }
    }

    return maxAnomaly;
  }

  /**
   * Get per-topic urgency weight.
   */
  private getTopicUrgencyWeight(topic: string | null, interests: Interests | null): number {
    if (!topic || !interests) {
      return 0.5;
    }
    return interests.urgency[topic] ?? 0.5;
  }
}

/**
 * Create a NewsSignalFilter instance.
 */
export function createNewsSignalFilter(logger: Logger): NewsSignalFilter {
  return new NewsSignalFilter(logger);
}
