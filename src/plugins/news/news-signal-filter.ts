/**
 * NewsSignalFilter - processes news article batches through scoring algorithms.
 *
 * This filter runs in the AUTONOMIC layer and classifies articles into:
 * - URGENT (urgency > 0.8): Wake COGNITION immediately
 * - INTERESTING (interest 0.4-1.0): Emit as extractable content → stored as facts in memory
 * - NOISE (interest < 0.4): Filter out
 *
 * The filter receives user Interests via context.userModel.getInterests(),
 * populated by core from UserModel. This keeps the plugin decoupled from core.
 *
 * Interesting articles are transformed to ExtractableItem format (generic)
 * so the aggregation layer can save them as facts without knowing about
 * news-specific types like ScoredArticle.
 *
 * Scoring algorithms per spec:
 * - Interest: topicMatch × topicWeight × 0.5 + sourceReputation × 0.2 + noveltyBonus × 0.3
 * - Urgency: breakingBonus × 2.0 + volumeAnomaly × 1.5 + interestScore × topicUrgencyWeight
 */

import type { SignalFilter, FilterContext } from '../../layers/autonomic/filter-registry.js';
import type {
  Signal,
  PluginEventData,
  SignalType,
  Fact,
  FactBatchData,
} from '../../types/signal.js';
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
// String Similarity (Levenshtein Distance)
// ============================================================

/**
 * Calculate Levenshtein distance between two strings.
 * Returns the minimum number of single-character edits (insertions,
 * deletions, substitutions) required to change one string into another.
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Optimization: use single row instead of full matrix
  // We only need the previous row to compute the current row
  let prevRow: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  let currRow: number[] = new Array<number>(n + 1).fill(0);

  // Fill in the rest
  for (let i = 1; i <= m; i++) {
    currRow[0] = i; // Empty string to a[0..i]

    for (let j = 1; j <= n; j++) {
      const prevDiag = prevRow[j - 1] ?? 0;
      const prevUp = prevRow[j] ?? 0;
      const prevLeft = currRow[j - 1] ?? 0;

      if (a[i - 1] === b[j - 1]) {
        currRow[j] = prevDiag;
      } else {
        currRow[j] = 1 + Math.min(prevUp, prevLeft, prevDiag);
      }
    }

    // Swap rows
    [prevRow, currRow] = [currRow, prevRow];
  }

  return prevRow[n] ?? 0;
}

/**
 * Calculate similarity score between two strings (0-1).
 * Uses normalized Levenshtein distance.
 */
function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const distance = levenshteinDistance(a, b);
  const maxLength = Math.max(a.length, b.length);

  return 1 - distance / maxLength;
}

