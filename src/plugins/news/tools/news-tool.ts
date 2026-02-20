/**
 * News Plugin Tool
 *
 * Unified tool for managing news sources with action pattern.
 * Actions: add_source, remove_source, list_sources
 *
 * Fetch-on-add: When a source is added, it's immediately fetched and
 * articles are emitted as article_batch signal for NewsSignalFilter to score.
 */

import type {
  PluginPrimitives,
  PluginTool,
  PluginToolContext,
  StoragePrimitive,
  IntentEmitterPrimitive,
  MemorySearchPrimitive,
  ScriptRunnerPrimitive,
} from '../../../types/plugin.js';
import type { Logger } from '../../../types/logger.js';
import type {
  NewsSource,
  SourceState,
  NewsToolResult,
  NewsSummary,
  NewsArticleEntry,
  FetchedArticle,
} from '../types.js';
import { NEWS_STORAGE_KEYS, NEWS_PLUGIN_ID, NEWS_EVENT_KINDS } from '../types.js';
import { validateUrl, validateTelegramHandle } from '../url-validator.js';
import { fetchRssFeed } from '../fetchers/rss.js';
import { fetchTelegramChannel } from '../fetchers/telegram.js';
import { convertToNewsArticle } from '../topic-extractor.js';
import { fetchTelegramGroup } from '../fetchers/telegram-group.js';

/** Minimum interval between refresh_source calls for the same source (5 minutes). */
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Schema definitions for error responses.
 * Helps LLM self-correct when sending invalid parameters.
 */
const SCHEMA_ADD_SOURCE = {
  action: { type: 'string', required: true, enum: ['add_source'] },
  type: {
    type: 'string',
    required: true,
    enum: ['rss', 'telegram', 'telegram-group'],
    description: 'Source type: RSS feed, Telegram channel, or private Telegram group',
  },
  url: {
    type: 'string',
    required: true,
    description: 'RSS feed URL or Telegram @channel_handle (not used for telegram-group)',
  },
  name: {
    type: 'string',
    required: true,
    description: 'Human-readable name for this source',
  },
  profile: {
    type: 'string',
    required: false,
    description: 'Browser profile name (required for telegram-group, created via browser:auth)',
  },
  group_url: {
    type: 'string',
    required: false,
    description: 'Full Telegram Web URL for the group (required for telegram-group)',
  },
};

const SCHEMA_REMOVE_SOURCE = {
  action: { type: 'string', required: true, enum: ['remove_source'] },
  sourceId: {
    type: 'string',
    required: true,
    description: 'Source ID returned by add_source or list_sources',
  },
};

const SCHEMA_LIST_SOURCES = {
  action: { type: 'string', required: true, enum: ['list_sources'] },
};

const SCHEMA_GET_NEWS = {
  action: { type: 'string', required: true, enum: ['get_news'] },
  query: {
    type: 'string',
    required: false,
    description: 'Search term (default: all news)',
  },
  urgency: {
    type: 'string',
    required: false,
    enum: ['urgent', 'interesting', 'all'],
    description: 'Filter by urgency: "urgent", "interesting", or "all" (default: all)',
  },
  limit: {
    type: 'number',
    required: false,
    description: 'Max results (default: 10, max: 50)',
  },
  offset: {
    type: 'number',
    required: false,
    description: 'Skip first N results for pagination',
  },
};

const SCHEMA_LIST_GROUPS = {
  action: { type: 'string', required: true, enum: ['list_groups'] },
  profile: {
    type: 'string',
    required: true,
    description: 'Browser profile name for telegram-group sources (e.g. "telegram")',
  },
};

const SCHEMA_STOP_AUTH = {
  action: { type: 'string', required: true, enum: ['stop_auth'] },
  profile: {
    type: 'string',
    required: true,
    description: 'Profile name to stop authentication for (e.g. "telegram")',
  },
};

const SCHEMA_REFRESH_SOURCE = {
  action: { type: 'string', required: true, enum: ['refresh_source'] },
  source_id: {
    type: 'string',
    required: true,
    description: 'Source ID to refresh (from list_sources)',
  },
};

/**
 * Generate a unique source ID.
 */
