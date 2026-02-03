/**
 * Tavily Search Provider
 *
 * Implementation of the SearchProvider interface for Tavily API.
 * Tavily is optimized for AI/LLM use cases, returning clean, relevant results.
 * https://tavily.com/
 */

import type { Logger } from '../../../types/logger.js';
import type { WebSearchResult } from '../../web-shared/types.js';
import { truncateGraphemeSafe, HARD_LIMITS } from '../../web-shared/safety.js';
import type { SearchProvider, SearchParams, SearchResult } from './search-provider.js';

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════

/** Tavily API base URL */
const API_BASE = 'https://api.tavily.com/search';

/** Request timeout in milliseconds */
const TIMEOUT_MS = 15_000;

// ═══════════════════════════════════════════════════════════════
// TAVILY API TYPES
// ═══════════════════════════════════════════════════════════════

/** Tavily API response structure */
interface TavilySearchResponse {
  query?: string;
  results?: TavilyResult[];
  answer?: string; // AI-generated answer (we don't use this)
}

/** Individual result from Tavily */
interface TavilyResult {
  title?: string;
  url?: string;
  content?: string; // Snippet/description
  published_date?: string; // ISO date when available
  score?: number; // Relevance score
}

// ═══════════════════════════════════════════════════════════════
// PROVIDER IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════

/**
 * Tavily search provider implementation.
 */
export class TavilySearchProvider implements SearchProvider {
  readonly name = 'tavily' as const;
  private readonly apiKey: string | undefined;
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.apiKey = process.env['TAVILY_API_KEY'];
    this.logger = logger.child({ provider: 'tavily' });
  }

  /**
   * Check if the provider is available (has API key).
   */
  isAvailable(): boolean {
    return !!this.apiKey;
  }

  /**
   * Execute a search using Tavily API.
   */
  async search(params: SearchParams): Promise<SearchResult> {
    if (!this.apiKey) {
      return {
        ok: false,
        error: {
          code: 'AUTH_FAILED',
          message: 'TAVILY_API_KEY environment variable not set',
          retryable: false,
        },
      };
    }

    const { query, limit } = params;

    // Build request body
    const body: Record<string, unknown> = {
      api_key: this.apiKey,
      query,
      max_results: limit,
      search_depth: 'basic', // 'basic' or 'advanced' (advanced costs more)
      include_answer: false, // We just want search results
      include_raw_content: false, // Don't need full page content
    };

    this.logger.debug({ query, limit }, 'Executing Tavily search');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, TIMEOUT_MS);

    try {
      const response = await fetch(API_BASE, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      // Handle rate limiting
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined;
        return {
          ok: false,
          error: {
            code: 'RATE_LIMITED',
            message: 'Tavily API rate limit exceeded',
            retryable: true,
            retryAfterMs,
          },
        };
      }

      // Handle auth errors
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          error: {
            code: 'AUTH_FAILED',
            message: `Tavily API authentication failed (${String(response.status)})`,
            retryable: false,
          },
        };
      }

      // Handle other errors
      if (!response.ok) {
        return {
          ok: false,
          error: {
            code: 'PROVIDER_ERROR',
            message: `Tavily API error: ${String(response.status)} ${response.statusText}`,
            provider: 'tavily',
            retryable: response.status >= 500,
          },
        };
      }

      // Parse response
      let data: TavilySearchResponse;
      try {
        data = (await response.json()) as TavilySearchResponse;
      } catch {
        return {
          ok: false,
          error: {
            code: 'PROVIDER_ERROR',
            message: 'Failed to parse Tavily API response',
            provider: 'tavily',
            retryable: false,
          },
        };
      }

      // Transform results
      const tavilyResults = data.results ?? [];
      const results: WebSearchResult[] = [];

      for (const result of tavilyResults) {
        if (!result.title || !result.url) continue;

        // Parse display URL
        let displayUrl = result.url;
        try {
          const parsed = new URL(result.url);
          displayUrl = parsed.hostname + (parsed.pathname !== '/' ? parsed.pathname : '');
          if (displayUrl.length > 60) {
            displayUrl = displayUrl.slice(0, 57) + '...';
          }
        } catch {
          // Use original URL
        }

        // Truncate snippet
        const snippet = result.content
          ? truncateGraphemeSafe(result.content, HARD_LIMITS.maxSnippetLength)
          : '';

        // Build result object
        const searchResult: WebSearchResult = {
          title: result.title,
          url: result.url,
          displayUrl,
          snippet,
          provider: 'tavily',
        };

        // Add publishedAt if available
        if (result.published_date) {
          searchResult.publishedAt = result.published_date;
        }

        results.push(searchResult);
      }

      this.logger.info({ query, resultCount: results.length }, 'Tavily search completed');

      return { ok: true, results };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          ok: false,
          error: {
            code: 'TIMEOUT',
            message: `Tavily API request timed out after ${String(TIMEOUT_MS)}ms`,
            retryable: true,
          },
        };
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error({ error: message }, 'Tavily search failed');

      return {
        ok: false,
        error: {
          code: 'NETWORK_ERROR',
          message: `Tavily API request failed: ${message}`,
          retryable: true,
        },
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
