/**
 * Web Search Tool
 *
 * Tool definition for searching the web via configurable providers.
 * Provider priority is configurable via SEARCH_PROVIDER_PRIORITY env var.
 */

import type { PluginPrimitives, PluginTool, PluginToolContext } from '../../types/plugin.js';
import type {
  WebSearchInput,
  WebSearchResponse,
  SearchProvider as SearchProviderType,
} from '../web-shared/types.js';
import {
  createSuccessEnvelope,
  createErrorEnvelope,
  generateRequestId,
} from '../web-shared/types.js';
import { enforceHardLimits } from '../web-shared/safety.js';
import type { SearchProvider } from './providers/search-provider.js';
import {
  createProviderInstances,
  getDefaultProviderId,
  getAllProviderIds,
  isValidProviderId,
  getProviderEnvVar,
} from './providers/registry.js';

// ═══════════════════════════════════════════════════════════════
// SCHEMA
// ═══════════════════════════════════════════════════════════════

/**
 * Build JSON Schema dynamically based on available providers.
 */
function buildRawSchema(): Record<string, unknown> {
  const providerIds = getAllProviderIds();

  return {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
      provider: {
        type: ['string', 'null'],
        enum: [...providerIds, null],
        description: `Search provider to use. Available: ${providerIds.join(', ')}. Default determined by SEARCH_PROVIDER_PRIORITY or first available.`,
      },
      limit: {
        type: ['number', 'null'],
        description: 'Maximum results to return (default: 5, max: 10)',
      },
      lang: {
        type: ['string', 'null'],
        description: 'Language code (e.g., "en")',
      },
      country: {
        type: ['string', 'null'],
        description: 'Country code (e.g., "US")',
      },
    },
    required: ['query'],
    additionalProperties: false,
  };
}

// ═══════════════════════════════════════════════════════════════
// TOOL FACTORY
// ═══════════════════════════════════════════════════════════════

/**
 * Create the web search tool.
 */
export function createSearchTool(primitives: PluginPrimitives): PluginTool {
  const { logger } = primitives;

  // Create provider instances using registry
  const providers: Map<string, SearchProvider> = createProviderInstances(logger);
  const defaultProviderId = getDefaultProviderId();
  const allProviderIds = getAllProviderIds();

  // Build description dynamically
  const providerList = allProviderIds
    .map((id) => {
      const envVar = getProviderEnvVar(id);
      const isDefault = id === defaultProviderId;
      return `- \`${id}\`${isDefault ? ' (default)' : ''}: requires ${envVar ?? 'API key'}`;
    })
    .join('\n');

  const description = `Search the web using configurable providers.

Returns search results with titles, URLs, and snippets. Use the fetch tool to get full page content for specific results.

**Providers:**
${providerList}

**Configuration:**
Set SEARCH_PROVIDER_PRIORITY env var to customize provider order (comma-separated).
Example: SEARCH_PROVIDER_PRIORITY=tavily,serper,brave

**Note:** Results are returned but NOT fetched automatically. Call fetch separately for page content.`;

  return {
    name: 'search',
    description,

    tags: ['search', 'web', ...allProviderIds],

    rawParameterSchema: buildRawSchema(),

    parameters: [
      {
        name: 'query',
        type: 'string',
        description: 'The search query',
        required: true,
      },
      {
        name: 'provider',
        type: 'string',
        description: `Search provider to use. Default: ${defaultProviderId ?? 'none available'}`,
        required: false,
        enum: allProviderIds,
        default: defaultProviderId ?? undefined,
      },
      {
        name: 'limit',
        type: 'number',
        description: 'Maximum results to return (default: 5, max: 10)',
        required: false,
        default: 5,
      },
      {
        name: 'lang',
        type: 'string',
        description: 'Language code (e.g., "en")',
        required: false,
      },
      {
        name: 'country',
        type: 'string',
        description: 'Country code (e.g., "US")',
        required: false,
      },
    ],

    validate: (args) => {
      const a = args as Record<string, unknown>;

      // Query is required
      if (!a['query'] || typeof a['query'] !== 'string') {
        return { success: false, error: 'query: required string parameter' };
      }

      const query = a['query'].trim();
      if (query.length === 0) {
        return { success: false, error: 'query: cannot be empty' };
      }

      if (query.length > 500) {
        return { success: false, error: 'query: maximum length is 500 characters' };
      }

      // Validate provider using registry
      if (a['provider'] !== undefined && a['provider'] !== null) {
        if (typeof a['provider'] !== 'string' || !isValidProviderId(a['provider'])) {
          return {
            success: false,
            error: `provider: must be one of: ${allProviderIds.join(', ')}`,
          };
        }
      }

      // Validate limit
      if (a['limit'] !== undefined && a['limit'] !== null) {
        if (typeof a['limit'] !== 'number' || a['limit'] <= 0) {
          return { success: false, error: 'limit: must be a positive number' };
        }
      }

      // Validate lang
      if (a['lang'] !== undefined && a['lang'] !== null) {
        if (typeof a['lang'] !== 'string' || a['lang'].length > 10) {
          return { success: false, error: 'lang: must be a short language code' };
        }
      }

      // Validate country
      if (a['country'] !== undefined && a['country'] !== null) {
        if (typeof a['country'] !== 'string' || a['country'].length > 10) {
          return { success: false, error: 'country: must be a short country code' };
        }
      }

      return { success: true, data: a };
    },

    execute: async (args, _context?: PluginToolContext): Promise<WebSearchResponse> => {
      const requestId = generateRequestId();
      const startTime = Date.now();

      // Resolve provider - use specified or default
      const requestedProvider = args['provider'] as string | undefined;
      const providerId = requestedProvider ?? defaultProviderId;

      if (!providerId) {
        return createErrorEnvelope(requestId, {
          code: 'AUTH_FAILED',
          message: 'No search providers available. Set API key for at least one provider.',
          retryable: false,
        });
      }

      const input: WebSearchInput = {
        query: (args['query'] as string).trim(),
        provider: providerId as SearchProviderType,
        limit: args['limit'] as number | undefined,
        lang: args['lang'] as string | undefined,
        country: args['country'] as string | undefined,
      };

      // Enforce hard limits
      const limits = enforceHardLimits({ limit: input.limit });

      logger.debug({ requestId, input, limits }, 'Starting web search');

      // Get the provider instance
      const provider = providers.get(providerId);
      if (!provider) {
        const envVar = getProviderEnvVar(providerId);
        return createErrorEnvelope(requestId, {
          code: 'AUTH_FAILED',
          message: `Provider '${providerId}' not available. Set ${envVar ?? 'required API key'}.`,
          retryable: false,
        });
      }

      // Execute search
      const result = await provider.search({
        query: input.query,
        limit: limits.limit,
        lang: input.lang,
        country: input.country,
      });

      const latencyMs = Date.now() - startTime;

      if (!result.ok) {
        logger.warn(
          { requestId, provider: providerId, error: result.error, latencyMs },
          'Search failed'
        );
        return createErrorEnvelope(requestId, result.error);
      }

      logger.info(
        { requestId, provider: providerId, resultCount: result.results.length, latencyMs },
        'Search completed'
      );

      return createSuccessEnvelope(requestId, {
        provider: providerId as SearchProviderType,
        results: result.results,
      });
    },
  };
}
