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
import type { NewsArticle } from '../../types/news.js';
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
import { extractArticleTopics, hasBreakingPattern } from './topic-extractor.js';

/**
 * Maximum consecutive failures before alerting user about broken source.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Plugin state (set during activation).
 */
let pluginPrimitives: PluginPrimitives | null = null;
let pluginTools: PluginTool[] = [];
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
  // Declarative schedules - managed by core
  schedules: [
    {
      id: 'poll_feeds',
      cron: '0 */2 * * *', // Every 2 hours
      eventKind: NEWS_EVENT_KINDS.POLL_FEEDS,
      initialDelayMs: 2 * 60 * 60 * 1000, // First poll after 2 hours (don't flood on startup)
    },
  ],
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
 * Convert a FetchedArticle to a NewsArticle for signal emission.
 * Enriches with topic extraction and breaking pattern detection.
 */
function convertToNewsArticle(article: FetchedArticle): NewsArticle {
  const combinedText = article.summary ? `${article.title} ${article.summary}` : article.title;

  return {
    id: article.id,
    title: article.title,
    source: article.sourceId, // e.g., 'rss:techcrunch'
    topics: extractArticleTopics(article.title, article.summary),
    url: article.url,
    summary: article.summary,
    publishedAt: article.publishedAt,
    hasBreakingPattern: hasBreakingPattern(combinedText),
  };
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
  const fetchedArticles = [...rssResult.newArticles, ...telegramResult.newArticles];
  const failedSources = [...rssResult.failedSources, ...telegramResult.failedSources];

  logger.info(
    { newArticleCount: fetchedArticles.length, failedSourceCount: failedSources.length },
    'Feed poll completed'
  );

  // Log failed sources (source health monitoring - Phase 0.3)
  if (failedSources.length > 0) {
    logger.warn({ failedSources }, 'Sources with consecutive failures');
  }

  // If no new articles, nothing more to do
  if (fetchedArticles.length === 0) {
    logger.debug('No new articles found');
    return;
  }

  // Convert to NewsArticle format with topic extraction and breaking detection
  const newsArticles = fetchedArticles.map(convertToNewsArticle);

  // Group articles by source for the signal payload
  const articlesBySource = new Map<string, NewsArticle[]>();
  for (const article of newsArticles) {
    const existing = articlesBySource.get(article.source) ?? [];
    existing.push(article);
    articlesBySource.set(article.source, existing);
  }

  // Emit plugin_event signal for each source batch
  // (NewsSignalFilter in autonomic layer will process these)
  for (const [sourceId, articles] of articlesBySource) {
    const result = intentEmitter.emitSignal({
      priority: 2, // Normal priority - autonomic layer will assess urgency
      data: {
        kind: NEWS_EVENT_KINDS.ARTICLE_BATCH,
        pluginId: NEWS_PLUGIN_ID,
        articles,
        sourceId,
        fetchedAt: new Date(),
      },
    });

    if (!result.success) {
      logger.warn(
        { error: result.error, sourceId, articleCount: articles.length },
        'Failed to emit article batch signal'
      );
    } else {
      logger.debug(
        { signalId: result.signalId, sourceId, articleCount: articles.length },
        'Emitted article batch signal'
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
  activate(primitives: PluginPrimitives): void {
    pluginPrimitives = primitives;
    primitives.logger.info('News plugin activating');

    // Create tools
    pluginTools = [createNewsTool(primitives)];

    // Polling schedule is declared in manifest - core manages it
    primitives.logger.info('News plugin activated');
  },

  /**
   * Deactivate the plugin.
   */
  deactivate(): void {
    if (pluginPrimitives) {
      pluginPrimitives.logger.info('News plugin deactivating');
      // Manifest schedules are cancelled by core on unload
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
