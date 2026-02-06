/**
 * News Plugin
 *
 * Monitors RSS feeds and Telegram channels, filters by importance,
 * and notifies users about relevant news.
 *
 * Plugin Isolation: Interacts with core ONLY via PluginPrimitives API.
 * No direct imports from core modules.
 */

import { z } from 'zod';
import type {
  PluginManifestV2,
  PluginLifecycleV2,
  PluginPrimitives,
  PluginTool,
  MigrationBundle,
  StoragePrimitive,
  FilterPluginV2,
  EventSchema,
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
import { convertToNewsArticle } from './topic-extractor.js';
import { createNewsSignalFilter } from './news-signal-filter.js';

/**
 * Get the maximum publishedAt timestamp from articles.
 * Articles may not be sorted by date (e.g., popularity-sorted feeds),
 * so we must iterate to find the true maximum.
 *
 * @param articles - Array of fetched articles
 * @returns The maximum publishedAt Date, or null if no articles have timestamps
 */
function getMaxPublishedAt(articles: FetchedArticle[]): Date | null {
  let max: Date | null = null;
  for (const article of articles) {
    if (article.publishedAt && (!max || article.publishedAt > max)) {
      max = article.publishedAt;
    }
  }
  return max;
}

/**
 * Zod schema for news:article_batch event validation.
 * Validates the signal emitted when articles are fetched.
 */
const articleBatchSchema = z.object({
  kind: z.literal('plugin_event'),
  eventKind: z.literal(NEWS_EVENT_KINDS.ARTICLE_BATCH),
  pluginId: z.literal(NEWS_PLUGIN_ID),
  fireId: z.string().optional(),
  payload: z.object({
    articles: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        source: z.string(),
        topics: z.array(z.string()),
        url: z.string().optional(),
        summary: z.string().optional(),
        publishedAt: z.date().optional(),
        hasBreakingPattern: z.boolean(),
      })
    ),
    sourceId: z.string(),
    fetchedAt: z.date(),
  }),
});

/**
 * Source health policy thresholds.
 */
const SOURCE_HEALTH_POLICY = {
  /** Disable for 1 hour after this many failures */
  DISABLE_1H_THRESHOLD: 3,
  /** Disable for 6 hours after this many failures */
  DISABLE_6H_THRESHOLD: 5,
  /** Emit thought to inform user after this many failures */
  ALERT_USER_THRESHOLD: 10,
  /** 1 hour in milliseconds */
  ONE_HOUR_MS: 60 * 60 * 1000,
  /** 6 hours in milliseconds */
  SIX_HOURS_MS: 6 * 60 * 60 * 1000,
} as const;

/**
 * Calculate disable duration based on consecutive failures.
 * Returns null if no disable needed, otherwise returns disabledUntil date.
 */
function calculateDisableUntil(consecutiveFailures: number): Date | null {
  if (consecutiveFailures >= SOURCE_HEALTH_POLICY.DISABLE_6H_THRESHOLD) {
    return new Date(Date.now() + SOURCE_HEALTH_POLICY.SIX_HOURS_MS);
  }
  if (consecutiveFailures >= SOURCE_HEALTH_POLICY.DISABLE_1H_THRESHOLD) {
    return new Date(Date.now() + SOURCE_HEALTH_POLICY.ONE_HOUR_MS);
  }
  return null;
}

/**
 * Check if a source is currently disabled.
 */
function isSourceDisabled(state: SourceState | null): boolean {
  if (!state?.disabledUntil) return false;
  return new Date(state.disabledUntil) > new Date();
}

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
  provides: [
    { type: 'tool', id: 'news' },
    { type: 'filter', id: 'news-signal-filter' },
  ],
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
      emitSignal: false, // Don't wake cognition - plugin emits article_batch signals via onEvent()
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
 * Uses timestamp-based filtering (primary) and ID matching (fallback).
 *
 * Important: RSS feeds may be sorted by popularity, not date.
 * We can't assume "stop at lastSeenId" works for all feeds.
 * Instead, filter by publishedAt > lastFetchedAt for reliable deduplication.
 */
function filterNewArticles(
  articles: FetchedArticle[],
  state: SourceState | null
): FetchedArticle[] {
  if (!state) {
    // No previous state - all articles are new
    return articles;
  }

  const seenIds = new Set<string>();
  if (state.lastSeenId) {
    seenIds.add(state.lastSeenId);
  }

  const newArticles: FetchedArticle[] = [];
  const lastFetchedAt = state.lastFetchedAt;

  for (const article of articles) {
    // Skip exact ID matches (handles duplicates in popularity-sorted feeds)
    if (seenIds.has(article.id)) {
      continue;
    }

    // Primary filter: timestamp-based (articles published after last fetch)
    if (article.publishedAt && article.publishedAt <= lastFetchedAt) {
      // Article is older than last fetch - skip it
      continue;
    }

    newArticles.push(article);
  }

  return newArticles;
}

