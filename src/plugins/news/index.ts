/**
 * News Plugin
 *
 * Monitors RSS feeds and Telegram channels, filters by importance,
 * and notifies users about relevant news.
 *
 * Plugin Isolation: Interacts with core ONLY via PluginPrimitives API.
 * No direct imports from core modules.
 */

import type {
  PluginV2,
  PluginManifestV2,
  PluginLifecycleV2,
  PluginPrimitives,
  PluginTool,
  MigrationBundle,
  StoragePrimitive,
} from '../../types/plugin.js';
import type { Logger } from '../../types/logger.js';
import {
  NEWS_PLUGIN_ID,
  NEWS_EVENT_KINDS,
  NEWS_STORAGE_KEYS,
  type NewsSource,
  type SourceState,
  type FetchedArticle,
} from './types.js';
import { createNewsTool } from './tools/news-tool.js';
import { fetchRssFeed } from './fetchers/rss.js';
import { fetchTelegramChannelUntil } from './fetchers/telegram.js';
import { extractBatchTopics, formatTopicList } from './topic-extractor.js';

/**
 * Maximum consecutive failures before alerting user about broken source.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Character limit for batching articles into thoughts.
 */
const THOUGHT_CHAR_LIMIT = 4000;

/**
 * Plugin state (set during activation).
 */
let pluginPrimitives: PluginPrimitives | null = null;
let pluginTools: PluginTool[] = [];
let pollScheduleId: string | null = null;

/**
 * News plugin manifest.
 */
const manifest: PluginManifestV2 = {
  manifestVersion: 2,
  id: NEWS_PLUGIN_ID,
  name: 'News Plugin',
  version: '1.0.0',
  description:
    'Monitor RSS feeds and Telegram channels, filter by importance, and notify about relevant news',
  provides: [{ type: 'tool', id: 'news' }],
  requires: ['scheduler', 'storage', 'signalEmitter', 'logger'],
  limits: {
    maxSchedules: 10, // Max 10 scheduled poll events (one per source type batch)
    maxStorageMB: 50, // 50MB for source configs and state
  },
};

/**
 * Load all news sources from storage.
 */
async function loadSources(storage: StoragePrimitive): Promise<NewsSource[]> {
  const stored = await storage.get<NewsSource[]>(NEWS_STORAGE_KEYS.SOURCES);
  if (!stored) return [];

  // Rehydrate dates
  return stored.map((s) => ({
    ...s,
    createdAt: new Date(s.createdAt),
  }));
}

/**
 * Load source state from storage.
 */
async function loadSourceState(
  storage: StoragePrimitive,
  sourceId: string
): Promise<SourceState | null> {
  const state = await storage.get<SourceState>(
    `${NEWS_STORAGE_KEYS.SOURCE_STATE_PREFIX}${sourceId}`
  );
  if (!state) return null;

  return {
    ...state,
    lastFetchedAt: new Date(state.lastFetchedAt),
  };
}

/**
 * Save source state to storage.
 */
async function saveSourceState(storage: StoragePrimitive, state: SourceState): Promise<void> {
  await storage.set(`${NEWS_STORAGE_KEYS.SOURCE_STATE_PREFIX}${state.sourceId}`, state);
}

/**
 * Filter out articles that have already been seen.
 * Uses lastSeenId or lastSeenHash for deduplication.
 */
function filterNewArticles(
  articles: FetchedArticle[],
  state: SourceState | null
): FetchedArticle[] {
  if (!state || (!state.lastSeenId && !state.lastSeenHash)) {
    // No previous state - all articles are new
    return articles;
  }

  const newArticles: FetchedArticle[] = [];

  for (const article of articles) {
    // Stop at the last seen article
    if (state.lastSeenId && article.id === state.lastSeenId) {
      break;
    }

    newArticles.push(article);
  }

  return newArticles;
}

/**
 * Estimate the character size of an article in the thought format.
 */
function estimateArticleSize(article: FetchedArticle): number {
  let size = article.title.length + article.sourceName.length + 20; // Base: title, source, formatting

  if (article.summary) {
    // Summary is truncated to ~150 chars
    size += Math.min(article.summary.length, 150) + 10;
  }

  if (article.url) {
    size += article.url.length + 10;
  }

  return size;
}

/**
 * Batch articles into thought-sized chunks (~4000 chars each).
 * Accounts for full article format including summaries and URLs.
 */
