/**
 * Web Plugins Shared Types
 *
 * Common types, error codes, and response envelopes used by
 * both web-fetch and web-search plugins.
 */

// ═══════════════════════════════════════════════════════════════
// ERROR TYPES
// ═══════════════════════════════════════════════════════════════

/**
 * Discriminated union of all possible web errors.
 * Each error includes a `retryable` flag to indicate if retry makes sense.
 * Note: Using explicit undefined unions for exactOptionalPropertyTypes compatibility.
 */
export type WebError =
  | { code: 'NETWORK_ERROR'; message: string; retryable: true }
  | { code: 'TIMEOUT'; message: string; retryable: true }
  | { code: 'RATE_LIMITED'; message: string; retryable: true; retryAfterMs?: number | undefined }
  | { code: 'AUTH_FAILED'; message: string; retryable: false }
  | { code: 'BLOCKED_URL'; message: string; retryable: false }
  | { code: 'ROBOTS_DENIED'; message: string; retryable: false }
  | { code: 'INVALID_URL'; message: string; retryable: false }
  | { code: 'CONTENT_TOO_LARGE'; message: string; retryable: false }
  | {
      code: 'UNSUPPORTED_CONTENT_TYPE';
      message: string;
      retryable: false;
      contentType?: string | undefined;
    }
  | { code: 'PROVIDER_ERROR'; message: string; provider: string; retryable: boolean };

/**
 * Extract the error code type from WebError.
 */
export type WebErrorCode = WebError['code'];

// ═══════════════════════════════════════════════════════════════
// RESPONSE ENVELOPES
// ═══════════════════════════════════════════════════════════════

/**
 * Error response envelope.
 * All error responses share this structure.
 */
export interface WebErrorEnvelope {
  ok: false;
  requestId: string;
  error: WebError;
}

/**
 * Success response envelope.
 * All successful responses are marked as untrusted since content comes from the web.
 */
export interface WebSuccessEnvelope<T> {
  ok: true;
  requestId: string;
  data: T;
  /** Always present - web content is untrusted by definition */
  untrusted: true;
}

/**
 * Generic web response type.
 */
export type WebResponse<T> = WebSuccessEnvelope<T> | WebErrorEnvelope;

// ═══════════════════════════════════════════════════════════════
// WEB FETCH TYPES
// ═══════════════════════════════════════════════════════════════

/**
 * Input parameters for the web.fetch tool.
 * Note: Using explicit undefined unions for exactOptionalPropertyTypes compatibility.
 */
export interface WebFetchInput {
  /** URL to fetch (must be http or https) */
  url: string;
  /** Timeout in milliseconds (default: 30000, hard max enforced) */
  timeoutMs?: number | undefined;
  /** Maximum bytes to read from response (default: 1_000_000, hard max enforced) */
  maxBytes?: number | undefined;
  /** Maximum markdown output size (default: 32_000, hard max enforced) */
  maxMarkdownBytes?: number | undefined;
  /** Whether to respect robots.txt (default: true) */
  respectRobots?: boolean | undefined;
}

/**
 * Redirect hop information.
 */
export interface RedirectHop {
  from: string;
  to: string;
}

/**
 * Data payload for successful fetch response.
 * Note: Using explicit undefined unions for exactOptionalPropertyTypes compatibility.
 */
export interface WebFetchData {
  /** Original requested URL */
  url: string;
  /** Final URL after redirects */
  finalUrl: string;
  /** HTTP status code */
  status: number;
  /** Response Content-Type header */
  contentType: string;
  /** Resolved charset */
  charset: string;
  /** Sanitized markdown content */
  markdown: string;
  /** Plain text content (when HTML not present) */
  text?: string | undefined;
  /** Number of bytes read from response */
  bytesRead: number;
  /** Redirect chain */
  redirects: RedirectHop[];
}

/**
 * Success response for web.fetch.
 */
export type WebFetchOutput = WebSuccessEnvelope<WebFetchData>;

/**
 * Complete response type for web.fetch.
 */
export type WebFetchResponse = WebFetchOutput | WebErrorEnvelope;

// ═══════════════════════════════════════════════════════════════
// WEB SEARCH TYPES
// ═══════════════════════════════════════════════════════════════

/**
 * Supported search providers.
 */
export type SearchProvider = 'brave' | 'serper' | 'tavily';

/**
 * Input parameters for the web.search tool.
 * Note: Using explicit undefined unions for exactOptionalPropertyTypes compatibility.
 */
export interface WebSearchInput {
  /** Search query */
  query: string;
  /** Search provider (default: 'brave') */
  provider?: SearchProvider | undefined;
  /** Maximum results to return (default: 5, hard max: 10) */
  limit?: number | undefined;
  /** Language code (e.g., 'en') */
  lang?: string | undefined;
  /** Country code (e.g., 'US') */
  country?: string | undefined;
}

/**
 * Individual search result.
 * Note: Using explicit undefined unions for exactOptionalPropertyTypes compatibility.
 */
export interface WebSearchResult {
  /** Page title */
  title: string;
  /** Full URL */
  url: string;
  /** Display URL (may be truncated or formatted) */
  displayUrl: string;
  /** Snippet text (max 200 chars, grapheme-safe) */
  snippet: string;
  /** Publication date (ISO-8601) when available */
  publishedAt?: string | undefined;
  /** Provider that returned this result */
  provider: SearchProvider;
}

/**
 * Data payload for successful search response.
 */
export interface WebSearchData {
  /** Provider used for this search */
  provider: SearchProvider;
  /** Search results */
  results: WebSearchResult[];
}

/**
 * Success response for web.search.
 */
export type WebSearchOutput = WebSuccessEnvelope<WebSearchData>;

/**
 * Complete response type for web.search.
 */
export type WebSearchResponse = WebSearchOutput | WebErrorEnvelope;

// ═══════════════════════════════════════════════════════════════
// HELPER FACTORIES
// ═══════════════════════════════════════════════════════════════

/**
 * Create a success response envelope.
 */
export function createSuccessEnvelope<T>(requestId: string, data: T): WebSuccessEnvelope<T> {
  return {
    ok: true,
    requestId,
    data,
    untrusted: true,
  };
}

/**
 * Create an error response envelope.
 */
export function createErrorEnvelope(requestId: string, error: WebError): WebErrorEnvelope {
  return {
    ok: false,
    requestId,
    error,
  };
}

/**
 * Generate a unique request ID.
 */
export function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