// convertToNewsArticle is imported from topic-extractor.ts

/**
 * Result from fetching a single source.
 */
interface FetchSourceResult {
  articles: FetchedArticle[];
  failed: boolean;
  sourceName: string;
  skipped: boolean;
  shouldAlertUser: boolean;
}

/**
 * Fetch a single RSS source (used for parallel fetching).
 */
async function fetchSingleSource(
  source: NewsSource,
  storage: StoragePrimitive,
  logger: Logger
): Promise<FetchSourceResult> {
  const state = await loadSourceState(storage, source.id);

  // Check if source is temporarily disabled
  if (isSourceDisabled(state)) {
    logger.debug(
      {
        sourceId: source.id,
        sourceName: source.name,
        disabledUntil: state?.disabledUntil,
      },
      'Skipping disabled source'
    );
    return {
      articles: [],
      failed: false,
      sourceName: source.name,
      skipped: true,
      shouldAlertUser: false,
    };
  }

  logger.debug(
    { sourceId: source.id, sourceName: source.name, url: source.url },
    'Fetching RSS feed'
  );

  const result = await fetchRssFeed(source.url, source.id, source.name);

  if (!result.success) {
    // Track failure and apply disable policy
    const newFailures = (state?.consecutiveFailures ?? 0) + 1;
    const disableUntil = calculateDisableUntil(newFailures);

    const newState: SourceState = {
      sourceId: source.id,
      lastFetchedAt: state?.lastFetchedAt ?? new Date(),
      consecutiveFailures: newFailures,
      lastError: result.error,
      lastSeenId: state?.lastSeenId,
      lastSeenHash: state?.lastSeenHash,
      disabledUntil: disableUntil ?? undefined,
    };

    await saveSourceState(storage, newState);

    logger.warn(
      {
        sourceId: source.id,
        sourceName: source.name,
        error: result.error,
        consecutiveFailures: newFailures,
        disabledUntil: disableUntil,
      },
      'Failed to fetch RSS feed'
    );

    // Alert user when hitting threshold
    const shouldAlert = newFailures === SOURCE_HEALTH_POLICY.ALERT_USER_THRESHOLD;

    return {
      articles: [],
      failed: newFailures >= SOURCE_HEALTH_POLICY.DISABLE_1H_THRESHOLD,
      sourceName: source.name,
      skipped: false,
      shouldAlertUser: shouldAlert,
    };
  }

  // Filter to only new articles
  const newArticles = filterNewArticles(result.articles, state);

  // Use MAX timestamp from fetched articles (not current time).
  // Articles may be sorted by popularity, not date, so we find the true max.
  // This prevents missing articles published between newest article time and fetch time.
  const maxPublishedAt = getMaxPublishedAt(result.articles);

  // Log warning if no timestamps found (helps identify problematic feeds)
  if (!maxPublishedAt && result.articles.length > 0) {
    logger.debug(
      { sourceId: source.id, articleCount: result.articles.length },
      'No publishedAt timestamps in fetched RSS articles, using fallback'
    );
  }

  logger.debug(
    {
      sourceId: source.id,
      sourceName: source.name,
      total: result.articles.length,
      new: newArticles.length,
    },
    'Fetched RSS feed'
  );

  // Update state - success resets failures and clears disable
  // Use max article timestamp, falling back to previous state or current time
  const newState: SourceState = {
    sourceId: source.id,
    lastFetchedAt: maxPublishedAt ?? state?.lastFetchedAt ?? new Date(),
    consecutiveFailures: 0,
    lastSeenId: result.latestId ?? state?.lastSeenId,
    lastSeenHash: state?.lastSeenHash,
    disabledUntil: undefined,
  };

  await saveSourceState(storage, newState);

  return {
    articles: newArticles,
    failed: false,
    sourceName: source.name,
    skipped: false,
    shouldAlertUser: false,
  };
}

/**
 * Result from fetching all sources of a type.
 */
interface FetchAllResult {
  newArticles: FetchedArticle[];
  failedSources: string[];
  sourcesToAlert: string[];
}

