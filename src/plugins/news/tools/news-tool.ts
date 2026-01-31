/**
 * News Plugin Tool
 *
 * Unified tool for managing news sources with action pattern.
 * Actions: add_source, remove_source, list_sources
 */

import type {
  PluginPrimitives,
  PluginTool,
  PluginToolContext,
  StoragePrimitive,
} from '../../../types/plugin.js';
import type { Logger } from '../../../types/logger.js';
import type { NewsSource, SourceState, NewsToolResult, NewsSummary } from '../types.js';
import { NEWS_STORAGE_KEYS, NEWS_PLUGIN_ID } from '../types.js';
import { validateUrl, validateTelegramHandle } from '../url-validator.js';

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
 * Add a new news source.
 */
async function addSource(
  storage: StoragePrimitive,
  logger: Logger,
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
  const newSource: NewsSource = {
    id: sourceId,
    type,
    url: normalizedUrl,
    name: name.trim(),
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
      name: newSource.name,
    },
    'News source added'
  );

  return {
    success: true,
    action: 'add_source',
    sourceId,
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
  };
}

/**
 * Create the news tool.
 */
export function createNewsTool(primitives: PluginPrimitives): PluginTool {
  const { storage, logger } = primitives;

  const newsTool: PluginTool = {
    name: 'news',
    description: `Manage news sources (RSS feeds and Telegram channels).
Actions: add_source, remove_source, list_sources.
The agent monitors these sources and notifies you about important news.`,
    tags: ['rss', 'telegram', 'news', 'feed', 'add', 'remove', 'list'],
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: 'Action to perform: "add_source", "remove_source", or "list_sources"',
        required: true,
        enum: ['add_source', 'remove_source', 'list_sources'],
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
    ],
    validate: (args) => {
      const a = args as Record<string, unknown>;

      if (!a['action'] || typeof a['action'] !== 'string') {
        return { success: false, error: 'action: required' };
      }

      if (!['add_source', 'remove_source', 'list_sources'].includes(a['action'])) {
        return {
          success: false,
          error: 'action: must be one of [add_source, remove_source, list_sources]',
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

          return addSource(storage, logger, type, url, name);
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

        default:
          return {
            success: false,
            action: action || 'unknown',
            error: `Unknown action: ${action}. Use "add_source", "remove_source", or "list_sources".`,
            receivedParams: Object.keys(args),
            schema: {
              availableActions: {
                add_source: SCHEMA_ADD_SOURCE,
                remove_source: SCHEMA_REMOVE_SOURCE,
                list_sources: SCHEMA_LIST_SOURCES,
              },
            },
          };
      }
    },
  };

  return newsTool;
}

export { NEWS_PLUGIN_ID };
