/**
 * Brave Search Provider
 *
 * Implementation of the SearchProvider interface for Brave Search API.
 * https://api.search.brave.com/
 */

import type { Logger } from '../../../types/logger.js';
import type { WebSearchResult } from '../../web-shared/types.js';
import { truncateGraphemeSafe, HARD_LIMITS } from '../../web-shared/safety.js';
import type { SearchProvider, SearchParams, SearchResult } from './search-provider.js';

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════

/** Brave Search API base URL */
const API_BASE = 'https://api.search.brave.com/res/v1/web/search';

/** Request timeout in milliseconds */
const TIMEOUT_MS = 15_000;

// ═══════════════════════════════════════════════════════════════
// BRAVE API TYPES
// ═══════════════════════════════════════════════════════════════

/** Brave Search API response structure */
interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
  query?: {
    original?: string;
  };
}

/** Individual web result from Brave */
interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string; // e.g., "2 hours ago", "January 15, 2025"
  page_age?: string; // ISO date string when available
}

// ═══════════════════════════════════════════════════════════════
// PROVIDER IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════

/**
 * Brave Search provider implementation.
 */
export class BraveSearchProvider implements SearchProvider {
  readonly name = 'brave' as const;
  private readonly apiKey: string | undefined;
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.apiKey = process.env['BRAVE_API_KEY'];
    this.logger = logger.child({ provider: 'brave' });
  }

  /**
   * Check if the provider is available (has API key).
   */
  isAvailable(): boolean {
    return !!this.apiKey;
  }

  /**
   * Execute a search using Brave Search API.
   */
  async search(params: SearchParams): Promise<SearchResult> {
    if (!this.apiKey) {
      return {
        ok: false,
        error: {
          code: 'AUTH_FAILED',
          message: 'BRAVE_API_KEY environment variable not set',
          retryable: false,
        },
      };
    }

    const { query, limit, lang, country } = params;

    // Build URL with parameters
    const url = new URL(API_BASE);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(limit));

    if (lang) {
      url.searchParams.set('search_lang', lang);
    }
    if (country) {
      url.searchParams.set('country', country);
    }

    // Don't include adult content
    url.searchParams.set('safesearch', 'moderate');

    this.logger.debug({ query, limit, lang, country }, 'Executing Brave search');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, TIMEOUT_MS);

    try {
      const response = await fetch(url.href, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': this.apiKey,
        },
      });

      // Handle rate limiting
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined;
        return {
          ok: false,
          error: {
            code: 'RATE_LIMITED',
            message: 'Brave Search API rate limit exceeded',
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
            message: `Brave Search API authentication failed (${String(response.status)})`,
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
            message: `Brave Search API error: ${String(response.status)} ${response.statusText}`,
            provider: 'brave',
            retryable: response.status >= 500,
          },
        };
      }

      // Parse response
      let data: BraveSearchResponse;
      try {
        data = (await response.json()) as BraveSearchResponse;
      } catch {
        return {
          ok: false,
          error: {
            code: 'PROVIDER_ERROR',
            message: 'Failed to parse Brave Search API response',
            provider: 'brave',
            retryable: false,
          },
        };
      }

      // Transform results
      const webResults = data.web?.results ?? [];
      const results: WebSearchResult[] = [];

      for (const result of webResults) {
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
        const snippet = result.description
          ? truncateGraphemeSafe(result.description, HARD_LIMITS.maxSnippetLength)
          : '';

        // Build result object
        const searchResult: WebSearchResult = {
          title: result.title,
          url: result.url,
          displayUrl,
          snippet,
          provider: 'brave',
        };

        // Add publishedAt if available
        if (result.page_age) {
          searchResult.publishedAt = result.page_age;
        }

        results.push(searchResult);
      }

      this.logger.info({ query, resultCount: results.length }, 'Brave search completed');

      return { ok: true, results };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          ok: false,
          error: {
            code: 'TIMEOUT',
            message: `Brave Search API request timed out after ${String(TIMEOUT_MS)}ms`,
            retryable: true,
          },
        };
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error({ error: message }, 'Brave search failed');

      return {
        ok: false,
        error: {
          code: 'NETWORK_ERROR',
          message: `Brave Search API request failed: ${message}`,
          retryable: true,
        },
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
