/**
 * Search Provider Interface
 *
 * Common interface for all search providers (Brave, Serper, etc.).
 */

import type {
  WebSearchResult,
  SearchProvider as SearchProviderType,
  WebError,
} from '../../web-shared/types.js';

/**
 * Search parameters passed to providers.
 * Note: Using explicit undefined unions for exactOptionalPropertyTypes compatibility.
 */
export interface SearchParams {
  /** Search query */
  query: string;
  /** Maximum results to return */
  limit: number;
  /** Language code (e.g., 'en') */
  lang?: string | undefined;
  /** Country code (e.g., 'US') */
  country?: string | undefined;
}

/**
 * Search result from a provider.
 */
export type SearchResult =
  | { ok: true; results: WebSearchResult[] }
  | { ok: false; error: WebError };

/**
 * Search provider interface.
 * All providers must implement this interface.
 */
export interface SearchProvider {
  /** Provider name for identification */
  readonly name: SearchProviderType;

  /**
   * Check if the provider is available (has API key, etc.).
   */
  isAvailable(): boolean;

  /**
   * Execute a search.
   * @param params Search parameters
   * @returns Search results or error
   */
  search(params: SearchParams): Promise<SearchResult>;
}
