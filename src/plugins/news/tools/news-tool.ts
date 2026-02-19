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

const SCHEMA_AUTH_PROFILE = {
  action: { type: 'string', required: true, enum: ['auth_profile'] },
  profile: {
    type: 'string',
    required: true,
    description: 'Profile name (alphanumeric + hyphens, e.g. "telegram")',
  },
  url: {
    type: 'string',
    required: false,
    description: 'URL to navigate to (default: https://web.telegram.org)',
  },
  force: {
    type: 'boolean',
    required: false,
    description: 'Force re-authentication even if profile already exists',
  },
};

const SCHEMA_STOP_AUTH = {
  action: { type: 'string', required: true, enum: ['stop_auth'] },
  container_id: {
    type: 'string',
    required: true,
    description: 'Container ID returned by auth_profile',
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
  offset = 0
): Promise<NewsToolResult> {
  // Use empty string for "all news" - searching 'news' would limit to content matching that word
  // Empty query with tag-based storage will return all plugin facts
  const searchQuery = query ?? '';

  // Smart default: if no urgency filter specified and no query,
  // show interesting news (curated content, not noise)
  // If query is provided, search all urgency levels by default
  const effectiveType: NewsType = newsType ?? (searchQuery ? 'all' : 'interesting');

  const result = await memorySearch.searchOwnFacts(searchQuery, {
    limit: limit * 2, // Fetch extra since we'll filter by type
    offset,
    minConfidence: 0.1, // Lower threshold to include filtered noise if needed
  });

  // Filter by news type based on metadata.eventKind
  let filtered = result.entries;
  if (effectiveType !== 'all') {
    const targetEventKind = `news:${effectiveType}`;
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
Actions: add_source, remove_source, list_sources, get_news, auth_profile, stop_auth.
Example: {"action": "get_news", "query": "technology"}

**For any news request, try get_news FIRST** with a relevant query (location, topic, keyword).
This searches articles from configured RSS feeds and Telegram channels.
Only fall back to web search if get_news returns no relevant results.

For private Telegram groups, first authenticate: {"action": "auth_profile", "profile": "telegram"}
Then add source: {"action": "add_source", "type": "telegram-group", "name": "...", "profile": "telegram", "group_url": "https://web.telegram.org/a/#-..."}`,
    tags: ['rss', 'telegram', 'telegram-group', 'news', 'feed', 'add', 'remove', 'list', 'get'],
    parameters: [
      {
        name: 'action',
        type: 'string',
        description:
          'Required. One of: add_source, remove_source, list_sources, get_news, auth_profile, stop_auth',
        required: true,
        enum: [
          'add_source',
          'remove_source',
          'list_sources',
          'get_news',
          'auth_profile',
          'stop_auth',
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
      {
        name: 'container_id',
        type: 'string',
        description: 'Container ID to stop (required for stop_auth action)',
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
          'auth_profile',
          'stop_auth',
        ].includes(a['action'])
      ) {
        return {
          success: false,
          error:
            'action: must be one of [add_source, remove_source, list_sources, get_news, auth_profile, stop_auth]',
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

          return getNews(memorySearch, query, newsType, limit, offset);
        }

        case 'auth_profile': {
          const authProfile = args['profile'] as string | undefined;
          const authUrl = (args['url'] as string | undefined) ?? 'https://web.telegram.org';
          const force = args['force'] === true;

          if (!authProfile) {
            return {
              success: false,
              action: 'auth_profile',
              error: 'Missing required parameter: profile',
              receivedParams: Object.keys(args),
              schema: SCHEMA_AUTH_PROFILE,
            };
          }

          if (!primitives.browserAuth) {
            return {
              success: false,
              action: 'auth_profile',
              error: 'Browser authentication is not available (Docker may not be running)',
            };
          }

          // Fast check: is the browser image built?
          const imageReady = await primitives.browserAuth.isImageReady();
          if (!imageReady) {
            // Start building in background — when done, auto-start auth and notify user
            primitives.browserAuth.ensureImageInBackground((success) => {
              if (!success) {
                primitives.intentEmitter.emitPendingIntention(
                  'Failed to build the browser image. Make sure Docker is running and try again.'
                );
                return;
              }
              // Image built! Now auto-start the auth session
              // browserAuth is guaranteed non-null here — we checked it above
              const browserAuth = primitives.browserAuth;
              if (!browserAuth) return;
              browserAuth
                .startAuth(authProfile, authUrl)
                .then((session) => {
                  primitives.intentEmitter.emitPendingIntention(
                    `Browser is ready for Telegram authentication! ` +
                      `Tell the user to open ${session.authUrl} to log in. ` +
                      `When they confirm they are done, call stop_auth with container_id "${session.containerId}".`
                  );
                })
                .catch((err: unknown) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  primitives.intentEmitter.emitPendingIntention(
                    `Browser image built, but failed to start auth session: ${msg}`
                  );
                });
            });
            return {
              success: true,
              action: 'auth_profile',
              status: 'building_image',
              hint:
                'The browser image is being built for the first time (~5 minutes). ' +
                'Tell the user you will notify them when the browser is ready for login. ' +
                'No need to retry — the system will auto-start the auth session when done.',
            };
          }

          // Fast check: does the profile volume already exist?
          if (!force) {
            const profileExists = await primitives.browserAuth.volumeExists(authProfile);
            if (profileExists) {
              return {
                success: true,
                action: 'auth_profile',
                status: 'profile_exists',
                hint:
                  `Profile "${authProfile}" already exists and is ready to use. ` +
                  'You can add a telegram-group source using this profile. ' +
                  'To re-authenticate, call auth_profile with force=true.',
              };
            }
          }

          try {
            const session = await primitives.browserAuth.startAuth(authProfile, authUrl);
            return {
              success: true,
              action: 'auth_profile',
              sourceId: session.containerId,
              hint: `Authentication browser is ready. Tell the user to open ${session.authUrl} to log in. When they confirm they are done, call stop_auth with container_id "${session.containerId}".`,
            };
          } catch (error) {
            return {
              success: false,
              action: 'auth_profile',
              error: `Failed to start auth session: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }

        case 'stop_auth': {
          const containerId = args['container_id'] as string | undefined;

          if (!containerId) {
            return {
              success: false,
              action: 'stop_auth',
              error: 'Missing required parameter: container_id',
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
            await primitives.browserAuth.stopAuth(containerId);
            return {
              success: true,
              action: 'stop_auth',
              hint: 'Authentication session saved. The profile can now be used for telegram-group sources.',
            };
          } catch (error) {
            return {
              success: false,
              action: 'stop_auth',
              error: `Failed to stop auth session: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }

        default:
          return {
            success: false,
            action: action || 'unknown',
            error: `Unknown action: ${action}. Use "add_source", "remove_source", "list_sources", "get_news", "auth_profile", or "stop_auth".`,
            receivedParams: Object.keys(args),
            schema: {
              availableActions: {
                add_source: SCHEMA_ADD_SOURCE,
                remove_source: SCHEMA_REMOVE_SOURCE,
                list_sources: SCHEMA_LIST_SOURCES,
                get_news: SCHEMA_GET_NEWS,
                auth_profile: SCHEMA_AUTH_PROFILE,
                stop_auth: SCHEMA_STOP_AUTH,
              },
            },
          };
      }
    },
  };

  return newsTool;
}

export { NEWS_PLUGIN_ID };
