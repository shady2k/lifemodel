/**
 * Web Safety Module
 *
 * SSRF protection and URL validation for web plugins.
 * Blocks private IPs, validates URLs, and enforces security policies.
 *
 * Security notes:
 * - Re-check after every redirect hop to prevent bypass via redirects
 * - DNS is resolved separately from fetch, creating a small TOCTOU window
 *   (DNS rebinding attack possible but window is very short)
 * - For hostile DNS environments, consider IP pinning or custom resolver
 *
 * TODO: Implement IP pinning for robust DNS rebinding protection
 */

import * as dns from 'node:dns/promises';
import type { WebError } from './types.js';

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════

/** Allowed URL protocols */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Maximum redirect hops */
export const MAX_REDIRECTS = 5;

/** Hard limits enforced server-side regardless of input */
export const HARD_LIMITS = {
  /** Maximum response body size (1MB) */
  maxBytes: 1_000_000,
  /** Maximum markdown output size (64KB) */
  maxMarkdownBytes: 64_000,
  /** Maximum timeout (30 seconds) */
  timeoutMs: 30_000,
  /** Maximum search results */
  maxSearchResults: 10,
  /** Maximum snippet length in chars */
  maxSnippetLength: 200,
} as const;

/** Common internal service ports to block */
const BLOCKED_PORTS = new Set([
  22, // SSH
  23, // Telnet
  25, // SMTP
  135, // RPC
  137,
  138,
  139, // NetBIOS
  445, // SMB
  3306, // MySQL
  5432, // PostgreSQL
  6379, // Redis
  11211, // Memcached
  27017, // MongoDB
]);

// ═══════════════════════════════════════════════════════════════
// IP ADDRESS VALIDATION
// ═══════════════════════════════════════════════════════════════

/**
 * Check if an IPv4 address is private, reserved, or loopback.
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);

  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return false; // Not a valid IPv4
  }

  const [a, b, c] = parts as [number, number, number, number];

  // 10.0.0.0/8 - Private
  if (a === 10) return true;

  // 172.16.0.0/12 - Private (172.16.x.x - 172.31.x.x)
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.168.0.0/16 - Private
  if (a === 192 && b === 168) return true;

  // 127.0.0.0/8 - Loopback
  if (a === 127) return true;

  // 169.254.0.0/16 - Link-local (includes cloud metadata at 169.254.169.254)
  if (a === 169 && b === 254) return true;

  // 0.0.0.0/8 - Current network
  if (a === 0) return true;

  // 100.64.0.0/10 - Carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return true;

  // 192.0.0.0/24 - IETF Protocol Assignments
  if (a === 192 && b === 0 && c === 0) return true;

  // 192.0.2.0/24 - TEST-NET-1
  if (a === 192 && b === 0 && c === 2) return true;

  // 198.18.0.0/15 - Benchmark testing
  if (a === 198 && (b === 18 || b === 19)) return true;

  // 198.51.100.0/24 - TEST-NET-2
  if (a === 198 && b === 51 && c === 100) return true;

  // 203.0.113.0/24 - TEST-NET-3
  if (a === 203 && b === 0 && c === 113) return true;

  // 224.0.0.0/4 - Multicast
  if (a >= 224 && a <= 239) return true;

  // 240.0.0.0/4 - Reserved for future use
  if (a >= 240) return true;

  return false;
}

/**
 * Check if an IPv6 address is private, reserved, or loopback.
 */
function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  // Loopback (::1)
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;

  // Unspecified (::)
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return true;

  // Link-local (fe80::/10)
  if (lower.startsWith('fe80:') || lower.startsWith('fe8') || lower.startsWith('fe9')) return true;

  // Unique local (fc00::/7 - includes fd00::/8)
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;

  // IPv4-mapped IPv6 (::ffff:x.x.x.x)
  if (lower.startsWith('::ffff:')) {
    const ipv4Part = lower.slice(7);
    // Check if the mapped IPv4 is private
    if (isPrivateIPv4(ipv4Part)) return true;
  }

  // Site-local (deprecated but still should block: fec0::/10)
  if (lower.startsWith('fec') || lower.startsWith('fed') || lower.startsWith('fee')) return true;

  return false;
}

