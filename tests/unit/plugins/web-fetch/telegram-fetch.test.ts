/**
 * Web Fetch — Telegram Integration Tests
 *
 * Tests that fetchPage() correctly detects Telegram URLs,
 * normalizes them, and routes HTML through the Telegram parser.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../../../../src/types/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEST_CHANNEL_HTML = readFileSync(
  join(__dirname, '../../../fixtures/telegram-test-channel.html'),
  'utf-8'
);

// Mock the safety module to bypass SSRF/DNS checks
vi.mock('../../../../src/plugins/web-shared/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/plugins/web-shared/safety.js')>();
  return {
    ...actual,
    // Always pass IP check
    checkResolvedIPs: vi.fn().mockResolvedValue(null),
  };
});

// Mock robots.txt to always allow (and track calls)
vi.mock('../../../../src/plugins/web-shared/robots.js', () => ({
  isAllowedByRobots: vi.fn().mockResolvedValue(true),
}));

// Import AFTER mocks are set up
const { fetchPage } = await import('../../../../src/plugins/web-fetch/fetcher.js');
const { isAllowedByRobots } = await import('../../../../src/plugins/web-shared/robots.js');

// Noop logger
const noop = () => {};
const mockLogger: Logger = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  fatal: noop,
  child: () => mockLogger,
};

/**
 * Build a mock Response from HTML string.
 */
function htmlResponse(html: string, status = 200): Response {
  const body = new TextEncoder().encode(html);
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchPage — Telegram URLs', () => {
  it('should fetch t.me/channel/123 and return structured markdown for single post', async () => {
    const mockFetch = vi.fn().mockResolvedValue(htmlResponse(TEST_CHANNEL_HTML));
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchPage({ url: 'https://t.me/test_channel/1001' }, mockLogger);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should have used the /s/ URL
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('t.me/s/test_channel'),
      expect.any(Object)
    );

    // Should use browser UA (not bot UA)
    const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('Chrome');

    // Markdown should contain View message links
    expect(result.data.markdown).toContain('[View message]');
  });

  it('should fetch channel URL and return all messages', async () => {
    const mockFetch = vi.fn().mockResolvedValue(htmlResponse(TEST_CHANNEL_HTML));
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchPage({ url: 'https://t.me/test_channel' }, mockLogger);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should contain multiple View message links
    const viewLinks = result.data.markdown.match(/\[View message\]/g);
    expect(viewLinks).not.toBeNull();
    expect(viewLinks!.length).toBeGreaterThan(1);
  });

  it('should not use Telegram parser for non-telegram URLs', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      htmlResponse('<html><body><h1>Hello</h1></body></html>')
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchPage(
      { url: 'https://example.com/page', respectRobots: false },
      mockLogger
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should go through Turndown, not Telegram parser
    expect(result.data.markdown).toContain('Hello');
    expect(result.data.markdown).not.toContain('[View message]');
  });

  it('should filter to single post when postId is in URL', async () => {
    // Create HTML with multiple messages, one matching postId 42
    const html = `
      <html><body>
      <div class="tgme_page_title">Test</div>
      <div class="tgme_widget_message" data-post="testch/42">
        <div class="tgme_widget_message_text">Target message</div>
        <div class="tgme_widget_message_date"><time datetime="2025-01-01T00:00:00Z"></time></div>
      </div>
      <div class="tgme_widget_message" data-post="testch/41">
        <div class="tgme_widget_message_text">Other message</div>
        <div class="tgme_widget_message_date"><time datetime="2025-01-01T00:00:00Z"></time></div>
      </div>
      </body></html>
    `;

    const mockFetch = vi.fn().mockResolvedValue(htmlResponse(html));
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchPage({ url: 'https://t.me/testch/42' }, mockLogger);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should contain the target message
    expect(result.data.markdown).toContain('Target message');

    // Should only have one View message link (filtered to single post)
    const viewLinks = result.data.markdown.match(/\[View message\]/g);
    expect(viewLinks).toHaveLength(1);
  });

  it('should skip robots.txt check for Telegram URLs', async () => {
    const mockFetch = vi.fn().mockResolvedValue(htmlResponse(TEST_CHANNEL_HTML));
    vi.stubGlobal('fetch', mockFetch);

    await fetchPage({ url: 'https://t.me/test_channel', respectRobots: true }, mockLogger);

    // Should NOT have checked robots.txt for Telegram
    expect(isAllowedByRobots).not.toHaveBeenCalled();
  });
});
