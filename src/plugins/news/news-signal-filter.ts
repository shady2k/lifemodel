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

/**
 * Normalize Unicode string for comparison.
 * Handles Cyrillic combining characters and other edge cases.
 */
function normalizeUnicode(s: string): string {
  return s.normalize('NFC').toLowerCase().trim();
}

/**
 * Check if one string meaningfully contains another.
 * Returns a containment score (0-1) based on how much of the shorter string
 * is covered by the containment. Returns 0 if no meaningful containment.
 *
 * This handles cases where:
 * - Article topic "отключения" is contained in interest "отключения газа, воды..."
 * - Interest keyword "crypto" is contained in article topic "cryptocurrency news"
 */
function containmentScore(articleTopic: string, interestTopic: string): number {
  // Minimum length for meaningful containment (avoid matching 2-char words everywhere)
  const MIN_CONTAINMENT_LENGTH = 4;

  // Normalize both strings for comparison
  const normArticle = normalizeUnicode(articleTopic);
  const normInterest = normalizeUnicode(interestTopic);

  const shorter = normArticle.length <= normInterest.length ? normArticle : normInterest;
  const longer = normArticle.length <= normInterest.length ? normInterest : normArticle;

  if (shorter.length < MIN_CONTAINMENT_LENGTH) return 0;

  // Check word-boundary containment (more accurate than substring)
  // Split by common delimiters and check if shorter matches any word/phrase
  const words = longer.split(/[\s,;.!?]+/);

  // Exact word match
  if (words.some((word) => word === shorter)) {
    return 0.95; // High score for exact word match
  }

  // Substring containment (for compound words, phrases)
  if (longer.includes(shorter)) {
    // Score based on coverage ratio (shorter/longer)
    // "отключения" in "отключения газа" = 10/15 = 0.67 * 0.9 = 0.6
    const coverage = shorter.length / longer.length;
    return Math.min(0.9, coverage + 0.3); // Boost but cap at 0.9
  }

  return 0;
}

/** Minimum similarity threshold for fuzzy topic matching */
const FUZZY_MATCH_THRESHOLD = 0.7;

/**
 * Format a compact date range string for digest titles.
 * Same day: "Feb 20 14:00–16:30"
 * Different days: "Feb 19 23:00–Feb 20 01:30"
 */