function batchArticles(articles: FetchedArticle[]): FetchedArticle[][] {
  // Reserve space for thought header/footer (~500 chars)
  const effectiveLimit = THOUGHT_CHAR_LIMIT - 500;

  const batches: FetchedArticle[][] = [];
  let currentBatch: FetchedArticle[] = [];
  let currentSize = 0;

  for (const article of articles) {
    const articleSize = estimateArticleSize(article);

    if (currentSize + articleSize > effectiveLimit && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentSize = 0;
    }

    currentBatch.push(article);
    currentSize += articleSize;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

/**
 * Format a single article for thought output.
 */
function formatArticle(article: FetchedArticle): string {
  let line = `• **${article.sourceName}**: ${article.title}`;

  if (article.summary) {
    // Truncate summary to ~150 chars for thought brevity
    const shortSummary =
      article.summary.length > 150 ? article.summary.slice(0, 147) + '...' : article.summary;
    line += `\n  ${shortSummary}`;
  }

  if (article.url) {
    line += `\n  Link: ${article.url}`;
  }

  return line;
}

/**
 * Format a batch of articles into a thought string.
 * Includes rich context for COGNITION to evaluate importance.
 */
function formatThought(articles: FetchedArticle[]): string {
  // Extract topics for context
  const topics = extractBatchTopics(articles);
  const topicStr = formatTopicList(topics);

  // Format each article with details
  const articleLines = articles.map(formatArticle);

  // Build the thought with COGNITION guidance
  const thought = [
    `I just fetched ${String(articles.length)} new article${articles.length > 1 ? 's' : ''} covering ${topicStr}:`,
    '',
    ...articleLines,
    '',
    '---',
    'How to process these articles:',
    '',
    '1. USE YOUR JUDGMENT to decide which articles are worth saving:',
    '   - Consider what you know about the user (profession, interests, location, past conversations)',
    '   - If you know nothing, use general relevance (important news, useful content, trending topics)',
    '   - Breaking/urgent news → always save',
    '   - Niche content with no user context → skip',
    '',
    '2. SAVE interesting articles to memory (use core.memory with action "save"):',
    '   - type: "fact"',
    '   - content: Brief summary of the article',
    '   - tags: ["news", source name, topic tags]',
    '   - Include the link in content for reference',
    '',
    '3. If you are UNCERTAIN about user preferences:',
    '   - Save an intention to ask later (type: "intention", trigger: "next_conversation")',
    '   - Example: "Ask user which news topics interest them"',
    '   - Do NOT try to respond directly (this is internal processing)',
    '',
    'Remember: You are processing internally. Save to memory, do not send messages.',
  ].join('\n');

  return thought;
}

/**
 * Fetch a single RSS source (used for parallel fetching).
 */
async function fetchSingleSource(
  source: NewsSource,
  storage: StoragePrimitive,
  logger: Logger
): Promise<{ articles: FetchedArticle[]; failed: boolean; sourceName: string }> {
  const state = await loadSourceState(storage, source.id);

  logger.debug(
    { sourceId: source.id, sourceName: source.name, url: source.url },
    'Fetching RSS feed'
  );

  const result = await fetchRssFeed(source.url, source.id, source.name);

  if (!result.success) {
    // Track failure
    const newState: SourceState = {
      sourceId: source.id,
      lastFetchedAt: state?.lastFetchedAt ?? new Date(),
      consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1,
      lastError: result.error,
      lastSeenId: state?.lastSeenId,
      lastSeenHash: state?.lastSeenHash,
    };

    await saveSourceState(storage, newState);

    logger.warn(
      {
        sourceId: source.id,
        sourceName: source.name,
        error: result.error,
        consecutiveFailures: newState.consecutiveFailures,
      },
      'Failed to fetch RSS feed'
    );

    // Return as failed if too many consecutive failures
    return {
      articles: [],
      failed: newState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES,
      sourceName: source.name,
    };
  }

  // Filter to only new articles
  const newArticles = filterNewArticles(result.articles, state);

  logger.debug(
    {
      sourceId: source.id,
      sourceName: source.name,
      total: result.articles.length,
      new: newArticles.length,
    },
    'Fetched RSS feed'
  );

  // Update state with latest article ID
  const newState: SourceState = {
    sourceId: source.id,
    lastFetchedAt: new Date(),
    consecutiveFailures: 0,
    lastSeenId: result.latestId ?? state?.lastSeenId,
    lastSeenHash: state?.lastSeenHash,
  };

  await saveSourceState(storage, newState);

  return { articles: newArticles, failed: false, sourceName: source.name };
}

/**
 * Fetch all enabled RSS sources in parallel and return new articles.
 * Non-blocking: all feeds are fetched concurrently using Promise.allSettled.
 */
async function fetchAllRssSources(
  storage: StoragePrimitive,
  logger: Logger
): Promise<{ newArticles: FetchedArticle[]; failedSources: string[] }> {
  const sources = await loadSources(storage);
  const enabledRssSources = sources.filter((s) => s.enabled && s.type === 'rss');

  logger.info({ count: enabledRssSources.length }, 'Fetching RSS sources in parallel');

  if (enabledRssSources.length === 0) {
    return { newArticles: [], failedSources: [] };
  }

  // Fetch all sources in parallel (non-blocking)
  const results = await Promise.allSettled(
    enabledRssSources.map((source) => fetchSingleSource(source, storage, logger))
  );

  const allNewArticles: FetchedArticle[] = [];
  const failedSources: string[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allNewArticles.push(...result.value.articles);
      if (result.value.failed) {
        failedSources.push(result.value.sourceName);
      }
    } else {
      // Promise rejected - unexpected error
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      logger.error({ error: reason }, 'Unexpected error fetching source');
    }
  }

  return { newArticles: allNewArticles, failedSources };
}

/**
 * Fetch a single Telegram channel (used for parallel fetching).
 */
async function fetchSingleTelegramSource(
  source: NewsSource,
  storage: StoragePrimitive,
  logger: Logger
): Promise<{ articles: FetchedArticle[]; failed: boolean; sourceName: string }> {
  const state = await loadSourceState(storage, source.id);

  logger.debug(
    {
      sourceId: source.id,
      sourceName: source.name,
      handle: source.url,
      lastSeenId: state?.lastSeenId,
    },
    'Fetching Telegram channel'
  );

  // Use pagination to fetch all new messages since lastSeenId
  const result = await fetchTelegramChannelUntil(source.url, source.name, state?.lastSeenId);

  if (!result.success) {
    // Track failure
    const newState: SourceState = {
      sourceId: source.id,
      lastFetchedAt: state?.lastFetchedAt ?? new Date(),
      consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1,
      lastError: result.error,
      lastSeenId: state?.lastSeenId,
      lastSeenHash: state?.lastSeenHash,
    };

    await saveSourceState(storage, newState);

    logger.warn(
      {
        sourceId: source.id,
        sourceName: source.name,
        error: result.error,
        consecutiveFailures: newState.consecutiveFailures,
      },
      'Failed to fetch Telegram channel'
    );

    return {
      articles: [],
      failed: newState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES,
      sourceName: source.name,
    };
  }

  // Filter to only new articles
  const newArticles = filterNewArticles(result.articles, state);

  logger.debug(
    {
      sourceId: source.id,
      sourceName: source.name,
      total: result.articles.length,
      new: newArticles.length,
    },
    'Fetched Telegram channel'
  );

  // Update state with latest message ID
  const newState: SourceState = {
    sourceId: source.id,
    lastFetchedAt: new Date(),
    consecutiveFailures: 0,
    lastSeenId: result.latestId ?? state?.lastSeenId,
    lastSeenHash: state?.lastSeenHash,
  };

  await saveSourceState(storage, newState);

  return { articles: newArticles, failed: false, sourceName: source.name };
}

/**
 * Fetch all enabled Telegram sources in parallel and return new articles.
 * Non-blocking: all channels are fetched concurrently using Promise.allSettled.
 */
async function fetchAllTelegramSources(
  storage: StoragePrimitive,
  logger: Logger
): Promise<{ newArticles: FetchedArticle[]; failedSources: string[] }> {
  const sources = await loadSources(storage);
  const enabledTelegramSources = sources.filter((s) => s.enabled && s.type === 'telegram');

  logger.info({ count: enabledTelegramSources.length }, 'Fetching Telegram sources in parallel');

  if (enabledTelegramSources.length === 0) {
    return { newArticles: [], failedSources: [] };
  }

  // Fetch all sources in parallel (non-blocking)
  const results = await Promise.allSettled(
    enabledTelegramSources.map((source) => fetchSingleTelegramSource(source, storage, logger))
  );

  const allNewArticles: FetchedArticle[] = [];
  const failedSources: string[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allNewArticles.push(...result.value.articles);
      if (result.value.failed) {
        failedSources.push(result.value.sourceName);
      }
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      logger.error({ error: reason }, 'Unexpected error fetching Telegram source');
    }
  }

  return { newArticles: allNewArticles, failedSources };
}