/**
 * Fetch all enabled RSS sources in parallel and return new articles.
 * Non-blocking: all feeds are fetched concurrently using Promise.allSettled.
 */
async function fetchAllRssSources(
  storage: StoragePrimitive,
  logger: Logger
): Promise<FetchAllResult> {
  const sources = await loadSources(storage);
  const enabledRssSources = sources.filter((s) => s.enabled && s.type === 'rss');

  logger.info({ count: enabledRssSources.length }, 'Fetching RSS sources in parallel');

  if (enabledRssSources.length === 0) {
    return { newArticles: [], failedSources: [], sourcesToAlert: [] };
  }

  // Fetch all sources in parallel (non-blocking)
  const results = await Promise.allSettled(
    enabledRssSources.map((source) => fetchSingleSource(source, storage, logger))
  );

  const allNewArticles: FetchedArticle[] = [];
  const failedSources: string[] = [];
  const sourcesToAlert: string[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allNewArticles.push(...result.value.articles);
      if (result.value.failed) {
        failedSources.push(result.value.sourceName);
      }
      if (result.value.shouldAlertUser) {
        sourcesToAlert.push(result.value.sourceName);
      }
    } else {
      // Promise rejected - unexpected error
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      logger.error({ error: reason }, 'Unexpected error fetching source');
    }
  }

  return { newArticles: allNewArticles, failedSources, sourcesToAlert };
}

/**
 * Fetch a single Telegram channel (used for parallel fetching).
 */
async function fetchSingleTelegramSource(
  source: NewsSource,
  storage: StoragePrimitive,
  logger: Logger
): Promise<FetchSourceResult> {
  const state = await loadSourceState(storage, source.id);

  // Check if source is temporarily disabled
  if (isSourceDisabled(state)) {
    logger.debug(
      {
        sourceId: source.id,
        sourceName: source.name,
        disabledUntil: state?.disabledUntil,
      },
      'Skipping disabled Telegram source'
    );
    return {
      articles: [],
      failed: false,
      sourceName: source.name,
      skipped: true,
      shouldAlertUser: false,
    };
  }

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
    // Track failure and apply disable policy
    const newFailures = (state?.consecutiveFailures ?? 0) + 1;
    const disableUntil = calculateDisableUntil(newFailures);

    const newState: SourceState = {
      sourceId: source.id,
      lastFetchedAt: state?.lastFetchedAt ?? new Date(),
      consecutiveFailures: newFailures,
      lastError: result.error,
      lastSeenId: state?.lastSeenId,
      lastSeenHash: state?.lastSeenHash,
      disabledUntil: disableUntil ?? undefined,
    };

    await saveSourceState(storage, newState);

    logger.warn(
      {
        sourceId: source.id,
        sourceName: source.name,
        error: result.error,
        consecutiveFailures: newFailures,
        disabledUntil: disableUntil,
      },
      'Failed to fetch Telegram channel'
    );

    // Alert user when hitting threshold
    const shouldAlert = newFailures === SOURCE_HEALTH_POLICY.ALERT_USER_THRESHOLD;

    return {
      articles: [],
      failed: newFailures >= SOURCE_HEALTH_POLICY.DISABLE_1H_THRESHOLD,
      sourceName: source.name,
      skipped: false,
      shouldAlertUser: shouldAlert,
    };
  }

  // Filter to only new articles
  const newArticles = filterNewArticles(result.articles, state);

  // Use MAX timestamp from fetched articles (same fix as RSS).
  // This ensures consistent timestamp-based filtering across source types.
  const maxPublishedAt = getMaxPublishedAt(result.articles);

  // Log warning if no timestamps found
  if (!maxPublishedAt && result.articles.length > 0) {
    logger.debug(
      { sourceId: source.id, articleCount: result.articles.length },
      'No publishedAt timestamps in fetched Telegram messages, using fallback'
    );
  }

  logger.debug(
    {
      sourceId: source.id,
      sourceName: source.name,
      total: result.articles.length,
      new: newArticles.length,
    },
    'Fetched Telegram channel'
  );

  // Update state - success resets failures and clears disable
  // Use max article timestamp, falling back to previous state or current time
  const newState: SourceState = {
    sourceId: source.id,
    lastFetchedAt: maxPublishedAt ?? state?.lastFetchedAt ?? new Date(),
    consecutiveFailures: 0,
    lastSeenId: result.latestId ?? state?.lastSeenId,
    lastSeenHash: state?.lastSeenHash,
    disabledUntil: undefined,
  };

  await saveSourceState(storage, newState);

  return {
    articles: newArticles,
    failed: false,
    sourceName: source.name,
    skipped: false,
    shouldAlertUser: false,
  };
}