/**
 * Check if an IP address (v4 or v6) is private or reserved.
 */
export function isPrivateIP(ip: string): boolean {
  // Detect IPv6
  if (ip.includes(':')) {
    return isPrivateIPv6(ip);
  }
  return isPrivateIPv4(ip);
}

// ═══════════════════════════════════════════════════════════════
// HOSTNAME VALIDATION
// ═══════════════════════════════════════════════════════════════

/**
 * Check if a hostname is blocked (localhost, internal, etc.).
 */
function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();

  // Localhost variants
  if (lower === 'localhost' || lower === 'localhost.localdomain' || lower.endsWith('.localhost')) {
    return true;
  }

  // Common internal domains
  if (
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower.endsWith('.corp') ||
    lower.endsWith('.home') ||
    lower.endsWith('.lan') ||
    lower.endsWith('.intranet')
  ) {
    return true;
  }

  // Cloud metadata hostnames
  if (
    lower === 'metadata.google.internal' ||
    lower === 'metadata' ||
    lower.includes('169.254.169.254')
  ) {
    return true;
  }

  // Check if hostname is an IP address
  if (isPrivateIP(hostname)) {
    return true;
  }

  return false;
}

/**
 * Check for URL obfuscation attempts.
 * Blocks: @ in URL, mixed hex/octal in hostname, whitespace tricks
 */
function hasUrlObfuscation(url: string): boolean {
  // Check for @ before hostname (credential stuffing / confusion)
  // This is handled by URL parsing, but we reject it explicitly
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      return true;
    }
  } catch {
    return true; // Invalid URL
  }

  // Check for encoded characters in hostname that could bypass checks
  // Legitimate hostnames don't have % encoding
  const hostnameMatch = /^https?:\/\/([^/:]+)/i.exec(url);
  if (hostnameMatch?.[1]?.includes('%')) {
    return true;
  }

  // Check for whitespace in URL (could be used to confuse parsers)
  if (/\s/.test(url)) {
    return true;
  }

  return false;
}

// ═══════════════════════════════════════════════════════════════
// URL VALIDATION
// ═══════════════════════════════════════════════════════════════

/**
 * Result of URL validation.
 */
export type UrlValidationResult = { valid: true; url: URL } | { valid: false; error: WebError };

/**
 * Validate a URL for safety before fetching.
 * Does NOT resolve DNS - that's done separately to check resolved IPs.
 */
export function validateUrl(input: string): UrlValidationResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return {
      valid: false,
      error: { code: 'INVALID_URL', message: 'URL cannot be empty', retryable: false },
    };
  }

  // Check for obfuscation before parsing
  if (hasUrlObfuscation(trimmed)) {
    return {
      valid: false,
      error: {
        code: 'BLOCKED_URL',
        message: 'URL contains obfuscation or credentials',
        retryable: false,
      },
    };
  }

  // Parse URL
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      error: { code: 'INVALID_URL', message: 'Invalid URL format', retryable: false },
    };
  }

  // Check protocol
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      valid: false,
      error: {
        code: 'INVALID_URL',
        message: `Protocol not allowed: ${parsed.protocol}. Only http and https are permitted.`,
        retryable: false,
      },
    };
  }

  // Check hostname exists
  if (!parsed.hostname) {
    return {
      valid: false,
      error: { code: 'INVALID_URL', message: 'URL must have a hostname', retryable: false },
    };
  }

  // Check for blocked hostnames
  if (isBlockedHostname(parsed.hostname)) {
    return {
      valid: false,
      error: {
        code: 'BLOCKED_URL',
        message: 'URL points to a private or reserved address',
        retryable: false,
      },
    };
  }

  // Hostname should have at least one dot (basic TLD check)
  // Exception: IP addresses are already checked above
  if (!parsed.hostname.includes('.') && !isPrivateIP(parsed.hostname)) {
    return {
      valid: false,
      error: {
        code: 'BLOCKED_URL',
        message: 'URL hostname appears to be an internal address',
        retryable: false,
      },
    };
  }

  // Check port
  if (parsed.port) {
    const port = parseInt(parsed.port, 10);
    if (BLOCKED_PORTS.has(port)) {
      return {
        valid: false,
        error: {
          code: 'BLOCKED_URL',
          message: `Port ${String(port)} is blocked for security reasons`,
          retryable: false,
        },
      };
    }
  }

  return { valid: true, url: parsed };
}

