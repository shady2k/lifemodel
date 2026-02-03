/**
 * robots.txt Cache
 *
 * In-memory cache for robots.txt files with 1-hour TTL.
 * Parses robots.txt to check if a URL is allowed for our user agent.
 *
 * Security: Handles redirects manually with SSRF checks per hop.
 */

import { validateUrl, validateRedirect, checkResolvedIPs, MAX_REDIRECTS } from './safety.js';

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════

/** Cache TTL in milliseconds (1 hour) */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Fetch timeout for robots.txt in milliseconds */
const ROBOTS_TIMEOUT_MS = 10_000;

/** Maximum robots.txt size in bytes (500KB is generous) */
const MAX_ROBOTS_SIZE = 500_000;

/** Our user agent name for robots.txt matching */
const USER_AGENT = 'LifeModel';

/** Wildcard user agent */
const WILDCARD_AGENT = '*';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

interface RobotRule {
  type: 'allow' | 'disallow';
  pattern: string;
}

interface RobotDirectives {
  rules: RobotRule[];
  crawlDelay?: number;
}

interface CacheEntry {
  directives: RobotDirectives | null; // null means no robots.txt or fetch failed
  expiresAt: number;
}

// ═══════════════════════════════════════════════════════════════
// CACHE
// ═══════════════════════════════════════════════════════════════

/** In-memory cache keyed by origin (e.g., "https://example.com") */
const cache = new Map<string, CacheEntry>();

/**
 * Get cache entry if not expired.
 */
function getCached(origin: string): CacheEntry | null {
  const entry = cache.get(origin);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(origin);
    return null;
  }
  return entry;
}

/**
 * Set cache entry with TTL.
 */