/**
 * Fetch all enabled Telegram sources in parallel and return new articles.
 * Non-blocking: all channels are fetched concurrently using Promise.allSettled.
 */
async function fetchAllTelegramSources(
  storage: StoragePrimitive,
  logger: Logger
): Promise<FetchAllResult> {
  const sources = await loadSources(storage);
  const enabledTelegramSources = sources.filter((s) => s.enabled && s.type === 'telegram');

  logger.info({ count: enabledTelegramSources.length }, 'Fetching Telegram sources in parallel');

  if (enabledTelegramSources.length === 0) {
    return { newArticles: [], failedSources: [], sourcesToAlert: [] };
  }

  // Fetch all sources in parallel (non-blocking)
  const results = await Promise.allSettled(
    enabledTelegramSources.map((source) => fetchSingleTelegramSource(source, storage, logger))
  );

  const allNewArticles: FetchedArticle[] = [];
  const failedSources: string[] = [];
  const sourcesToAlert: string[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allNewArticles.push(...result.value.articles);
      if (result.value.failed) {
        failedSources.push(result.value.sourceName);
      }
      if (result.value.shouldAlertUser) {
        sourcesToAlert.push(result.value.sourceName);
      }
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      logger.error({ error: reason }, 'Unexpected error fetching Telegram source');
    }
  }

  return { newArticles: allNewArticles, failedSources, sourcesToAlert };
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
  const sourcesToAlert = [...rssResult.sourcesToAlert, ...telegramResult.sourcesToAlert];

  logger.info(
    {
      newArticleCount: fetchedArticles.length,
      failedSourceCount: failedSources.length,
      alertCount: sourcesToAlert.length,
    },
    'Feed poll completed'
  );

  // Log failed sources
  if (failedSources.length > 0) {
    logger.warn({ failedSources }, 'Sources with consecutive failures');
  }

  // Emit thought to inform user about persistently broken sources
  if (sourcesToAlert.length > 0) {
    const sourceList = sourcesToAlert.join(', ');
    intentEmitter.emitPendingIntention(
      `News source health alert: ${sourceList} has failed ${String(SOURCE_HEALTH_POLICY.ALERT_USER_THRESHOLD)} times in a row. ` +
        `The source is temporarily disabled. Consider checking if the source URL is still valid or removing it.`
    );
    logger.warn({ sourcesToAlert }, 'Emitted thought about broken sources');
  }

  // If no new articles, nothing more to do
  if (fetchedArticles.length === 0) {
    logger.debug('No new articles found');
    return;
  }

  // Convert to NewsArticle format with topic extraction and breaking detection
  const newsArticles = fetchedArticles.map(convertToNewsArticle);

  // Nudge about noteworthy articles (breaking patterns or large batches)
  const breakingArticles = newsArticles.filter((a) => a.hasBreakingPattern);
  if (breakingArticles.length > 0) {
    const headlines = breakingArticles
      .slice(0, 3)
      .map((a) => `- ${a.title}`)
      .join('\n');
    intentEmitter.emitPendingIntention(
      `Breaking news detected:\n${headlines}\nShare with the user if it matches their interests.`
    );
  } else if (newsArticles.length >= 5) {
    const headlines = newsArticles
      .slice(0, 3)
      .map((a) => `- ${a.title}`)
      .join('\n');
    intentEmitter.emitPendingIntention(
      `${String(newsArticles.length)} new articles from feeds. Top headlines:\n${headlines}\nMention any that match the user's interests.`
    );
  }

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

    // Register event schemas for validation
    primitives.services.registerEventSchema(
      NEWS_EVENT_KINDS.ARTICLE_BATCH,
      articleBatchSchema as unknown as EventSchema
    );
    primitives.logger.debug('Registered event schema for article_batch');

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
 * Filter is created by core via the filter factory.
 */
const newsPlugin: FilterPluginV2 = {
  manifest,
  lifecycle,
  // Tools getter - returns tools created during activation
  get tools() {
    return pluginTools;
  },
  // Filter factory - core creates and registers the filter
  filter: {
    create: (logger) => createNewsSignalFilter(logger),
    handles: ['plugin_event'],
    priority: 100,
  },
};

export default newsPlugin;
export { NEWS_PLUGIN_ID } from './types.js';
export { NEWS_EVENT_KINDS } from './types.js';
export type { NewsSource, SourceState, FetchedArticle } from './types.js';
