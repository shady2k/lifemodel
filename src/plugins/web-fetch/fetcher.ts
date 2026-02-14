/**
 * Web Fetcher
 *
 * HTTP client with:
 * - SSRF protection (validates URLs and resolved IPs)
 * - Redirect handling with security checks
 * - HTML to Markdown conversion via Turndown
 * - Charset detection and normalization
 * - Content sanitization
 */

import TurndownService from 'turndown';
import * as iconv from 'iconv-lite';
import type { Logger } from '../../types/logger.js';
import type {
  WebFetchInput,
  WebFetchData,
  WebFetchResponse,
  RedirectHop,
} from '../web-shared/types.js';
import {
  createSuccessEnvelope,
  createErrorEnvelope,
  generateRequestId,
} from '../web-shared/types.js';
import {
  validateUrl,
  validateRedirect,
  checkResolvedIPs,
  enforceHardLimits,
  MAX_REDIRECTS,
} from '../web-shared/safety.js';
import { isAllowedByRobots } from '../web-shared/robots.js';

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════

/** Allowed content types for fetching */
const ALLOWED_CONTENT_TYPES = new Set([
  'text/html',
  'text/plain',
  'application/xhtml+xml',
  'application/json',
]);

/** User agent for requests */
const USER_AGENT = 'LifeModel/1.0 (Web Fetch)';

// ═══════════════════════════════════════════════════════════════
// TURNDOWN SETUP
// ═══════════════════════════════════════════════════════════════

/**
 * Create a configured Turndown instance for HTML to Markdown conversion.
 */
function createTurndown(): TurndownService {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
    strongDelimiter: '**',
  });

  // Remove script and style tags completely
  turndown.remove(['script', 'style', 'noscript', 'iframe', 'object', 'embed']);

  // Keep links but simplify
  turndown.addRule('simplifyLinks', {
    filter: 'a',
    replacement: (content, node) => {
      const anchor = node as HTMLAnchorElement;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('javascript:') || href.startsWith('data:')) {
        return content;
      }
      // If link text is same as href, just use the URL
      if (content.trim() === href) {
        return href;
      }
      return `[${content}](${href})`;
    },
  });

  // Remove images (just keep alt text if meaningful)
  turndown.addRule('simplifyImages', {
    filter: 'img',
    replacement: (_content, node) => {
      const img = node as HTMLImageElement;
      const alt = img.getAttribute('alt');
      if (alt && alt.length > 2) {
        return `[Image: ${alt}]`;
      }
      return '';
    },
  });

  return turndown;
}

// ═══════════════════════════════════════════════════════════════
// CHARSET HANDLING
// ═══════════════════════════════════════════════════════════════

/**
 * Extract charset from Content-Type header.
 */