/**
 * Handle the poll_feeds event.
 * Fetches all sources (RSS and Telegram), filters new articles, and emits thoughts.
 */
async function handlePollFeeds(primitives: PluginPrimitives): Promise<void> {
  const { storage, logger, intentEmitter } = primitives;

  // Fetch RSS and Telegram sources in parallel
  const [rssResult, telegramResult] = await Promise.all([
    fetchAllRssSources(storage, logger),
    fetchAllTelegramSources(storage, logger),
  ]);

  // Combine results
  const newArticles = [...rssResult.newArticles, ...telegramResult.newArticles];
  const failedSources = [...rssResult.failedSources, ...telegramResult.failedSources];

  logger.info(
    { newArticleCount: newArticles.length, failedSourceCount: failedSources.length },
    'Feed poll completed'
  );

  // Emit thought for failed sources that need attention
  if (failedSources.length > 0) {
    const failureThought =
      `Some of my news sources have been failing repeatedly:\n` +
      failedSources.map((name) => `- ${name}`).join('\n') +
      `\n\nI should let the user know these sources might need attention.`;

    const result = intentEmitter.emitThought(failureThought);
    if (!result.success) {
      logger.warn({ error: result.error }, 'Failed to emit thought for source failures');
    }
  }

  // If no new articles, nothing more to do
  if (newArticles.length === 0) {
    logger.debug('No new articles found');
    return;
  }

  // Batch articles and emit thoughts
  const batches = batchArticles(newArticles);

  logger.debug(
    { articleCount: newArticles.length, batchCount: batches.length },
    'Emitting thoughts for new articles'
  );

  for (const batch of batches) {
    const thought = formatThought(batch);
    const result = intentEmitter.emitThought(thought);

    if (!result.success) {
      logger.warn(
        { error: result.error, articleCount: batch.length },
        'Failed to emit thought for news batch'
      );
    } else {
      logger.debug(
        { signalId: result.signalId, articleCount: batch.length },
        'Emitted thought for news batch'
      );
    }
  }
}