function setCache(origin: string, directives: RobotDirectives | null): void {
  cache.set(origin, {
    directives,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

/**
 * Clear the entire cache (for testing).
 */
export function clearRobotsCache(): void {
  cache.clear();
}

// ═══════════════════════════════════════════════════════════════
// PARSER
// ═══════════════════════════════════════════════════════════════

/**
 * Parse robots.txt content into directives.
 * Returns directives for our user agent, falling back to wildcard.
 *
 * Fixed: Properly handles multiple consecutive User-agent lines.
 */
function parseRobotsTxt(content: string): RobotDirectives | null {
  const lines = content.split(/\r?\n/);

  // Group rules by user-agent
  const groups = new Map<string, RobotDirectives>();
  let currentAgents: string[] = [];
  let inAgentBlock = false;

  for (const line of lines) {
    // Remove comments
    const withoutComment = line.split('#')[0]?.trim() ?? '';
    if (!withoutComment) continue;

    // Parse directive
    const colonIndex = withoutComment.indexOf(':');
    if (colonIndex === -1) continue;

    const directive = withoutComment.slice(0, colonIndex).trim().toLowerCase();
    const value = withoutComment.slice(colonIndex + 1).trim();

    if (directive === 'user-agent') {
      // If we were collecting rules, we're now starting a new block
      if (!inAgentBlock) {
        currentAgents = [];
      }
      inAgentBlock = true;

      const agentKey = value.toLowerCase();
      currentAgents.push(agentKey);

      // Initialize group for this agent if not exists
      if (!groups.has(agentKey)) {
        groups.set(agentKey, { rules: [] });
      }
    } else if (directive === 'allow' || directive === 'disallow') {
      // End of user-agent block, now in rules
      inAgentBlock = false;

      // Add rule to all current agents
      for (const agent of currentAgents) {
        const group = groups.get(agent);
        if (group) {
          group.rules.push({ type: directive, pattern: value });
        }
      }
    } else if (directive === 'crawl-delay') {
      inAgentBlock = false;
      const delay = parseFloat(value);
      if (!isNaN(delay)) {
        for (const agent of currentAgents) {
          const group = groups.get(agent);
          if (group) {
            group.crawlDelay = delay * 1000; // Convert to ms
          }
        }
      }
    }
  }

  // Return directives for our user agent, then wildcard
  const ourDirectives = groups.get(USER_AGENT.toLowerCase());
  if (ourDirectives && ourDirectives.rules.length > 0) {
    return ourDirectives;
  }

  const wildcardDirectives = groups.get(WILDCARD_AGENT);
  if (wildcardDirectives && wildcardDirectives.rules.length > 0) {
    return wildcardDirectives;
  }

  return null; // No relevant rules
}

/**
 * Check if a path matches a robots.txt pattern.
 * Supports * wildcard and $ end anchor.
 */
function matchesPattern(path: string, pattern: string): boolean {
  if (!pattern) return true; // Empty pattern matches everything

  // Convert robots.txt pattern to regex
  // * matches any sequence, $ anchors to end
  let regexStr = '^';

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      regexStr += '.*';
    } else if (char === '$' && i === pattern.length - 1) {
      regexStr += '$';
    } else {
      // Escape regex special characters
      regexStr += char?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') ?? '';
    }
  }

  // If pattern doesn't end with $, it's a prefix match
  if (!pattern.endsWith('$')) {
    regexStr += '.*';
  }

  try {
    const regex = new RegExp(regexStr);
    return regex.test(path);
  } catch {
    // Invalid pattern, be permissive
    return pattern.startsWith(path) || path.startsWith(pattern);
  }
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch and cache robots.txt for an origin.
 *
 * Security: Handles redirects manually with SSRF validation per hop.
 * DNS resolution failure = deny (conservative approach).
 */
async function fetchRobotsTxt(origin: string): Promise<RobotDirectives | null> {
  // Check cache first
  const cached = getCached(origin);
  if (cached !== null) {
    return cached.directives;
  }

  const robotsUrl = `${origin}/robots.txt`;

  try {
    // Validate the robots.txt URL
    const validation = validateUrl(robotsUrl);
    if (!validation.valid) {
      setCache(origin, null);
      return null;
    }

    let currentUrl = validation.url;
    let redirectCount = 0;

    // Set up abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, ROBOTS_TIMEOUT_MS);

    try {
      // Manual redirect loop with SSRF checks per hop
      while (redirectCount < MAX_REDIRECTS) {
        // Check resolved IPs before each request
        // Security: DNS failure = deny (conservative)
        const ipError = await checkResolvedIPs(currentUrl.hostname);
        if (ipError) {
          setCache(origin, null);
          return null;
        }

        const response = await fetch(currentUrl.href, {
          signal: controller.signal,
          redirect: 'manual', // Handle redirects manually for security
          headers: {
            'User-Agent': `${USER_AGENT}/1.0 (robots.txt check)`,
          },
        });

        // Handle redirects with SSRF validation
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) {
            // Redirect without location - treat as no robots.txt
            setCache(origin, null);
            return null;
          }

          // Resolve relative URLs
          const redirectUrl = new URL(location, currentUrl);

          // Validate redirect URL (includes https->http downgrade check)
          const redirectValidation = validateRedirect(currentUrl, redirectUrl.href);
          if (!redirectValidation.valid) {
            // Redirect blocked - treat as no robots.txt
            setCache(origin, null);
            return null;
          }

          currentUrl = redirectValidation.url;
          redirectCount++;
          continue;
        }

        // 4xx means no robots.txt restrictions (including 404)
        if (response.status >= 400 && response.status < 500) {
          setCache(origin, null);
          return null;
        }

        // Other errors - be conservative and assume allowed
        if (!response.ok) {
          setCache(origin, null);
          return null;
        }

        // Check content length
        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > MAX_ROBOTS_SIZE) {
          setCache(origin, null);
          return null;
        }

        // Read body with size limit
        const reader = response.body?.getReader();
        if (!reader) {
          setCache(origin, null);
          return null;
        }

        const chunks: Uint8Array[] = [];
        let totalSize = 0;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          totalSize += value.length;
          if (totalSize > MAX_ROBOTS_SIZE) {
            void reader.cancel();
            setCache(origin, null);
            return null;
          }

          chunks.push(value);
        }

        // Combine and decode
        const combined = new Uint8Array(totalSize);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        const content = new TextDecoder().decode(combined);

        // Parse and cache
        const directives = parseRobotsTxt(content);
        setCache(origin, directives);
        return directives;
      }

      // Too many redirects - treat as no robots.txt
      setCache(origin, null);
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    // Fetch failed - allow (be permissive on network errors)
    setCache(origin, null);
    return null;
  }
}

/**
 * Check if a URL is allowed by robots.txt.
 *
 * @param url - The URL to check
 * @returns true if allowed, false if denied by robots.txt
 */
export async function isAllowedByRobots(url: string | URL): Promise<boolean> {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  const origin = parsed.origin;
  const path = parsed.pathname + parsed.search;

  const directives = await fetchRobotsTxt(origin);

  // No robots.txt or no rules = allowed
  if (!directives || directives.rules.length === 0) {
    return true;
  }

  // Find the most specific matching rule
  // robots.txt uses longest pattern match
  // On tie: allow wins (per robots.txt spec)
  let bestMatch: { rule: RobotRule; length: number } | null = null;

  for (const rule of directives.rules) {
    if (matchesPattern(path, rule.pattern)) {
      const length = rule.pattern.length;
      if (!bestMatch || length > bestMatch.length) {
        bestMatch = { rule, length };
      } else if (length === bestMatch.length && rule.type === 'allow') {
        // On tie, allow wins
        bestMatch = { rule, length };
      }
    }
  }

  // If no match, default to allow
  if (!bestMatch) {
    return true;
  }

  return bestMatch.rule.type === 'allow';
}
