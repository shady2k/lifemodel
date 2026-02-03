/**
 * Web Shared Module
 *
 * Common utilities shared between web-fetch and web-search plugins.
 * This is NOT a plugin itself - it's a shared library module.
 */

// Types and envelopes
export type {
  WebError,
  WebErrorCode,
  WebErrorEnvelope,
  WebSuccessEnvelope,
  WebResponse,
  WebFetchInput,
  WebFetchData,
  WebFetchOutput,
  WebFetchResponse,
  RedirectHop,
  SearchProvider,
  WebSearchInput,
  WebSearchResult,
  WebSearchData,
  WebSearchOutput,
  WebSearchResponse,
} from './types.js';

export { createSuccessEnvelope, createErrorEnvelope, generateRequestId } from './types.js';

// Safety utilities
export type { UrlValidationResult } from './safety.js';

export {
  validateUrl,
  validateRedirect,
  checkResolvedIPs,
  isPrivateIP,
  enforceHardLimits,
  truncateGraphemeSafe,
  HARD_LIMITS,
  MAX_REDIRECTS,
} from './safety.js';

// robots.txt
export { isAllowedByRobots, clearRobotsCache } from './robots.js';
