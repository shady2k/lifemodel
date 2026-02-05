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
} from '../../../types/plugin.js';
import type { Logger } from '../../../types/logger.js';
import type {
  NewsSource,
  SourceState,
  NewsToolResult,
  NewsSummary,
  NewsArticleEntry,
} from '../types.js';
import { NEWS_STORAGE_KEYS, NEWS_PLUGIN_ID, NEWS_EVENT_KINDS } from '../types.js';
import { validateUrl, validateTelegramHandle } from '../url-validator.js';
import { fetchRssFeed } from '../fetchers/rss.js';
import { fetchTelegramChannel } from '../fetchers/telegram.js';
import { convertToNewsArticle } from '../topic-extractor.js';

/**
 * Schema definitions for error responses.
 * Helps LLM self-correct when sending invalid parameters.
 */
const SCHEMA_ADD_SOURCE = {
  action: { type: 'string', required: true, enum: ['add_source'] },
  type: {
    type: 'string',
    required: true,
    enum: ['rss', 'telegram'],
    description: 'Source type: RSS feed or Telegram channel',
  },
  url: {
    type: 'string',
    required: true,
    description: 'RSS feed URL or Telegram @channel_handle',
  },
  name: {
    type: 'string',
    required: true,
    description: 'Human-readable name for this source',
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
  type: {
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
  type: 'rss' | 'telegram',
  url: string,
  name: string
): Promise<NewsToolResult> {
  // Validate URL based on type
  const validation = type === 'rss' ? validateUrl(url) : validateTelegramHandle(url);

  if (!validation.valid) {
    return {
      success: false,
      action: 'add_source',
      error: validation.error ?? 'Validation failed',
    };
  }

  // validation.url is defined when validation.valid is true
  const normalizedUrl = validation.url ?? url;

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
  };

  sources.set(sourceId, newSource);
  await saveSources(storage, sources);

  logger.info(
    {
      sourceId,
      type,
      url: normalizedUrl,
      name: trimmedName,
    },
    'News source added'
  );

  // Fetch initial articles immediately (non-blocking for tool response)
  let initialArticleCount = 0;
  let fetchError: string | undefined;

  try {
    logger.debug({ sourceId, type, url: normalizedUrl }, 'Fetching initial articles');

    const fetchResult =
      type === 'rss'
        ? await fetchRssFeed(normalizedUrl, sourceId, trimmedName)
        : await fetchTelegramChannel(normalizedUrl, trimmedName);

    if (fetchResult.success && fetchResult.articles.length > 0) {
      initialArticleCount = fetchResult.articles.length;

      // Save source state with lastSeenId for future deduplication
      const state: SourceState = {
        sourceId,
        lastFetchedAt: new Date(),
        consecutiveFailures: 0,
        lastSeenId: fetchResult.latestId,
      };
      await saveSourceState(storage, state);

      // Convert to NewsArticle format and emit as article_batch signal
      // NewsSignalFilter will score these articles (same flow as scheduled polls)
      const newsArticles = fetchResult.articles.map(convertToNewsArticle);

      const emitResult = intentEmitter.emitSignal({
        priority: 2, // Normal priority - autonomic layer will assess urgency
        data: {
          kind: NEWS_EVENT_KINDS.ARTICLE_BATCH,
          pluginId: NEWS_PLUGIN_ID,
          articles: newsArticles,
          sourceId,
          fetchedAt: new Date(),
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
    } else if (!fetchResult.success) {
      fetchError = fetchResult.error;
      logger.warn({ sourceId, error: fetchResult.error }, 'Initial fetch failed');

      // Save failed state
      const state: SourceState = {
        sourceId,
        lastFetchedAt: new Date(),
        consecutiveFailures: 1,
        lastError: fetchResult.error,
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
  newsType: NewsType = 'all',
  limit = 10,
  offset = 0
): Promise<NewsToolResult> {
  // Use empty string for "all news" - searching 'news' would limit to content matching that word
  // Empty query with tag-based storage will return all plugin facts
  const searchQuery = query ?? '';
  const result = await memorySearch.searchOwnFacts(searchQuery, {
    limit: limit * 2, // Fetch extra since we'll filter by type
    offset,
    minConfidence: 0.1, // Lower threshold to include filtered noise if needed
  });

  // Filter by news type based on metadata.eventKind
  let filtered = result.entries;
  if (newsType !== 'all') {
    const targetEventKind = `news:${newsType}`;
    filtered = result.entries.filter((e) => e.metadata['eventKind'] === targetEventKind);
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
    filter: newsType,
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
Actions: add_source, remove_source, list_sources, get_news.
Use get_news to retrieve articles already fetched from configured sources.
For breaking news or topics not in your feeds, use the search tool instead.`,
    tags: ['rss', 'telegram', 'news', 'feed', 'add', 'remove', 'list', 'get'],
    parameters: [
      {
        name: 'action',
        type: 'string',
        description:
          'Action to perform: "add_source", "remove_source", "list_sources", or "get_news"',
        required: true,
        enum: ['add_source', 'remove_source', 'list_sources', 'get_news'],
      },
      {
        name: 'type',
        type: 'string',
        description:
          'Source type: "rss" for RSS/Atom feeds, "telegram" for channels (required for add_source)',
        required: false,
        enum: ['rss', 'telegram'],
      },
      {
        name: 'url',
        type: 'string',
        description: 'RSS feed URL or Telegram @channel_handle (required for add_source)',
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
        name: 'query',
        type: 'string',
        description: 'Search term for articles (default: all news). Used with get_news action.',
        required: false,
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

      if (!['add_source', 'remove_source', 'list_sources', 'get_news'].includes(a['action'])) {
        return {
          success: false,
          error: 'action: must be one of [add_source, remove_source, list_sources, get_news]',
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
            },
          },
        };
      }

      switch (action) {
        case 'add_source': {
          const type = args['type'] as 'rss' | 'telegram' | undefined;
          const url = args['url'] as string | undefined;
          const name = args['name'] as string | undefined;

          // Validate required params
          if (!type || !url || !name) {
            const missing: string[] = [];
            if (!type) missing.push('type');
            if (!url) missing.push('url');
            if (!name) missing.push('name');

            return {
              success: false,
              action: 'add_source',
              error: `Missing required parameters: ${missing.join(', ')}`,
              receivedParams: Object.keys(args),
              schema: SCHEMA_ADD_SOURCE,
            };
          }

          if (!['rss', 'telegram'].includes(type)) {
            return {
              success: false,
              action: 'add_source',
              error: 'type must be "rss" or "telegram"',
              receivedParams: Object.keys(args),
              schema: SCHEMA_ADD_SOURCE,
            };
          }

          return addSource(storage, logger, intentEmitter, type, url, name);
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
          const newsType = (args['type'] as NewsType | undefined) ?? 'all';
          // Clamp limit/offset to valid ranges (non-negative, max 50 for limit)
          const rawLimit = (args['limit'] as number | undefined) ?? 10;
          const rawOffset = (args['offset'] as number | undefined) ?? 0;
          const limit = Math.max(0, Math.min(rawLimit, 50));
          const offset = Math.max(0, rawOffset);

          return getNews(memorySearch, query, newsType, limit, offset);
        }

        default:
          return {
            success: false,
            action: action || 'unknown',
            error: `Unknown action: ${action}. Use "add_source", "remove_source", "list_sources", or "get_news".`,
            receivedParams: Object.keys(args),
            schema: {
              availableActions: {
                add_source: SCHEMA_ADD_SOURCE,
                remove_source: SCHEMA_REMOVE_SOURCE,
                list_sources: SCHEMA_LIST_SOURCES,
                get_news: SCHEMA_GET_NEWS,
              },
            },
          };
      }
    },
  };

  return newsTool;
}

export { NEWS_PLUGIN_ID };