/**
 * News plugin lifecycle.
 */
const lifecycle: PluginLifecycleV2 = {
  /**
   * Activate the plugin.
   */
  async activate(primitives: PluginPrimitives): Promise<void> {
    pluginPrimitives = primitives;
    primitives.logger.info('News plugin activating');

    // Create tools
    pluginTools = [createNewsTool(primitives)];

    // Schedule periodic polling (every 2 hours)
    const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60 * 1000);
    pollScheduleId = await primitives.scheduler.schedule({
      fireAt: twoHoursFromNow,
      recurrence: {
        frequency: 'custom',
        interval: 2,
        cron: '0 */2 * * *', // Every 2 hours
      },
      data: {
        kind: NEWS_EVENT_KINDS.POLL_FEEDS,
      },
    });

    primitives.logger.info(
      { scheduleId: pollScheduleId },
      'News plugin activated with polling schedule'
    );
  },

  /**
   * Deactivate the plugin.
   */
  async deactivate(): Promise<void> {
    if (pluginPrimitives) {
      pluginPrimitives.logger.info('News plugin deactivating');

      // Cancel polling schedule
      if (pollScheduleId) {
        await pluginPrimitives.scheduler.cancel(pollScheduleId);
        pollScheduleId = null;
      }
    }
    pluginPrimitives = null;
    pluginTools = [];
  },

  /**
   * Health check.
   */
  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    if (!pluginPrimitives) {
      return { healthy: false, message: 'Plugin not activated' };
    }

    try {
      // Check storage is accessible
      await pluginPrimitives.storage.keys();
      return { healthy: true };
    } catch (error) {
      return {
        healthy: false,
        message: `Storage error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },

  /**
   * Migrate from previous version.
   */
  migrate(fromVersion: string, bundle: MigrationBundle): MigrationBundle {
    // For v1.0.0, no migration needed - just pass through
    if (pluginPrimitives) {
      pluginPrimitives.logger.info({ fromVersion }, 'News plugin migrating');
    }
    return bundle;
  },

  /**
   * Handle plugin events (called by scheduler for feed polling).
   */
  async onEvent(eventKind: string, _payload: Record<string, unknown>): Promise<void> {
    if (!pluginPrimitives) return;

    if (eventKind === NEWS_EVENT_KINDS.POLL_FEEDS) {
      await handlePollFeeds(pluginPrimitives);
    }
  },
};

/**
 * Get plugin tools (for manual registration if needed).
 * Must be called after activation.
 */
export function getTools(): PluginTool[] {
  return pluginTools;
}

/**
 * The news plugin instance.
 * Tools are created during activation and accessed via the getter.
 */
const newsPlugin: PluginV2 = {
  manifest,
  lifecycle,
  // Tools getter - returns tools created during activation
  get tools() {
    return pluginTools;
  },
};

export default newsPlugin;
export { NEWS_PLUGIN_ID } from './types.js';
export { NEWS_EVENT_KINDS } from './types.js';
export type { NewsSource, SourceState, FetchedArticle } from './types.js';
