/**
 * Serper Search Provider
 *
 * Implementation of the SearchProvider interface for Serper.dev API.
 * https://serper.dev/
 */

import type { Logger } from '../../../types/logger.js';
import type { WebSearchResult } from '../../web-shared/types.js';
import { truncateGraphemeSafe, HARD_LIMITS } from '../../web-shared/safety.js';
import type { SearchProvider, SearchParams, SearchResult } from './search-provider.js';

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════

/** Serper API base URL */
const API_BASE = 'https://google.serper.dev/search';

/** Request timeout in milliseconds */
const TIMEOUT_MS = 15_000;

// ═══════════════════════════════════════════════════════════════
// SERPER API TYPES
// ═══════════════════════════════════════════════════════════════

/** Serper API response structure */
interface SerperSearchResponse {
  organic?: SerperOrganicResult[];
  searchParameters?: {
    q?: string;
  };
}

/** Individual organic result from Serper */
interface SerperOrganicResult {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string; // e.g., "Jan 15, 2025"
  position?: number;
}

// ═══════════════════════════════════════════════════════════════
// PROVIDER IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════

/**
 * Serper search provider implementation.
 */
export class SerperSearchProvider implements SearchProvider {
  readonly name = 'serper' as const;
  private readonly apiKey: string | undefined;
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.apiKey = process.env['SERPER_API_KEY'];
    this.logger = logger.child({ provider: 'serper' });
  }

  /**
   * Check if the provider is available (has API key).
   */
  isAvailable(): boolean {
    return !!this.apiKey;
  }

  /**
   * Execute a search using Serper API.
   */
  async search(params: SearchParams): Promise<SearchResult> {
    if (!this.apiKey) {
      return {
        ok: false,
        error: {
          code: 'AUTH_FAILED',
          message: 'SERPER_API_KEY environment variable not set',
          retryable: false,
        },
      };
    }

    const { query, limit, lang, country } = params;

    // Build request body
    const body: Record<string, unknown> = {
      q: query,
      num: limit,
    };

    if (lang) {
      body['hl'] = lang; // host language
    }
    if (country) {
      body['gl'] = country; // geolocation
    }

    this.logger.debug({ query, limit, lang, country }, 'Executing Serper search');

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
          'X-API-KEY': this.apiKey,
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
            message: 'Serper API rate limit exceeded',
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
            message: `Serper API authentication failed (${String(response.status)})`,
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
            message: `Serper API error: ${String(response.status)} ${response.statusText}`,
            provider: 'serper',
            retryable: response.status >= 500,
          },
        };
      }

      // Parse response
      let data: SerperSearchResponse;
      try {
        data = (await response.json()) as SerperSearchResponse;
      } catch {
        return {
          ok: false,
          error: {
            code: 'PROVIDER_ERROR',
            message: 'Failed to parse Serper API response',
            provider: 'serper',
            retryable: false,
          },
        };
      }

      // Transform results
      const organicResults = data.organic ?? [];
      const results: WebSearchResult[] = [];

      for (const result of organicResults) {
        if (!result.title || !result.link) continue;

        // Parse display URL
        let displayUrl = result.link;
        try {
          const parsed = new URL(result.link);
          displayUrl = parsed.hostname + (parsed.pathname !== '/' ? parsed.pathname : '');
          if (displayUrl.length > 60) {
            displayUrl = displayUrl.slice(0, 57) + '...';
          }
        } catch {
          // Use original URL
        }

        // Truncate snippet
        const snippet = result.snippet
          ? truncateGraphemeSafe(result.snippet, HARD_LIMITS.maxSnippetLength)
          : '';

        // Build result object
        const searchResult: WebSearchResult = {
          title: result.title,
          url: result.link,
          displayUrl,
          snippet,
          provider: 'serper',
        };

        // Parse date (Serper returns dates like "Jan 15, 2025")
        if (result.date) {
          try {
            const parsed = new Date(result.date);
            if (!isNaN(parsed.getTime())) {
              searchResult.publishedAt = parsed.toISOString();
            }
          } catch {
            // Ignore invalid dates
          }
        }

        results.push(searchResult);
      }

      this.logger.info({ query, resultCount: results.length }, 'Serper search completed');

      return { ok: true, results };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          ok: false,
          error: {
            code: 'TIMEOUT',
            message: `Serper API request timed out after ${String(TIMEOUT_MS)}ms`,
            retryable: true,
          },
        };
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error({ error: message }, 'Serper search failed');

      return {
        ok: false,
        error: {
          code: 'NETWORK_ERROR',
          message: `Serper API request failed: ${message}`,
          retryable: true,
        },
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