function generateSourceId(): string {
  return `src_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Load all news sources from storage.
 */
async function loadSources(storage: StoragePrimitive): Promise<Map<string, NewsSource>> {
  const stored = await storage.get<NewsSource[]>(NEWS_STORAGE_KEYS.SOURCES);
  const map = new Map<string, NewsSource>();

  if (stored) {
    for (const source of stored) {
      // Rehydrate Date objects
      source.createdAt = new Date(source.createdAt);
      map.set(source.id, source);
    }
  }

  return map;
}

/**
 * Save all news sources to storage.
 */
async function saveSources(
  storage: StoragePrimitive,
  sources: Map<string, NewsSource>
): Promise<void> {
  await storage.set(NEWS_STORAGE_KEYS.SOURCES, Array.from(sources.values()));
}

/**
 * Load source state by ID.
 */
async function loadSourceState(
  storage: StoragePrimitive,
  sourceId: string
): Promise<SourceState | null> {
  const state = await storage.get<SourceState>(
    `${NEWS_STORAGE_KEYS.SOURCE_STATE_PREFIX}${sourceId}`
  );

  if (state) {
    state.lastFetchedAt = new Date(state.lastFetchedAt);
  }

  return state;
}

/**
 * Save source state to storage.
 */
async function saveSourceState(storage: StoragePrimitive, state: SourceState): Promise<void> {
  await storage.set(`${NEWS_STORAGE_KEYS.SOURCE_STATE_PREFIX}${state.sourceId}`, state);
}

/**
 * Add a new news source and immediately fetch initial articles.
 */
async function addSource(
  storage: StoragePrimitive,
  logger: Logger,
  intentEmitter: IntentEmitterPrimitive,
  type: 'rss' | 'telegram' | 'telegram-group',
  url: string,
  name: string,
  options?: {
    profile?: string | undefined;
    groupUrl?: string | undefined;
    scriptRunner?: ScriptRunnerPrimitive | undefined;
  }
): Promise<NewsToolResult> {
  // For telegram-group, validate profile and groupUrl
  if (type === 'telegram-group') {
    if (!options?.profile || !options?.groupUrl) {
      const missing: string[] = [];
      if (!options?.profile) missing.push('profile');
      if (!options?.groupUrl) missing.push('group_url');
      return {
        success: false,
        action: 'add_source',
        error: `Missing required parameters for telegram-group: ${missing.join(', ')}`,
        schema: SCHEMA_ADD_SOURCE,
      };
    }
  }

  // Validate URL based on type (telegram-group uses groupUrl, not url)
  let normalizedUrl: string;
  if (type === 'telegram-group') {
    normalizedUrl = options?.groupUrl ?? url;
    // Validate groupUrl format
    try {
      new URL(normalizedUrl);
    } catch {
      return {
        success: false,
        action: 'add_source',
        error: `Invalid group URL: ${normalizedUrl}`,
      };
    }
  } else {
    const validation = type === 'rss' ? validateUrl(url) : validateTelegramHandle(url);
    if (!validation.valid) {
      return {
        success: false,
        action: 'add_source',
        error: validation.error ?? 'Validation failed',
      };
    }
    normalizedUrl = validation.url ?? url;
  }

  // Check for duplicate URLs
  const sources = await loadSources(storage);
  for (const source of sources.values()) {
    if (source.url === normalizedUrl && source.type === type) {
      return {
        success: false,
        action: 'add_source',
        error: `Source already exists: "${source.name}" (${source.id})`,
      };
    }
  }

  // Create new source
  const sourceId = generateSourceId();
  const trimmedName = name.trim();
  const newSource: NewsSource = {
    id: sourceId,
    type,
    url: normalizedUrl,
    name: trimmedName,
    enabled: true,
    createdAt: new Date(),
    ...(type === 'telegram-group' && {
      profile: options?.profile,
      groupUrl: options?.groupUrl,
    }),
  };

  sources.set(sourceId, newSource);
  await saveSources(storage, sources);

  logger.info(
    {
      sourceId,
      type,
      url: normalizedUrl,
      name: trimmedName,
      ...(type === 'telegram-group' && { profile: options?.profile }),
    },
    'News source added'
  );

  // Fetch initial articles immediately (non-blocking for tool response)
  let initialArticleCount = 0;
  let fetchError: string | undefined;

  try {
    logger.debug({ sourceId, type, url: normalizedUrl }, 'Fetching initial articles');

    let fetchSuccess = false;
    let fetchArticles: FetchedArticle[] = [];
    let fetchErrorMsg: string | undefined;
    let fetchLatestId: string | undefined;

    if (type === 'telegram-group') {
      if (!options?.scriptRunner || !options.profile || !options.groupUrl) {
        fetchErrorMsg = 'Script runner not available — will retry on next poll';
      } else {
        const groupFetchResult = await fetchTelegramGroup(
          options.profile,
          options.groupUrl,
          sourceId,
          trimmedName,
          undefined,
          options.scriptRunner
        );
        fetchSuccess = groupFetchResult.success;
        fetchArticles = groupFetchResult.articles;
        fetchErrorMsg = groupFetchResult.error;
        fetchLatestId = groupFetchResult.latestId;
      }
    } else {
      const fetchResult =
        type === 'rss'
          ? await fetchRssFeed(normalizedUrl, sourceId, trimmedName)
          : await fetchTelegramChannel(normalizedUrl, trimmedName);
      fetchSuccess = fetchResult.success;
      fetchArticles = fetchResult.articles;
      fetchErrorMsg = fetchResult.error;
      fetchLatestId = fetchResult.latestId ?? undefined;
    }

    if (fetchSuccess && fetchArticles.length > 0) {
      initialArticleCount = fetchArticles.length;

      // Save source state with lastSeenId for future deduplication
      const state: SourceState = {
        sourceId,
        lastFetchedAt: new Date(),
        consecutiveFailures: 0,
        lastSeenId: fetchLatestId,
      };
      await saveSourceState(storage, state);

      // Convert to NewsArticle format and emit as article_batch signal
      // NewsSignalFilter will score these articles (same flow as scheduled polls)
      const newsArticles = fetchArticles.map(convertToNewsArticle);

      const emitResult = intentEmitter.emitSignal({
        priority: 2, // Normal priority - autonomic layer will assess urgency
        data: {
          kind: NEWS_EVENT_KINDS.ARTICLE_BATCH,
          pluginId: NEWS_PLUGIN_ID,
          articles: newsArticles,
          sourceId,
          fetchedAt: new Date(),
          sourceType: type,
        },
      });

      if (!emitResult.success) {
        logger.warn({ error: emitResult.error }, 'Failed to emit article batch signal');
      } else {
        logger.info(
          { sourceId, articleCount: initialArticleCount, signalId: emitResult.signalId },
          'Emitted article batch signal for initial fetch'
        );
      }
    } else if (!fetchSuccess) {
      fetchError = fetchErrorMsg;
      logger.warn({ sourceId, error: fetchErrorMsg }, 'Initial fetch failed');

      // Save failed state
      const state: SourceState = {
        sourceId,
        lastFetchedAt: new Date(),
        consecutiveFailures: 1,
        lastError: fetchErrorMsg,
      };
      await saveSourceState(storage, state);
    } else {
      // Success but no articles
      logger.debug({ sourceId }, 'Initial fetch returned no articles');

      const state: SourceState = {
        sourceId,
        lastFetchedAt: new Date(),
        consecutiveFailures: 0,
      };
      await saveSourceState(storage, state);
    }
  } catch (error) {
    fetchError = error instanceof Error ? error.message : String(error);
    logger.error({ sourceId, error: fetchError }, 'Unexpected error during initial fetch');
  }

  return {
    success: true,
    action: 'add_source',
    sourceId,
    // Include fetch info in response
    ...(initialArticleCount > 0 && {
      initialArticleCount,
      // Tell COGNITION where articles went
      articlesStatus:
        'Articles have been scored and saved to memory. Use core.memory to search for them with tags like "news" or specific topics.',
    }),
    ...(fetchError && {
      fetchWarning: `Initial fetch failed: ${fetchError}. Will retry on next poll.`,
    }),
  };
}

/**
 * Remove a news source.
 */
async function removeSource(
  storage: StoragePrimitive,
  logger: Logger,
  sourceId: string
): Promise<NewsToolResult> {
  const sources = await loadSources(storage);
  const source = sources.get(sourceId);

  if (!source) {
    return {
      success: false,
      action: 'remove_source',
      error: 'Source not found',
    };
  }

  // Remove source
  sources.delete(sourceId);
  await saveSources(storage, sources);

  // Clean up source state
  await storage.delete(`${NEWS_STORAGE_KEYS.SOURCE_STATE_PREFIX}${sourceId}`);

  logger.info(
    {
      sourceId,
      name: source.name,
    },
    'News source removed'
  );

  return {
    success: true,
    action: 'remove_source',
    sourceId,
  };
}

/**
 * List all news sources.
 */
async function listSources(storage: StoragePrimitive): Promise<NewsToolResult> {
  const sources = await loadSources(storage);
  const summaries: NewsSummary[] = [];

  for (const source of sources.values()) {
    const state = await loadSourceState(storage, source.id);

    summaries.push({
      id: source.id,
      type: source.type,
      name: source.name,
      url: source.url,
      enabled: source.enabled,
      lastFetchedAt: state?.lastFetchedAt,
      consecutiveFailures: state?.consecutiveFailures,
    });
  }

  // Sort by name for consistent output
  summaries.sort((a, b) => a.name.localeCompare(b.name));

  return {
    success: true,
    action: 'list_sources',
    sources: summaries,
    total: summaries.length,
    // Help agent find articles
    hint:
      summaries.length > 0
        ? 'To find articles, use get_news action or core.memory with action "search" and query for topics or "news" tag.'
        : undefined,
  };
}

/**
 * News type for filtering.
 */
type NewsType = 'urgent' | 'interesting' | 'all';

/**
 * Get news articles from memory.
 * Retrieves facts created by this plugin (polled articles saved to memory).
 *
 * @param memorySearch - Memory search primitive
 * @param query - Search term (default: all news)
 * @param newsType - Filter by urgency: "urgent", "interesting", or "all" (default)
 * @param limit - Max results (default: 10)
 * @param offset - Skip first N results
 */
async function getNews(
  memorySearch: MemorySearchPrimitive,
  query?: string,
  newsType?: NewsType,
  limit = 10,
  offset = 0,
  sourceId?: string
): Promise<NewsToolResult> {
  // Use empty string for "all news" - searching 'news' would limit to content matching that word
  // Empty query with tag-based storage will return all plugin facts
  const searchQuery = query ?? '';

  // Smart default: if no urgency filter specified and no query,
  // show interesting news (curated content, not noise)
  // If query is provided or source filter is set, search all urgency levels
  const effectiveType: NewsType = newsType ?? (searchQuery || sourceId ? 'all' : 'interesting');

  // Pass source filter to the store level so it's applied before scoring/pagination
  const metadataFilter = sourceId ? { source: sourceId } : undefined;
  const result = await memorySearch.searchOwnFacts(searchQuery, {
    limit: limit * 2, // Fetch extra since we'll filter by type
    offset,
    minConfidence: 0.1, // Lower threshold to include filtered noise if needed
    metadata: metadataFilter,
  });

  let filtered = result.entries;

  // Filter by news type based on metadata.eventKind
  if (effectiveType !== 'all') {
    const targetEventKind = `news:${effectiveType}`;
    filtered = filtered.filter((e) => e.metadata['eventKind'] === targetEventKind);
  }

  // Apply limit after type filtering
  const limitedEntries = filtered.slice(0, limit);

  // Transform memory entries to article format
  const articles: NewsArticleEntry[] = limitedEntries.map((e) => {
    // Parse the content (format: "Title\n\nSummary" or just "Title")
    const lines = e.content.split('\n');
    const title = lines[0] ?? '';
    const summary = lines.slice(2).join('\n') || undefined;

    // Determine type from eventKind
    const eventKind = e.metadata['eventKind'] as string | undefined;
    let type: 'urgent' | 'interesting' | 'filtered' = 'interesting';
    if (eventKind === 'news:urgent') type = 'urgent';
    else if (eventKind === 'news:filtered') type = 'filtered';

    return {
      title,
      summary,
      timestamp: e.timestamp,
      topics: e.tags.filter((t) => t !== 'news'),
      confidence: e.confidence,
      type,
      url: e.metadata['url'] as string | undefined,
      source: e.metadata['source'] as string | undefined,
    };
  });

  // Determine hasMore: true if we have more filtered results than limit,
  // OR if the underlying search has more pages we haven't fetched yet
  const hasMoreFiltered = filtered.length > limit;
  const hasMorePages = result.pagination.hasMore;

  return {
    success: true,
    action: 'get_news',
    articles,
    count: articles.length,
    filter: effectiveType,
    pagination: {
      page: result.pagination.page,
      totalPages: result.pagination.totalPages,
      total: result.pagination.total,
      hasMore: hasMoreFiltered || hasMorePages,
    },
  };
}

/**
 * Create the news tool.
 */
export function createNewsTool(primitives: PluginPrimitives): PluginTool {
  const { storage, logger, intentEmitter, memorySearch } = primitives;

  const newsTool: PluginTool = {
    name: 'news',
    description: `Manage news sources and retrieve polled articles.
Actions: add_source, remove_source, list_sources, get_news, list_groups, stop_auth, refresh_source.

**get_news** — instant local search across stored articles (no network, no container). Sources are auto-polled periodically so stored articles are usually current. Always try this first. Use source_id to filter articles from a specific source.
Example: {"action": "get_news", "query": "technology"}
Example: {"action": "get_news", "source_id": "src_xxx"} — latest from one source

**refresh_source** — launches a browser container to fetch fresh content from the source (~15 seconds, expensive). Only use when the user explicitly asks to update/refresh a specific source. After refreshing, use get_news with the same source_id to see new articles.
Example: {"action": "refresh_source", "source_id": "src_xxx"}

**For any question about what a source writes or recent news, use get_news FIRST** with a relevant query (location, topic, person name, keyword).
Only fall back to web search if get_news returns no relevant results.

For private Telegram groups:
1. Call list_groups: {"action": "list_groups", "profile": "telegram"} — if auth is needed, it auto-starts a browser login and returns the URL
2. After user logs in: {"action": "stop_auth", "profile": "telegram"}, then list_groups again
3. Add source: {"action": "add_source", "type": "telegram-group", "name": "...", "profile": "telegram", "group_url": "https://web.telegram.org/a/#-..."}`,
    tags: [
      'rss',
      'telegram',
      'telegram-group',
      'news',
      'feed',
      'add',
      'remove',
      'list',
      'get',
      'refresh',
    ],
    parameters: [
      {
        name: 'action',
        type: 'string',
        description:
          'Required. One of: add_source, remove_source, list_sources, get_news, list_groups, stop_auth, refresh_source',
        required: true,
        enum: [
          'add_source',
          'remove_source',
          'list_sources',
          'get_news',
          'list_groups',
          'stop_auth',
          'refresh_source',
        ],
      },
      {
        name: 'type',
        type: 'string',
        description:
          'Source type: "rss" for RSS/Atom feeds, "telegram" for public channels, "telegram-group" for private groups (required for add_source)',
        required: false,
        enum: ['rss', 'telegram', 'telegram-group'],
      },
      {
        name: 'url',
        type: 'string',
        description:
          'RSS feed URL or Telegram @channel_handle (required for add_source with rss/telegram)',
        required: false,
      },
      {
        name: 'profile',
        type: 'string',
        description: 'Browser profile name for telegram-group sources (created via browser:auth)',
        required: false,
      },
      {
        name: 'group_url',
        type: 'string',
        description:
          'Full Telegram Web URL for telegram-group sources (e.g., https://web.telegram.org/a/#-1001234567890)',
        required: false,
      },
      {
        name: 'name',
        type: 'string',
        description: 'Human-readable name for the source (required for add_source)',
        required: false,
      },
      {
        name: 'sourceId',
        type: 'string',
        description: 'Source ID to remove (required for remove_source)',
        required: false,
      },
      {
        name: 'source_id',
        type: 'string',
        description:
          'Source ID. Required for refresh_source. Optional for get_news (filters articles to this source only). Get IDs from list_sources.',
        required: false,
      },
      {
        name: 'query',
        type: 'string',
        description: 'Search term for articles (default: all news). Used with get_news action.',
        required: false,
      },
      {
        name: 'urgency',
        type: 'string',
        description:
          'Filter by urgency: "urgent", "interesting", or "all" (default: all). Used with get_news action.',
        required: false,
        enum: ['urgent', 'interesting', 'all'],
      },
      {
        name: 'offset',
        type: 'number',
        description: 'Skip first N results for pagination. Used with get_news action.',
        required: false,
      },
    ],
    validate: (args) => {
      const a = args as Record<string, unknown>;

      if (!a['action'] || typeof a['action'] !== 'string') {
        return { success: false, error: 'action: required' };
      }

      if (
        ![
          'add_source',
          'remove_source',
          'list_sources',
          'get_news',
          'list_groups',
          'stop_auth',
          'refresh_source',
        ].includes(a['action'])
      ) {
        return {
          success: false,
          error:
            'action: must be one of [add_source, remove_source, list_sources, get_news, list_groups, stop_auth, refresh_source]',
        };
      }

      return { success: true, data: a };
    },
    execute: async (args, _context?: PluginToolContext): Promise<NewsToolResult> => {
      const action = args['action'];

      if (typeof action !== 'string') {
        return {
          success: false,
          action: 'unknown',
          error: 'Missing or invalid action parameter',
          receivedParams: Object.keys(args),
          schema: {
            availableActions: {
              add_source: SCHEMA_ADD_SOURCE,
              remove_source: SCHEMA_REMOVE_SOURCE,
              list_sources: SCHEMA_LIST_SOURCES,
              get_news: SCHEMA_GET_NEWS,
              list_groups: SCHEMA_LIST_GROUPS,
              stop_auth: SCHEMA_STOP_AUTH,
              refresh_source: SCHEMA_REFRESH_SOURCE,
            },
          },
        };
      }

      switch (action) {
        case 'add_source': {
          const type = args['type'] as 'rss' | 'telegram' | 'telegram-group' | undefined;
          const url = args['url'] as string | undefined;
          const name = args['name'] as string | undefined;
          const profile = args['profile'] as string | undefined;
          const groupUrl = args['group_url'] as string | undefined;

          // Validate required params
          if (!type || !name) {
            const missing: string[] = [];
            if (!type) missing.push('type');
            if (!name) missing.push('name');
            if (!url && type !== 'telegram-group') missing.push('url');

            return {
              success: false,
              action: 'add_source',
              error: `Missing required parameters: ${missing.join(', ')}`,
              receivedParams: Object.keys(args),
              schema: SCHEMA_ADD_SOURCE,
            };
          }

          if (!['rss', 'telegram', 'telegram-group'].includes(type)) {
            return {
              success: false,
              action: 'add_source',
              error: 'type must be "rss", "telegram", or "telegram-group"',
              receivedParams: Object.keys(args),
              schema: SCHEMA_ADD_SOURCE,
            };
          }

          // For non-group types, url is required
          if (type !== 'telegram-group' && !url) {
            return {
              success: false,
              action: 'add_source',
              error: 'Missing required parameter: url',
              receivedParams: Object.keys(args),
              schema: SCHEMA_ADD_SOURCE,
            };
          }

          return addSource(storage, logger, intentEmitter, type, url ?? '', name, {
            profile,
            groupUrl,
            scriptRunner: primitives.scriptRunner,
          });
        }

        case 'remove_source': {
          const sourceId = args['sourceId'] as string | undefined;

          if (!sourceId) {
            return {
              success: false,
              action: 'remove_source',
              error: 'Missing required parameter: sourceId',
              receivedParams: Object.keys(args),
              schema: SCHEMA_REMOVE_SOURCE,
            };
          }

          return removeSource(storage, logger, sourceId);
        }

        case 'list_sources': {
          return listSources(storage);
        }

        case 'get_news': {
          const query = args['query'] as string | undefined;
          // Pass undefined to let getNews apply smart default (interesting for empty query, all for searches)
          const newsType = args['urgency'] as NewsType | undefined;
          // Clamp limit/offset to valid ranges (non-negative, max 50 for limit)
          const rawLimit = (args['limit'] as number | undefined) ?? 10;
          const rawOffset = (args['offset'] as number | undefined) ?? 0;
          const limit = Math.max(0, Math.min(rawLimit, 50));
          const offset = Math.max(0, rawOffset);
          const getNewsSourceId = args['source_id'] as string | undefined;

          return getNews(memorySearch, query, newsType, limit, offset, getNewsSourceId);
        }

        case 'list_groups': {
          const listProfile = args['profile'] as string | undefined;

          if (!listProfile) {
            return {
              success: false,
              action: 'list_groups',
              error: 'Missing required parameter: profile',
              receivedParams: Object.keys(args),
              schema: SCHEMA_LIST_GROUPS,
            };
          }

          if (!primitives.scriptRunner) {
            return {
              success: false,
              action: 'list_groups',
              error: 'Script runner not available (Docker may not be running)',
            };
          }

          try {
            const scriptResult = await primitives.scriptRunner.runScript({
              scriptId: 'news.telegram_group.list',
              inputs: { profile: listProfile },
              timeoutMs: 60_000,
            });

            // Merge script-level and output-level errors into a single code
            const scriptError = !scriptResult.ok ? scriptResult.error : undefined;
            const output = scriptResult.ok
              ? (scriptResult.output as
                  | {
                      ok: boolean;
                      groups: { id: string; name: string; url: string }[];
                      error?: { code: string; message: string };
                    }
                  | undefined)
              : undefined;
            const outputError = output && !output.ok ? output.error : undefined;
            const errorCode = scriptError?.code ?? outputError?.code;
            const errorMsg = scriptError?.message ?? outputError?.message ?? 'Unknown error';

            // NOT_AUTHENTICATED → auto-start auth session (no separate auth_profile needed)
            if (errorCode === 'NOT_AUTHENTICATED') {
              if (!primitives.browserAuth) {
                return {
                  success: false,
                  action: 'list_groups',
                  error:
                    'Not authenticated and browser auth is not available (Docker may not be running)',
                };
              }

              // Remove stale profile volume for a clean re-auth
              try {
                const volumeName = `lifemodel-browser-profile-${listProfile}`;
                const { execFile: ef } = await import('node:child_process');
                const { promisify: p } = await import('node:util');
                await p(ef)('docker', ['volume', 'rm', '-f', volumeName], { timeout: 10_000 });
              } catch {
                // Best effort
              }

              // Check if image is ready
              const imageReady = await primitives.browserAuth.isImageReady();
              if (!imageReady) {
                const authRecipientId = _context?.recipientId;
                primitives.browserAuth.ensureImageInBackground((success) => {
                  if (!success) {
                    if (authRecipientId) {
                      primitives.intentEmitter.emitSendMessage(
                        authRecipientId,
                        'Failed to build the browser image. Make sure Docker is running and try again.'
                      );
                    }
                    return;
                  }
                  const browserAuth = primitives.browserAuth;
                  if (!browserAuth) return;
                  browserAuth
                    .startAuth(listProfile, 'https://web.telegram.org')
                    .then((session) => {
                      if (authRecipientId) {
                        primitives.intentEmitter.emitSendMessage(
                          authRecipientId,
                          `Browser is ready! Open this link to log in to Telegram:\n${session.authUrl}\n\nLet me know when you're done.`
                        );
                      }
                      primitives.intentEmitter.emitPendingIntention(
                        `Browser auth session started for profile "${listProfile}". Auth URL: ${session.authUrl}. ` +
                          `When the user confirms they are done, call stop_auth with profile "${listProfile}", then call list_groups again.`
                      );
                    })
                    .catch((_e: unknown) => {
                      /* best effort */
                    });
                });
                return {
                  success: false,
                  action: 'list_groups',
                  status: 'building_image',
                  hint: 'The browser image is being built (~5 minutes). You will be notified when the browser is ready for login.',
                };
              }

              // Start auth session immediately
              try {
                const session = await primitives.browserAuth.startAuth(
                  listProfile,
                  'https://web.telegram.org'
                );
                return {
                  success: false,
                  action: 'list_groups',
                  status: 'auth_required',
                  authUrl: session.authUrl,
                  hint:
                    `Not authenticated. A browser login session has been started. ` +
                    `Tell the user to open ${session.authUrl} to log in to Telegram. ` +
                    `When they confirm they are done, call stop_auth with profile "${listProfile}", then call list_groups again.`,
                };
              } catch (authErr) {
                return {
                  success: false,
                  action: 'list_groups',
                  error: `Not authenticated and failed to start auth: ${authErr instanceof Error ? authErr.message : String(authErr)}`,
                };
              }
            }

            // Other errors (infrastructure, no output, etc.)
            if (scriptError || !output?.ok) {
              return {
                success: false,
                action: 'list_groups',
                error: errorMsg,
                hint: 'This is an infrastructure error. Tell the user there is a temporary issue discovering groups and you will retry later. Do NOT ask the user for a URL — they cannot provide one.',
              };
            }

            return {
              success: true,
              action: 'list_groups',
              groups: output.groups,
              total: output.groups.length,
              hint:
                output.groups.length > 0
                  ? 'Use a group URL from this list with add_source action (type: "telegram-group") to start monitoring it.'
                  : 'No groups found. The user may need to join groups in Telegram first.',
            };
          } catch (error) {
            return {
              success: false,
              action: 'list_groups',
              error: `Failed to list groups: ${error instanceof Error ? error.message : String(error)}`,
              hint: 'This is an infrastructure error. Tell the user there is a temporary issue and you will retry later. Do NOT ask the user for a URL.',
            };
          }
        }

        case 'stop_auth': {
          const stopProfile = args['profile'] as string | undefined;

          if (!stopProfile) {
            return {
              success: false,
              action: 'stop_auth',
              error: 'Missing required parameter: profile',
              receivedParams: Object.keys(args),
              schema: SCHEMA_STOP_AUTH,
            };
          }

          if (!primitives.browserAuth) {
            return {
              success: false,
              action: 'stop_auth',
              error: 'Browser authentication is not available',
            };
          }

          try {
            await primitives.browserAuth.stopAuth(stopProfile);
            return {
              success: true,
              action: 'stop_auth',
              hint: 'Authentication session saved. Now call list_groups to discover available groups.',
            };
          } catch (error) {
            return {
              success: false,
              action: 'stop_auth',
              error: `Failed to stop auth session: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }

        case 'refresh_source': {
          const refreshSourceId = (args['source_id'] ?? args['sourceId']) as string | undefined;

          if (!refreshSourceId) {
            return {
              success: false,
              action: 'refresh_source',
              error: 'Missing required parameter: source_id',
              receivedParams: Object.keys(args),
              schema: SCHEMA_REFRESH_SOURCE,
            };
          }

          // Load source by ID
          const sources = await loadSources(storage);
          const source = sources.get(refreshSourceId);

          if (!source) {
            return {
              success: false,
              action: 'refresh_source',
              error: `Source not found: ${refreshSourceId}`,
              hint: 'Use list_sources to see available source IDs.',
            };
          }

          // Load existing state for deduplication
          const state = await loadSourceState(storage, refreshSourceId);

          // Cooldown: skip if source was fetched recently
          if (state?.lastFetchedAt) {
            const elapsed = Date.now() - state.lastFetchedAt.getTime();
            if (elapsed < REFRESH_COOLDOWN_MS) {
              const minutesAgo = Math.round(elapsed / 60_000);
              logger.info(
                { sourceId: refreshSourceId, minutesAgo, cooldownMs: REFRESH_COOLDOWN_MS },
                'Skipping refresh — source was fetched recently'
              );
              return {
                success: true,
                action: 'refresh_source',
                skipped: true,
                reason: `Source was fetched ${String(minutesAgo)} min ago. Use get_news to search stored articles.`,
              };
            }
          }

          logger.info(
            { sourceId: refreshSourceId, type: source.type, name: source.name },
            'Refreshing source on demand'
          );

          // Dispatch fetch by source type
          let fetchSuccess = false;
          let fetchArticles: FetchedArticle[] = [];
          let fetchErrorMsg: string | undefined;
          let fetchErrorCode: string | undefined;
          let fetchLatestId: string | undefined;

          try {
            if (source.type === 'telegram-group') {
              if (!primitives.scriptRunner) {
                return {
                  success: false,
                  action: 'refresh_source',
                  error: 'Script runner not available (Docker may not be running)',
                };
              }

              if (!source.profile || !source.groupUrl) {
                return {
                  success: false,
                  action: 'refresh_source',
                  error: 'Source is missing profile or groupUrl configuration',
                };
              }

              const groupResult = await fetchTelegramGroup(
                source.profile,
                source.groupUrl,
                refreshSourceId,
                source.name,
                state?.lastSeenId,
                primitives.scriptRunner
              );
              fetchSuccess = groupResult.success;
              fetchArticles = groupResult.articles;
              fetchErrorMsg = groupResult.error;
              fetchErrorCode = groupResult.errorCode;
              fetchLatestId = groupResult.latestId;
            } else if (source.type === 'rss') {
              const rssResult = await fetchRssFeed(source.url, refreshSourceId, source.name);
              fetchSuccess = rssResult.success;
              fetchArticles = rssResult.articles;
              fetchErrorMsg = rssResult.error;
              fetchLatestId = rssResult.latestId ?? undefined;
            } else {
              // telegram (public channel)
              const { fetchTelegramChannelUntil } = await import('../fetchers/telegram.js');
              const tgResult = await fetchTelegramChannelUntil(
                source.url,
                source.name,
                state?.lastSeenId
              );
              fetchSuccess = tgResult.success;
              fetchArticles = tgResult.articles;
              fetchErrorMsg = tgResult.error;
              fetchLatestId = tgResult.latestId ?? undefined;
            }
          } catch (error) {
            return {
              success: false,
              action: 'refresh_source',
              sourceId: refreshSourceId,
              error: `Fetch failed: ${error instanceof Error ? error.message : String(error)}`,
            };
          }

          // Handle NOT_AUTHENTICATED for telegram-group
          if (!fetchSuccess && fetchErrorCode === 'NOT_AUTHENTICATED') {
            return {
              success: false,
              action: 'refresh_source',
              sourceId: refreshSourceId,
              error: 'Not authenticated. Run list_groups to start a browser login session first.',
            };
          }

          if (!fetchSuccess) {
            // Update state with failure
            const newState: SourceState = {
              sourceId: refreshSourceId,
              lastFetchedAt: state?.lastFetchedAt ?? new Date(),
              consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1,
              lastError: fetchErrorMsg,
              lastSeenId: state?.lastSeenId,
            };
            await saveSourceState(storage, newState);

            return {
              success: false,
              action: 'refresh_source',
              sourceId: refreshSourceId,
              error: fetchErrorMsg ?? 'Fetch failed',
            };
          }

          // Filter new articles (inline — same logic as filterNewArticles in index.ts)
          let newArticles: FetchedArticle[];
          if (!state) {
            newArticles = fetchArticles;
          } else {
            const seenIds = new Set<string>();
            if (state.lastSeenId) seenIds.add(state.lastSeenId);
            newArticles = fetchArticles.filter((a) => {
              if (seenIds.has(a.id)) return false;
              if (a.publishedAt && a.publishedAt <= state.lastFetchedAt) return false;
              return true;
            });
          }

          // Update source state
          const newState: SourceState = {
            sourceId: refreshSourceId,
            lastFetchedAt: new Date(),
            consecutiveFailures: 0,
            lastSeenId: fetchLatestId ?? state?.lastSeenId,
          };
          await saveSourceState(storage, newState);

          // Emit article_batch signal if we have new articles
          if (newArticles.length > 0) {
            const newsArticles = newArticles.map(convertToNewsArticle);

            const emitResult = intentEmitter.emitSignal({
              priority: 2,
              data: {
                kind: NEWS_EVENT_KINDS.ARTICLE_BATCH,
                pluginId: NEWS_PLUGIN_ID,
                articles: newsArticles,
                sourceId: refreshSourceId,
                fetchedAt: new Date(),
                sourceType: source.type,
              },
            });

            if (!emitResult.success) {
              logger.warn({ error: emitResult.error }, 'Failed to emit article batch signal');
            } else {
              logger.info(
                {
                  sourceId: refreshSourceId,
                  articleCount: newArticles.length,
                  signalId: emitResult.signalId,
                },
                'Emitted article batch signal for refresh'
              );
            }
          }

          logger.info(
            {
              sourceId: refreshSourceId,
              totalFetched: fetchArticles.length,
              newArticles: newArticles.length,
            },
            'Source refresh complete'
          );

          return {
            success: true,
            action: 'refresh_source',
            sourceId: refreshSourceId,
            newArticleCount: newArticles.length,
            count: fetchArticles.length,
            ...(newArticles.length > 0 && {
              articlesStatus:
                'New articles have been scored and saved to memory. Use core.memory to search for them.',
            }),
            ...(newArticles.length === 0 && {
              hint: 'No new articles since last fetch.',
            }),
          };
        }

        default:
          return {
            success: false,
            action: action || 'unknown',
            error: `Unknown action: ${action}. Use "add_source", "remove_source", "list_sources", "get_news", "list_groups", "stop_auth", or "refresh_source".`,
            receivedParams: Object.keys(args),
            schema: {
              availableActions: {
                add_source: SCHEMA_ADD_SOURCE,
                remove_source: SCHEMA_REMOVE_SOURCE,
                list_sources: SCHEMA_LIST_SOURCES,
                get_news: SCHEMA_GET_NEWS,
                list_groups: SCHEMA_LIST_GROUPS,
                stop_auth: SCHEMA_STOP_AUTH,
                refresh_source: SCHEMA_REFRESH_SOURCE,
              },
            },
          };
      }
    },
  };

  return newsTool;
}

export { NEWS_PLUGIN_ID };