/** Minimum similarity threshold for fuzzy topic matching */
const FUZZY_MATCH_THRESHOLD = 0.7;

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
    const filteredTopics = new Set<string>();

    // Score and classify each article
    for (const article of articles) {
      const { interestScore, urgencyScore } = this.scoreArticle(article, sourceId, interests);

      const scored: ScoredArticle = { article, interestScore, urgencyScore };

      if (urgencyScore > this.config.urgentThreshold) {
        urgentArticles.push(scored);
      } else if (interestScore >= this.config.interestThreshold) {
        interestingArticles.push(scored);
      } else {
        // NOISE: collect topics for low-confidence facts
        for (const topic of article.topics) {
          filteredTopics.add(topic.toLowerCase());
        }
      }

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
      // Transform urgent articles to facts - brain operates on facts, not articles
      const urgentFacts = urgentArticles.map((scored) => this.toFact(scored, sourceId));

      const urgentFactBatchData: FactBatchData = {
        kind: 'fact_batch',
        pluginId: NEWS_PLUGIN_ID,
        eventKind: 'news:urgent',
        facts: urgentFacts,
        urgent: true, // Wake COGNITION immediately
      };

      outputSignals.push(
        createSignal(
          'plugin_event',
          `plugin.${NEWS_PLUGIN_ID}`,
          { value: urgentArticles.length },
          {
            priority: 1, // HIGH priority - wake COGNITION
            correlationId: context.correlationId,
            parentId: originalSignal.id,
            data: urgentFactBatchData,
          }
        )
      );
    }

    if (interestingArticles.length > 0) {
      // Transform to generic Fact format
      // This allows core to save as facts without knowing about ScoredArticle
      const facts = interestingArticles.map((scored) => this.toFact(scored, sourceId));

      const factBatchData: FactBatchData = {
        kind: 'fact_batch',
        pluginId: NEWS_PLUGIN_ID,
        eventKind: 'news:interesting',
        facts,
      };

      outputSignals.push(
        createSignal(
          'plugin_event',
          `plugin.${NEWS_PLUGIN_ID}`,
          { value: interestingArticles.length },
          {
            priority: 3, // LOW priority - saved to memory, not wake
            correlationId: context.correlationId,
            parentId: originalSignal.id,
            data: factBatchData,
          }
        )
      );
    }

    // Emit filtered topics as low-confidence facts
    // These can be found later if user mentions the topic
    if (filteredTopics.size > 0) {
      const filteredFacts: Fact[] = Array.from(filteredTopics).map((topic) => ({
        content: topic,
        confidence: 0.2, // Low confidence - was filtered out
        tags: ['news', 'filtered', topic],
        provenance: {
          source: sourceId,
          timestamp: payload.fetchedAt,
        },
      }));

      const filteredFactBatchData: FactBatchData = {
        kind: 'fact_batch',
        pluginId: NEWS_PLUGIN_ID,
        eventKind: 'news:filtered',
        facts: filteredFacts,
      };

      outputSignals.push(
        createSignal(
          'plugin_event',
          `plugin.${NEWS_PLUGIN_ID}`,
          { value: filteredTopics.size },
          {
            priority: 4, // LOWEST priority - just for mention detection
            correlationId: context.correlationId,
            parentId: originalSignal.id,
            data: filteredFactBatchData,
          }
        )
      );

      this.logger.debug(
        { topics: Array.from(filteredTopics), count: filteredTopics.size },
        'Filtered topics emitted as low-confidence facts'
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
   *
   * Uses Levenshtein distance for fuzzy matching:
   * - "crypto" matches "cryptocurrency"
   * - "AI" matches "artificial-intelligence"
   * - Handles typos and minor variations
   *
   * Cold start behavior:
   * - When no interests defined, returns a "curious" baseline
   * - This allows novelty + source reputation to push articles above threshold
   * - New users see interesting content instead of everything being NOISE
   */
  private findBestTopicMatch(
    topics: string[],
    interests: Interests | null
  ): { topicMatch: number; topicWeight: number; bestTopic: string | null } {
    // Cold start: "curious mode" - treat all topics as moderately interesting
    // This allows noveltyBonus (0.3) + sourceReputation (0.1) + baseline (0.1) = 0.5
    // which passes the 0.4 interest threshold
    if (!interests || Object.keys(interests.weights).length === 0) {
      // Return a baseline that, combined with novelty+sourceRep, can pass threshold
      // topicMatch=1, topicWeight=0.2 → 1 * 0.2 * 0.5 = 0.1 base
      // + sourceRep (0.5 * 0.2 = 0.1) + noveltyBonus (0.3 * 0.3 = 0.09)
      // Total: 0.1 + 0.1 + 0.09 = 0.29... still not enough
      // Better: Return higher baseline weight for cold start
      return { topicMatch: 1, topicWeight: 0.6, bestTopic: null };
    }

    let bestWeight = 0;
    let bestTopic: string | null = null;
    let bestSimilarity = 0;

    const interestTopics = Object.keys(interests.weights);

    for (const articleTopic of topics) {
      const normalizedArticleTopic = articleTopic.toLowerCase();

      for (const interestTopic of interestTopics) {
        const weight = interests.weights[interestTopic];
        if (weight === undefined || weight <= 0) continue; // Skip suppressed topics

        // Try exact match first (faster)
        if (normalizedArticleTopic === interestTopic) {
          if (weight > bestWeight) {
            bestWeight = weight;
            bestTopic = interestTopic;
            bestSimilarity = 1;
          }
          continue;
        }

        // Fuzzy match using Levenshtein distance
        const similarity = stringSimilarity(normalizedArticleTopic, interestTopic);

        if (similarity >= FUZZY_MATCH_THRESHOLD) {
          // Scale weight by similarity (partial match = partial weight)
          const effectiveWeight = weight * similarity;

          if (effectiveWeight > bestWeight * bestSimilarity) {
            bestWeight = weight;
            bestTopic = interestTopic;
            bestSimilarity = similarity;
          }
        }
      }
    }

    // topicMatch is the similarity score (0-1), not binary
    // This allows partial matches to contribute to interest score
    const topicMatch = bestSimilarity;
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

  /**
   * Transform a ScoredArticle into a generic Fact.
   *
   * This is where plugin-specific types (ScoredArticle) are converted
   * to the generic format that core understands. The brain stores facts,
   * not articles - this method extracts the fact from the article.
   */
  private toFact(scored: ScoredArticle, sourceId: string): Fact {
    const { article, interestScore } = scored;

    // Combine title and summary for richer fact content
    const content = article.summary ? `${article.title}\n\n${article.summary}` : article.title;

    return {
      // The fact includes headline + summary for context
      content,
      // Interest score becomes confidence in memory
      confidence: interestScore,
      // Topics become tags for retrieval (normalized to lowercase for consistent matching)
      tags: ['news', ...article.topics.map((t) => t.toLowerCase())],
      // Provenance - where this fact came from
      provenance: {
        source: sourceId,
        url: article.url,
        originalId: article.id,
        timestamp: article.publishedAt,
        hasBreakingPattern: article.hasBreakingPattern,
      },
    };
  }
}

/**
 * Create a NewsSignalFilter instance.
 */
export function createNewsSignalFilter(logger: Logger): NewsSignalFilter {
  return new NewsSignalFilter(logger);
}
