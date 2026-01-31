/**
 * URL Validation with SSRF Protection
 *
 * Validates URLs for the news plugin to prevent Server-Side Request Forgery (SSRF) attacks.
 * Blocks:
 * - Private IP ranges (10.x, 192.168.x, 172.16-31.x, 127.x)
 * - Cloud metadata endpoints (169.254.169.254)
 * - Non-HTTP protocols (file://, javascript:, data:, etc.)
 * - Localhost and reserved addresses
 */

/**
 * Result of URL validation.
 * Note: Using explicit undefined unions for exactOptionalPropertyTypes compatibility.
 */
export interface UrlValidationResult {
  valid: boolean;
  error?: string | undefined;
  /** Normalized URL if valid */
  url?: string | undefined;
}

/**
 * Check if an IP address is in a private/reserved range.
 */
function isPrivateOrReservedIP(ip: string): boolean {
  // Parse IPv4 octets
  const parts = ip.split('.').map(Number);

  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    // Not a valid IPv4 - could be IPv6 or hostname, allow for now
    return false;
  }

  // Safe to access after length check - use type narrowing
  const [a, b, c] = parts as [number, number, number, number];

  // 10.0.0.0/8 - Private
  if (a === 10) return true;

  // 172.16.0.0/12 - Private (172.16.x.x - 172.31.x.x)
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.168.0.0/16 - Private
  if (a === 192 && b === 168) return true;

  // 127.0.0.0/8 - Loopback
  if (a === 127) return true;

  // 169.254.0.0/16 - Link-local (includes AWS metadata at 169.254.169.254)
  if (a === 169 && b === 254) return true;

  // 0.0.0.0/8 - Current network
  if (a === 0) return true;

  // 100.64.0.0/10 - Carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return true;

  // 192.0.0.0/24 - IETF Protocol Assignments
  if (a === 192 && b === 0 && c === 0) return true;

  // 192.0.2.0/24 - TEST-NET-1
  if (a === 192 && b === 0 && c === 2) return true;

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
 * Check if hostname resolves to a blocked address.
 * Blocks localhost variants and common internal hostnames.
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
    lower.endsWith('.lan')
  ) {
    return true;
  }

  // AWS/Cloud metadata hostnames
  if (
    lower === 'metadata.google.internal' ||
    lower === 'metadata' ||
    lower.includes('169.254.169.254')
  ) {
    return true;
  }

  // Check if hostname is an IP address
  if (isPrivateOrReservedIP(hostname)) {
    return true;
  }

  return false;
}

/**
 * Allowed URL protocols.
 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Validate a URL for use as a news source.
 *
 * @param input - The URL string to validate
 * @returns Validation result with normalized URL or error
 */
export function validateUrl(input: string): UrlValidationResult {
  // Trim and basic checks
  const trimmed = input.trim();

  if (!trimmed) {
    return { valid: false, error: 'URL cannot be empty' };
  }

  // Parse URL
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  // Check protocol
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      valid: false,
      error: `Protocol not allowed: ${parsed.protocol}. Only http and https are permitted.`,
    };
  }

  // Check for username/password in URL (potential credential leak)
  if (parsed.username || parsed.password) {
    return {
      valid: false,
      error: 'URLs with embedded credentials are not allowed',
    };
  }

  // Get hostname for validation
  const hostname = parsed.hostname;

  if (!hostname) {
    return { valid: false, error: 'URL must have a hostname' };
  }

  // Check for blocked hostnames
  if (isBlockedHostname(hostname)) {
    return {
      valid: false,
      error: 'URL points to a private or reserved address',
    };
  }

  // Additional check: hostname should have at least one dot (basic TLD check)
  // This blocks things like http://intranet/ but allows localhost to be caught above
  if (!hostname.includes('.') && !isPrivateOrReservedIP(hostname)) {
    return {
      valid: false,
      error: 'URL hostname appears to be an internal/intranet address',
    };
  }

  // Check port - block commonly exploited ports
  const port = parsed.port ? parseInt(parsed.port, 10) : null;
  if (port !== null) {
    // Block common internal service ports
    const blockedPorts = new Set([
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
      27017, // MongoDB
    ]);
    if (blockedPorts.has(port)) {
      return {
        valid: false,
        error: `Port ${String(port)} is not allowed for security reasons`,
      };
    }
  }

  // Return normalized URL (removes trailing slashes inconsistencies, etc.)
  return {
    valid: true,
    url: parsed.href,
  };
}

/**
 * Extract channel handle from a Telegram URL.
 * Supports: https://t.me/channel, https://t.me/s/channel, http://t.me/channel
 *
 * @param url - The URL to parse
 * @returns Channel handle without @ prefix, or null if not a valid t.me URL
 */
function extractTelegramHandleFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  // Check if it's a t.me URL
  if (parsed.hostname !== 't.me' && parsed.hostname !== 'www.t.me') {
    return null;
  }

  // Only allow http/https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  // Extract path segments: /channel or /s/channel
  const pathParts = parsed.pathname.split('/').filter(Boolean);

  if (pathParts.length === 0) {
    return null;
  }

  // Handle /s/channel format (web preview URL)
  const firstPart = pathParts[0];
  if (firstPart === 's' && pathParts.length >= 2) {
    const channelPart = pathParts[1];
    return channelPart ?? null;
  }

  // Handle /channel format
  return firstPart ?? null;
}

/**
 * Validate a Telegram channel handle or URL.
 *
 * Accepts:
 * - @channel_name
 * - channel_name
 * - https://t.me/channel_name
 * - https://t.me/s/channel_name
 *
 * @param input - The channel handle or URL
 * @returns Validation result with normalized handle (@channel) or error
 */
export function validateTelegramHandle(input: string): UrlValidationResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return { valid: false, error: 'Channel handle cannot be empty' };
  }

  // Check if it's a t.me URL
  let handle: string;
  if (trimmed.includes('://') || trimmed.startsWith('t.me/')) {
    // Normalize t.me/ without protocol
    const urlToCheck = trimmed.startsWith('t.me/') ? `https://${trimmed}` : trimmed;
    const extracted = extractTelegramHandleFromUrl(urlToCheck);

    if (!extracted) {
      return {
        valid: false,
        error: 'Invalid Telegram URL. Expected format: https://t.me/channel_name',
      };
    }
    handle = extracted;
  } else {
    // It's a handle, remove leading @ if present
    handle = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  }

  // Telegram usernames: 5-32 characters, alphanumeric and underscores
  // Must start with letter
  if (handle.length < 5 || handle.length > 32) {
    return {
      valid: false,
      error: 'Telegram channel handle must be 5-32 characters',
    };
  }

  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(handle)) {
    return {
      valid: false,
      error:
        'Telegram channel handle must start with a letter and contain only letters, numbers, and underscores',
    };
  }

  // Check for consecutive underscores (not allowed in Telegram)
  if (handle.includes('__')) {
    return {
      valid: false,
      error: 'Telegram channel handle cannot contain consecutive underscores',
    };
  }

  return {
    valid: true,
    url: `@${handle}`,
  };
}