/**
 * Resolve hostname and check if any resolved IPs are private.
 * CRITICAL: Call this before every fetch, including after redirects.
 */
export async function checkResolvedIPs(hostname: string): Promise<WebError | null> {
  try {
    // Resolve both IPv4 and IPv6
    const [ipv4Result, ipv6Result] = await Promise.allSettled([
      dns.resolve4(hostname),
      dns.resolve6(hostname),
    ]);

    const ips: string[] = [];

    if (ipv4Result.status === 'fulfilled') {
      ips.push(...ipv4Result.value);
    }
    if (ipv6Result.status === 'fulfilled') {
      ips.push(...ipv6Result.value);
    }

    // If no IPs resolved, let the fetch fail naturally
    if (ips.length === 0) {
      return null;
    }

    // Check each resolved IP
    for (const ip of ips) {
      if (isPrivateIP(ip)) {
        return {
          code: 'BLOCKED_URL',
          message: `Hostname ${hostname} resolves to private IP ${ip}`,
          retryable: false,
        };
      }
    }

    return null;
  } catch {
    // DNS resolution failed - let the fetch handle it
    return null;
  }
}

/**
 * Validate a redirect URL.
 * Enforces: no scheme downgrade (https -> http), same SSRF checks.
 */
export function validateRedirect(originalUrl: URL, redirectUrl: string): UrlValidationResult {
  // First, validate the redirect URL normally
  const result = validateUrl(redirectUrl);
  if (!result.valid) {
    return result;
  }

  // Check for scheme downgrade
  if (originalUrl.protocol === 'https:' && result.url.protocol === 'http:') {
    return {
      valid: false,
      error: {
        code: 'BLOCKED_URL',
        message: 'HTTPS to HTTP downgrade not allowed',
        retryable: false,
      },
    };
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// INPUT SANITIZATION
// ═══════════════════════════════════════════════════════════════

/**
 * Enforce hard limits on input parameters.
 * Note: Using explicit undefined unions for exactOptionalPropertyTypes compatibility.
 */
export function enforceHardLimits(input: {
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
  maxMarkdownBytes?: number | undefined;
  limit?: number | undefined;
}): {
  timeoutMs: number;
  maxBytes: number;
  maxMarkdownBytes: number;
  limit: number;
} {
  return {
    timeoutMs: Math.min(input.timeoutMs ?? HARD_LIMITS.timeoutMs, HARD_LIMITS.timeoutMs),
    maxBytes: Math.min(input.maxBytes ?? HARD_LIMITS.maxBytes, HARD_LIMITS.maxBytes),
    maxMarkdownBytes: Math.min(
      input.maxMarkdownBytes ?? HARD_LIMITS.maxMarkdownBytes,
      HARD_LIMITS.maxMarkdownBytes
    ),
    limit: Math.min(input.limit ?? 5, HARD_LIMITS.maxSearchResults),
  };
}

/**
 * Truncate a string to maxLength, ensuring grapheme-safe truncation.
 * Uses Intl.Segmenter for proper Unicode handling.
 */
export function truncateGraphemeSafe(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  // Use Intl.Segmenter for grapheme-safe truncation
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const segments = segmenter.segment(text);

  let result = '';
  let count = 0;

  for (const { segment } of segments) {
    if (count + segment.length > maxLength - 3) {
      // Leave room for ellipsis
      break;
    }
    result += segment;
    count += segment.length;
  }

  return result + '...';
}