function formatDigestDateRange(start: Date, end: Date): string {
  const fmt = (d: Date) => {
    const mon = d.toLocaleString('en-US', { month: 'short' });
    const day = d.getDate();
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return { mon, day, time: `${h}:${m}` };
  };

  const s = fmt(start);
  const e = fmt(end);

  if (s.mon === e.mon && s.day === e.day) {
    return `${s.mon} ${String(s.day)} ${s.time}–${e.time}`;
  }
  return `${s.mon} ${String(s.day)} ${s.time}–${e.mon} ${String(e.day)} ${e.time}`;
}

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
      sourceType?: 'rss' | 'telegram' | 'telegram-group' | undefined;
    };

    let articles = payload.articles;
    const sourceId = payload.sourceId;
    const sourceType = payload.sourceType;

    if (articles.length === 0) {
      return [];
    }

    // Telegram sources: consolidate individual messages into digest chunks
    if (sourceType === 'telegram' || sourceType === 'telegram-group') {
      articles = this.consolidateToDigests(articles, sourceId, payload.fetchedAt);
      if (articles.length === 0) {
        this.logger.debug(
          { sourceId, sourceType },
          'All digest chunks dropped (below min content)'
        );
        return [];
      }
    }

    this.logger.debug(
      { articleCount: articles.length, sourceId, hasInterests: !!interests, sourceType },
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
      // Warn if urgent facts won't be routed (helps debug missing notifications)
      if (!context.primaryRecipientId) {
        this.logger.warn(
          { urgentCount: urgentArticles.length },
          'Urgent facts generated but no primaryRecipientId - responses will not be routed'
        );
      }

      // Transform urgent articles to facts - brain operates on facts, not articles
      const urgentFacts = urgentArticles.map((scored) => this.toFact(scored, sourceId));

      const urgentFactBatchData: FactBatchData = {
        kind: 'fact_batch',
        pluginId: NEWS_PLUGIN_ID,
        eventKind: 'news:urgent',
        facts: urgentFacts,
        urgent: true, // Wake COGNITION immediately
        recipientId: context.primaryRecipientId, // Route response to primary user
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
        recipientId: context.primaryRecipientId, // Route responses to primary user
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
        recipientId: context.primaryRecipientId, // Route responses to primary user
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

  // ============================================================
  // Telegram Digest Consolidation
  // ============================================================

  /** Max time gap between messages in the same digest chunk (15 minutes) */
  private static readonly DIGEST_GAP_MS = 15 * 60 * 1000;
  /** Max messages per digest chunk */
  private static readonly DIGEST_MAX_MESSAGES = 25;
  /** Max total characters per digest chunk */
  private static readonly DIGEST_MAX_CHARS = 4000;
  /** Min content chars for a chunk to survive quality guard */
  private static readonly DIGEST_MIN_CONTENT_CHARS = 120;

  /**
   * Consolidate individual Telegram messages into time-sessionized digest chunks.
   *
   * Telegram messages are conversational and context-dependent — "Доброе!", "+1" —
   * meaningless as individual facts. This method groups them into coherent digest
   * windows, each becoming a single NewsArticle for scoring and memory storage.
   */
  private consolidateToDigests(
    articles: NewsArticle[],
    sourceId: string,
    fetchedAt: Date
  ): NewsArticle[] {
    // 1. Preprocess: keep only messages with non-empty text
    const withContent = articles.filter((a) => {
      const text = [a.title, a.summary].join('\n').trim();
      return text.length > 0;
    });

    if (withContent.length === 0) return [];

    // 2. Sort by publishedAt oldest-first; missing timestamps preserve original order
    const sorted = [...withContent].sort((a, b) => {
      const ta = a.publishedAt?.getTime() ?? 0;
      const tb = b.publishedAt?.getTime() ?? 0;
      if (ta === 0 && tb === 0) return 0; // preserve original order
      if (ta === 0) return -1; // no timestamp → keep at start
      if (tb === 0) return 1;
      return ta - tb;
    });

    // 3. Chunk by time gap, message count, and char limit
    const chunks: NewsArticle[][] = [];
    let currentChunk: NewsArticle[] = [];
    let currentChars = 0;
    let lastTimestamp: number | null = null;

    for (const article of sorted) {
      const text = [article.title, article.summary].join('\n').trim();
      const articleTime = article.publishedAt?.getTime() ?? null;

      // Break conditions
      const timeGap =
        lastTimestamp !== null &&
        articleTime !== null &&
        articleTime - lastTimestamp > NewsSignalFilter.DIGEST_GAP_MS;
      const countLimit = currentChunk.length >= NewsSignalFilter.DIGEST_MAX_MESSAGES;
      const charLimit =
        currentChars + text.length > NewsSignalFilter.DIGEST_MAX_CHARS && currentChunk.length > 0;

      if (timeGap || countLimit || charLimit) {
        if (currentChunk.length > 0) {
          chunks.push(currentChunk);
        }
        currentChunk = [];
        currentChars = 0;
      }

      currentChunk.push(article);
      currentChars += text.length;
      if (articleTime !== null) {
        lastTimestamp = articleTime;
      }
    }

    // Flush remaining
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    // 4. Build digest NewsArticle per chunk, applying quality guard
    const digests: NewsArticle[] = [];
    let droppedCount = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk || chunk.length === 0) continue;

      // Build summary: newline-joined "[Author] text" lines
      const lines: string[] = [];
      let totalContentChars = 0;

      for (const msg of chunk) {
        // Use title as the author-prefixed line (telegram fetcher already formats "[Author] text")
        const line = msg.summary ? `${msg.title}\n${msg.summary}` : msg.title;
        lines.push(line);
        totalContentChars += line.replace(/\s+/g, '').length; // normalize whitespace for char count
      }

      // Quality guard: drop chunks with too little normalized content
      if (totalContentChars < NewsSignalFilter.DIGEST_MIN_CONTENT_CHARS) {
        droppedCount++;
        continue;
      }

      // Date range for title
      const firstMsg = chunk[0];
      const lastMsg = chunk[chunk.length - 1];
      if (!firstMsg || !lastMsg) continue;
      const firstTime = firstMsg.publishedAt ?? fetchedAt;
      const lastTime = lastMsg.publishedAt ?? fetchedAt;
      const dateRange = formatDigestDateRange(firstTime, lastTime);

      // Source name from first article
      const sourceName = firstMsg.source || sourceId;

      // Union of all topics (dedup, lowercase)
      const allTopics = new Set<string>();
      for (const msg of chunk) {
        for (const t of msg.topics) {
          allTopics.add(t.toLowerCase());
        }
      }

      // Breaking pattern: true if ANY message in chunk had it
      const hasBreaking = chunk.some((msg) => msg.hasBreakingPattern);

      // First available URL
      const firstUrl = chunk.find((msg) => msg.url)?.url;

      const digest: NewsArticle = {
        id: `digest:${sourceId}:${String(i)}:${fetchedAt.toISOString()}`,
        title: `${sourceName} (${dateRange}, ${String(chunk.length)} msgs)`,
        source: sourceId,
        topics: Array.from(allTopics),
        url: firstUrl,
        summary: lines.join('\n'),
        publishedAt: lastTime,
        hasBreakingPattern: hasBreaking,
      };

      digests.push(digest);
    }

    this.logger.info(
      {
        sourceId,
        inputMessages: articles.length,
        outputDigests: digests.length,
        droppedChunks: droppedCount,
      },
      'Consolidated Telegram messages into digests'
    );

    return digests;
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
    // "Curious mode" baseline - used when:
    // 1. No user interests defined (cold start)
    // 2. No topic tags on article (LLM handles content understanding)
    // This ensures articles pass threshold and get saved to memory
    // where LLM can search them by content.
    if (!interests || Object.keys(interests.weights).length === 0 || topics.length === 0) {
      // Return baseline that passes 0.4 interest threshold:
      // topicMatch=1, topicWeight=0.6 → 1 * 0.6 * 0.5 = 0.3 base
      // + sourceRep (0.5 * 0.2 = 0.1) + noveltyBonus (0.3 * 0.3 = 0.09)
      // Total: 0.3 + 0.1 + 0.09 = 0.49 > 0.4 threshold ✓
      return { topicMatch: 1, topicWeight: 0.6, bestTopic: null };
    }

    let bestWeight = 0;
    let bestTopic: string | null = null;
    let bestSimilarity = 0;

    const interestTopics = Object.keys(interests.weights);

    for (const articleTopic of topics) {
      const normalizedArticleTopic = normalizeUnicode(articleTopic);

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

        // Try containment match (handles long phrases containing keywords)
        // e.g., article "отключения" matches interest "отключения газа, воды..."
        const containment = containmentScore(normalizedArticleTopic, interestTopic);
        if (containment >= FUZZY_MATCH_THRESHOLD) {
          const effectiveWeight = weight * containment;
          if (effectiveWeight > bestWeight * bestSimilarity) {
            bestWeight = weight;
            bestTopic = interestTopic;
            bestSimilarity = containment;
          }
          continue;
        }

        // Fuzzy match using Levenshtein distance (for typos, variations)
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
      tags: [...new Set(['news', ...article.topics.map((t) => t.toLowerCase())])],
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