function extractCharset(contentType: string): string | null {
  const match = /charset=([^\s;]+)/i.exec(contentType);
  if (match?.[1]) {
    // Remove quotes if present
    return match[1].replace(/["']/g, '').toLowerCase();
  }
  return null;
}

/**
 * Detect charset from HTML meta tag.
 */
function detectCharsetFromHtml(buffer: Buffer): string | null {
  // Only check first 1024 bytes for meta charset
  const head = buffer.subarray(0, 1024).toString('ascii');

  // Check for <meta charset="...">
  const metaCharset = /<meta\s+charset=["']?([^"'\s>]+)/i.exec(head);
  if (metaCharset?.[1]) {
    return metaCharset[1].toLowerCase();
  }

  // Check for <meta http-equiv="Content-Type" content="...charset=...">
  const metaHttpEquiv = /content=["'][^"']*charset=([^"'\s;]+)/i.exec(head);
  if (metaHttpEquiv?.[1]) {
    return metaHttpEquiv[1].toLowerCase();
  }

  return null;
}

/**
 * Normalize charset name for iconv-lite.
 */
function normalizeCharset(charset: string): string {
  const lower = charset.toLowerCase();

  // Common aliases
  const aliases: Record<string, string> = {
    utf8: 'utf-8',
    'utf-16': 'utf-16le',
    ascii: 'utf-8', // Treat ASCII as UTF-8 (ASCII is subset)
    'iso-8859-1': 'latin1',
    'iso_8859-1': 'latin1',
    'windows-1251': 'win1251',
    'windows-1252': 'win1252',
    'koi8-r': 'koi8-r',
  };

  return aliases[lower] ?? lower;
}

/**
 * Decode buffer to string using detected charset.
 */
function decodeBuffer(
  buffer: Buffer,
  detectedCharset: string | null
): { text: string; charset: string } {
  // Default to UTF-8
  let charset = detectedCharset ?? 'utf-8';
  charset = normalizeCharset(charset);

  // Check if iconv-lite supports this encoding
  if (!iconv.encodingExists(charset)) {
    charset = 'utf-8';
  }

  try {
    const text = iconv.decode(buffer, charset);
    return { text, charset };
  } catch {
    // Fallback to UTF-8 with replacement
    return { text: buffer.toString('utf-8'), charset: 'utf-8' };
  }
}

// ═══════════════════════════════════════════════════════════════
// CONTENT TYPE HANDLING
// ═══════════════════════════════════════════════════════════════

/**
 * Extract base content type (without parameters).
 */
function getBaseContentType(contentType: string): string {
  return contentType.split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * Check if content type is allowed.
 */
function isAllowedContentType(contentType: string): boolean {
  const base = getBaseContentType(contentType);
  return ALLOWED_CONTENT_TYPES.has(base);
}

// ═══════════════════════════════════════════════════════════════
// MARKDOWN SANITIZATION
// ═══════════════════════════════════════════════════════════════

/**
 * Sanitize markdown content:
 * - Remove excessive whitespace
 * - Truncate to max length
 */
function sanitizeMarkdown(markdown: string, maxBytes: number): string {
  // Normalize line endings
  let clean = markdown.replace(/\r\n/g, '\n');

  // Remove excessive blank lines (more than 2 in a row)
  clean = clean.replace(/\n{3,}/g, '\n\n');

  // Trim each line
  clean = clean
    .split('\n')
    .map((line) => line.trim())
    .join('\n');

  // Trim overall
  clean = clean.trim();

  // Truncate to max bytes
  if (Buffer.byteLength(clean, 'utf-8') > maxBytes) {
    // Find a safe truncation point (at word boundary)
    const encoded = Buffer.from(clean, 'utf-8');
    const truncated = encoded.subarray(0, maxBytes - 20); // Leave room for ellipsis message
    let decoded = truncated.toString('utf-8');

    // Find last complete word
    const lastSpace = decoded.lastIndexOf(' ');
    if (lastSpace > decoded.length - 100) {
      decoded = decoded.slice(0, lastSpace);
    }

    clean = decoded + '\n\n[Content truncated]';
  }

  return clean;
}

// ═══════════════════════════════════════════════════════════════
// MAIN FETCHER
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch a web page and convert to markdown.
 */
export async function fetchPage(input: WebFetchInput, logger: Logger): Promise<WebFetchResponse> {
  const requestId = generateRequestId();
  const startTime = Date.now();

  // Enforce hard limits
  const limits = enforceHardLimits(input);
  const { timeoutMs, maxBytes, maxMarkdownBytes } = limits;
  const respectRobots = input.respectRobots ?? true;

  logger.debug({ requestId, url: input.url, limits }, 'Starting fetch');

  // Validate initial URL
  const validation = validateUrl(input.url);
  if (!validation.valid) {
    logger.warn({ requestId, url: input.url, error: validation.error }, 'URL validation failed');
    return createErrorEnvelope(requestId, validation.error);
  }

  let currentUrl = validation.url;
  const redirects: RedirectHop[] = [];
  let redirectCount = 0;

  // Check robots.txt if enabled
  if (respectRobots) {
    const allowed = await isAllowedByRobots(currentUrl);
    if (!allowed) {
      logger.info({ requestId, url: input.url }, 'Blocked by robots.txt');
      return createErrorEnvelope(requestId, {
        code: 'ROBOTS_DENIED',
        message: `robots.txt disallows fetching ${input.url}`,
        retryable: false,
      });
    }
  }

  // Set up abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    // Fetch with manual redirect handling for security checks
    while (redirectCount < MAX_REDIRECTS) {
      // Check resolved IPs before each request
      const ipError = await checkResolvedIPs(currentUrl.hostname);
      if (ipError) {
        logger.warn({ requestId, url: currentUrl.href, error: ipError }, 'IP check failed');
        return createErrorEnvelope(requestId, ipError);
      }

      logger.debug({ requestId, url: currentUrl.href, redirectCount }, 'Fetching');

      let response: Response;
      try {
        response = await fetch(currentUrl.href, {
          signal: controller.signal,
          redirect: 'manual', // Handle redirects manually for security
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html, application/xhtml+xml, text/plain, application/json',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });
      } catch (fetchError) {
        if (fetchError instanceof Error && fetchError.name === 'AbortError') {
          return createErrorEnvelope(requestId, {
            code: 'TIMEOUT',
            message: `Request timed out after ${String(timeoutMs)}ms`,
            retryable: true,
          });
        }
        return createErrorEnvelope(requestId, {
          code: 'NETWORK_ERROR',
          message: fetchError instanceof Error ? fetchError.message : 'Network error',
          retryable: true,
        });
      }

      // Handle redirects
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          return createErrorEnvelope(requestId, {
            code: 'PROVIDER_ERROR',
            message: `Redirect without Location header (status ${String(response.status)})`,
            provider: 'http',
            retryable: false,
          });
        }

        // Resolve relative URLs
        const redirectUrl = new URL(location, currentUrl);

        // Validate redirect URL
        const redirectValidation = validateRedirect(currentUrl, redirectUrl.href);
        if (!redirectValidation.valid) {
          logger.warn(
            {
              requestId,
              from: currentUrl.href,
              to: redirectUrl.href,
              error: redirectValidation.error,
            },
            'Redirect validation failed'
          );
          return createErrorEnvelope(requestId, redirectValidation.error);
        }

        // Check robots.txt for new URL if different origin
        if (respectRobots && redirectValidation.url.origin !== currentUrl.origin) {
          const allowed = await isAllowedByRobots(redirectValidation.url);
          if (!allowed) {
            logger.info(
              { requestId, url: redirectValidation.url.href },
              'Redirect blocked by robots.txt'
            );
            return createErrorEnvelope(requestId, {
              code: 'ROBOTS_DENIED',
              message: `robots.txt disallows fetching redirect target`,
              retryable: false,
            });
          }
        }

        redirects.push({ from: currentUrl.href, to: redirectValidation.url.href });
        currentUrl = redirectValidation.url;
        redirectCount++;
        continue;
      }

      // Check for rate limiting
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined;
        return createErrorEnvelope(requestId, {
          code: 'RATE_LIMITED',
          message: 'Rate limited by server',
          retryable: true,
          retryAfterMs,
        });
      }

      // Check for error responses
      if (!response.ok) {
        // Server errors (5xx) are retryable, client errors (4xx) are not
        if (response.status >= 500) {
          return createErrorEnvelope(requestId, {
            code: 'NETWORK_ERROR',
            message: `HTTP ${String(response.status)}: ${response.statusText}`,
            retryable: true,
          });
        }
        return createErrorEnvelope(requestId, {
          code: 'PROVIDER_ERROR',
          message: `HTTP ${String(response.status)}: ${response.statusText}`,
          provider: 'http',
          retryable: false,
        });
      }

      // Check content type
      const contentType = response.headers.get('content-type') ?? 'text/html';
      if (!isAllowedContentType(contentType)) {
        return createErrorEnvelope(requestId, {
          code: 'UNSUPPORTED_CONTENT_TYPE',
          message: `Content type not supported: ${contentType}`,
          retryable: false,
          contentType,
        });
      }

      // Check content length before reading
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > maxBytes) {
        return createErrorEnvelope(requestId, {
          code: 'CONTENT_TOO_LARGE',
          message: `Content too large: ${contentLength} bytes (max ${String(maxBytes)})`,
          retryable: false,
        });
      }

      // Read body with size limit
      const reader = response.body?.getReader();
      if (!reader) {
        return createErrorEnvelope(requestId, {
          code: 'PROVIDER_ERROR',
          message: 'Unable to read response body',
          provider: 'http',
          retryable: false,
        });
      }

      const chunks: Uint8Array[] = [];
      let totalSize = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        totalSize += value.length;
        if (totalSize > maxBytes) {
          void reader.cancel();
          return createErrorEnvelope(requestId, {
            code: 'CONTENT_TOO_LARGE',
            message: `Content exceeded ${String(maxBytes)} bytes during download`,
            retryable: false,
          });
        }

        chunks.push(value);
      }

      // Combine chunks into buffer
      const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));

      // Detect charset
      const headerCharset = extractCharset(contentType);
      const htmlCharset = getBaseContentType(contentType).includes('html')
        ? detectCharsetFromHtml(buffer)
        : null;
      const { text, charset } = decodeBuffer(buffer, headerCharset ?? htmlCharset);

      // Convert to markdown
      const baseContentType = getBaseContentType(contentType);
      let markdown: string;
      let plainText: string | undefined;

      const isPlainText = baseContentType === 'text/plain';
      if (isPlainText) {
        // Plain text: preserve indentation (sanitizeMarkdown trims every line)
        markdown = text
          .replace(/\r\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        plainText = text;
      } else if (baseContentType === 'application/json') {
        // Format JSON nicely
        try {
          const parsed: unknown = JSON.parse(text);
          markdown = '```json\n' + JSON.stringify(parsed, null, 2) + '\n```';
        } catch {
          markdown = '```\n' + text + '\n```';
        }
        plainText = text;
      } else {
        // HTML - convert to markdown
        const turndown = createTurndown();
        markdown = turndown.turndown(text);
      }

      // Sanitize and truncate markdown (skip for plain text — it strips indentation)
      if (!isPlainText) {
        markdown = sanitizeMarkdown(markdown, maxMarkdownBytes);
      } else if (Buffer.byteLength(markdown, 'utf-8') > maxMarkdownBytes) {
        // Still enforce byte limit for plain text
        const encoded = Buffer.from(markdown, 'utf-8');
        markdown =
          encoded.subarray(0, maxMarkdownBytes - 20).toString('utf-8') + '\n\n[Content truncated]';
      }

      const latencyMs = Date.now() - startTime;
      logger.info(
        {
          requestId,
          url: input.url,
          finalUrl: currentUrl.href,
          status: response.status,
          bytesRead: totalSize,
          redirectCount,
          latencyMs,
        },
        'Fetch completed'
      );

      const data: WebFetchData = {
        url: input.url,
        finalUrl: currentUrl.href,
        status: response.status,
        contentType,
        charset,
        markdown,
        text: plainText,
        bytesRead: totalSize,
        redirects,
      };

      return createSuccessEnvelope(requestId, data);
    }

    // Too many redirects
    return createErrorEnvelope(requestId, {
      code: 'PROVIDER_ERROR',
      message: `Too many redirects (max ${String(MAX_REDIRECTS)})`,
      provider: 'http',
      retryable: false,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (error instanceof Error && error.name === 'AbortError') {
      return createErrorEnvelope(requestId, {
        code: 'TIMEOUT',
        message: `Request timed out after ${String(timeoutMs)}ms`,
        retryable: true,
      });
    }

    logger.error({ requestId, url: input.url, error: errorMessage }, 'Fetch failed');
    return createErrorEnvelope(requestId, {
      code: 'NETWORK_ERROR',
      message: errorMessage,
      retryable: true,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
