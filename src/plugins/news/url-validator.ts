/**
 * URL Validation for the News Plugin
 *
 * Delegates SSRF protection to web-shared/safety.ts (the canonical implementation).
 * This module adapts the shared validation to the news plugin's simpler return type
 * and adds Telegram-specific handle validation.
 */

import { validateUrl as sharedValidateUrl } from '../web-shared/safety.js';

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
 * Validate a URL for use as a news source.
 *
 * Delegates to web-shared/safety.ts for SSRF protection (private IPs, blocked
 * hostnames, blocked ports, URL obfuscation). Returns the news plugin's simpler
 * UrlValidationResult shape.
 *
 * @param input - The URL string to validate
 * @returns Validation result with normalized URL string or error message
 */
export function validateUrl(input: string): UrlValidationResult {
  const result = sharedValidateUrl(input);

  if (result.valid) {
    return { valid: true, url: result.url.href };
  }

  return { valid: false, error: result.error.message };
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
