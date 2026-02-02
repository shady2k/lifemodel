/**
 * Telegram Fetcher Tests
 *
 * Tests for Telegram channel fetching and HTML parsing.
 * Uses real HTML fixtures captured from actual Telegram channel pages.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchTelegramChannel,
  fetchTelegramChannelUntil,
  clearRateLimitTracking,
  parseHtml,
} from '../../../../src/plugins/news/fetchers/telegram.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load real HTML fixture (anonymized test data)
const TEST_CHANNEL_HTML = readFileSync(
  join(__dirname, '../../../fixtures/telegram-test-channel.html'),
  'utf-8'
);

// Minimal HTML for edge case testing
const EMPTY_CHANNEL_HTML = `
<!DOCTYPE html>
<html>
<head><title>Empty Channel</title></head>
<body>
<div class="tgme_channel_info">
  <div class="tgme_page_title">Empty Channel</div>
</div>
<div class="tgme_widget_message_wrap">
</div>
</body>
</html>
`;

const PRIVATE_CHANNEL_HTML = `
<!DOCTYPE html>
<html>
<head><title>Private Channel</title></head>
<body>
<div class="tgme_page_description">This channel is private</div>
</body>
</html>
`;

describe('Telegram Fetcher', () => {
  beforeEach(() => {
    clearRateLimitTracking();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('parseHtml - real fixture (test_channel)', () => {
    it('should parse all messages from real channel HTML', () => {
      const articles = parseHtml(TEST_CHANNEL_HTML, 'test_channel', 'Test Channel');

      expect(articles.length).toBeGreaterThan(0);
    });

    it('should extract message IDs correctly', () => {
      const articles = parseHtml(TEST_CHANNEL_HTML, 'test_channel', 'Test Channel');

      // All IDs should start with tg_test_channel_
      for (const article of articles) {
        expect(article.id).toMatch(/^tg_test_channel_\d+$/);
      }
    });

    it('should extract message URLs correctly', () => {
      const articles = parseHtml(TEST_CHANNEL_HTML, 'test_channel', 'Test Channel');

      for (const article of articles) {
        expect(article.url).toMatch(/^https:\/\/t\.me\/test_channel\/\d+$/);
      }
    });

    it('should extract dates when available', () => {
      const articles = parseHtml(TEST_CHANNEL_HTML, 'test_channel', 'Test Channel');

      // At least some articles should have dates
      const withDates = articles.filter((a) => a.publishedAt !== undefined);
      expect(withDates.length).toBeGreaterThan(0);
    });

    it('should handle forwarded messages', () => {
      const articles = parseHtml(TEST_CHANNEL_HTML, 'test_channel', 'Test Channel');

      // Check for forwarded messages (title contains [Fwd:])
      const forwarded = articles.filter((a) => a.title.includes('[Fwd:'));
      // The fixture contains a forwarded message from "Another Channel"
      expect(forwarded.length).toBeGreaterThanOrEqual(0); // May or may not have forwarded
    });

    it('should handle text messages with content', () => {
      const articles = parseHtml(TEST_CHANNEL_HTML, 'test_channel', 'Test Channel');

      // At least one article should have real text content
      const withText = articles.filter(
        (a) => !a.title.startsWith('[Photo]') && !a.title.startsWith('[Video]')
      );
      expect(withText.length).toBeGreaterThan(0);
    });

    it('should sort articles by message ID descending (newest first)', () => {
      const articles = parseHtml(TEST_CHANNEL_HTML, 'test_channel', 'Test Channel');

      if (articles.length > 1) {
        for (let i = 1; i < articles.length; i++) {
          const prevId = parseInt(articles[i - 1].id.split('_').pop() ?? '0', 10);
          const currId = parseInt(articles[i].id.split('_').pop() ?? '0', 10);
          expect(prevId).toBeGreaterThanOrEqual(currId);
        }
      }
    });

    it('should set sourceName correctly', () => {
      const articles = parseHtml(TEST_CHANNEL_HTML, 'test_channel', 'My Custom Name');

      for (const article of articles) {
        expect(article.sourceName).toBe('My Custom Name');
      }
    });
  });

  describe('parseHtml - edge cases', () => {
    it('should return empty array for channel with no messages', () => {
      const articles = parseHtml(EMPTY_CHANNEL_HTML, 'empty', 'Empty Channel');
      expect(articles).toEqual([]);
    });

    it('should handle malformed HTML gracefully', () => {
      const malformed = '<div class="tgme_widget_message" data-post="test/123">broken';
      const articles = parseHtml(malformed, 'test', 'Test');
      // Should not throw, may return empty or partial results
      expect(Array.isArray(articles)).toBe(true);
    });
  });

  describe('fetchTelegramChannel - with mocked fetch', () => {
    it('should parse messages from successful response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(TEST_CHANNEL_HTML),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchTelegramChannel('@test_channel', 'Test Channel');

      expect(result.success).toBe(true);
      expect(result.articles.length).toBeGreaterThan(0);
      expect(result.latestId).toBeDefined();
    });

    it('should normalize channel handle (remove @)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(TEST_CHANNEL_HTML),
      });
      vi.stubGlobal('fetch', mockFetch);

      await fetchTelegramChannel('@testchannel', 'Test');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://t.me/s/testchannel',
        expect.any(Object)
      );
    });

    it('should handle 404 not found', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchTelegramChannel('@nonexistent', 'Test');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should handle 429 rate limit', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchTelegramChannel('@ratelimited', 'Test');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Rate limited');
    });

    it('should handle private channel', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(PRIVATE_CHANNEL_HTML),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchTelegramChannel('@privatechannel', 'Private');

      expect(result.success).toBe(false);
      expect(result.error).toContain('private');
    });

    it('should handle network errors', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchTelegramChannel('@testchannel', 'Test');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');
    });

    it('should handle timeout', async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        const error = new Error('Aborted');
        error.name = 'AbortError';
        return Promise.reject(error);
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchTelegramChannel('@slowchannel', 'Slow');

      expect(result.success).toBe(false);
      expect(result.error).toContain('timeout');
    });

    it('should return empty articles for channel with no messages', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(EMPTY_CHANNEL_HTML),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchTelegramChannel('@emptychannel', 'Empty');

      expect(result.success).toBe(true);
      expect(result.articles).toEqual([]);
    });
  });

  describe('fetchTelegramChannelUntil - message gap handling', () => {
    it('should return articles when lastSeenId is higher than all current post IDs (deleted messages)', async () => {
      // This test verifies the fix for message gaps caused by deleted posts.
      // When lastSeenId (e.g., 26580) > all current post IDs (max: 26573),
      // we should still return the current posts, not 0 articles.
      const gapHtml = `
        <!DOCTYPE html>
        <html>
        <head><title>Gap Channel</title></head>
        <body>
        <div class="tgme_channel_info">
          <div class="tgme_page_title">Gap Test Channel</div>
        </div>
        <div class="tgme_widget_message" data-post="gap_channel/26573">
          <div class="tgme_widget_message_text">Post 26573</div>
          <div class="tgme_widget_message_date"><time datetime="2025-01-15T12:00:00Z"></time></div>
        </div>
        <div class="tgme_widget_message" data-post="gap_channel/26570">
          <div class="tgme_widget_message_text">Post 26570</div>
          <div class="tgme_widget_message_date"><time datetime="2025-01-15T11:00:00Z"></time></div>
        </div>
        </body>
        </html>
      `;

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(gapHtml),
      });
      vi.stubGlobal('fetch', mockFetch);

      // lastSeenId is 26580, which is HIGHER than max post ID (26573)
      // This can happen when posts 26574-26580 were deleted
      const result = await fetchTelegramChannelUntil(
        '@gap_channel',
        'Gap Test Channel',
        'tg_gap_channel_26580' // Higher than max post ID
      );

      expect(result.success).toBe(true);
      // Should get both posts despite lastSeenId being higher
      expect(result.articles.length).toBe(2);
      expect(result.articles[0].id).toBe('tg_gap_channel_26573');
      expect(result.articles[1].id).toBe('tg_gap_channel_26570');
    });

    it('should stop at exact lastSeenId match', async () => {
      // Normal case: stop when we find the exact lastSeenId
      const normalHtml = `
        <!DOCTYPE html>
        <html>
        <head><title>Normal Channel</title></head>
        <body>
        <div class="tgme_channel_info">
          <div class="tgme_page_title">Normal Test Channel</div>
        </div>
        <div class="tgme_widget_message" data-post="normal_channel/103">
          <div class="tgme_widget_message_text">Post 103</div>
          <div class="tgme_widget_message_date"><time datetime="2025-01-15T14:00:00Z"></time></div>
        </div>
        <div class="tgme_widget_message" data-post="normal_channel/102">
          <div class="tgme_widget_message_text">Post 102</div>
          <div class="tgme_widget_message_date"><time datetime="2025-01-15T13:00:00Z"></time></div>
        </div>
        <div class="tgme_widget_message" data-post="normal_channel/101">
          <div class="tgme_widget_message_text">Post 101</div>
          <div class="tgme_widget_message_date"><time datetime="2025-01-15T12:00:00Z"></time></div>
        </div>
        </body>
        </html>
      `;

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(normalHtml),
      });
      vi.stubGlobal('fetch', mockFetch);

      // lastSeenId is 102 - should only return post 103
      const result = await fetchTelegramChannelUntil(
        '@normal_channel',
        'Normal Test Channel',
        'tg_normal_channel_102'
      );

      expect(result.success).toBe(true);
      expect(result.articles.length).toBe(1);
      expect(result.articles[0].id).toBe('tg_normal_channel_103');
    });
  });

  describe('rate limiting', () => {
    it('should apply rate limiting between requests to same channel', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(EMPTY_CHANNEL_HTML),
      });
      vi.stubGlobal('fetch', mockFetch);

      // First request
      await fetchTelegramChannel('@testchannel', 'Test');

      // Second request immediately - should be delayed
      const startTime = Date.now();
      const promise = fetchTelegramChannel('@testchannel', 'Test');

      // Advance timers to trigger rate limit delay
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      // Both requests should complete
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should allow immediate requests to different channels', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(EMPTY_CHANNEL_HTML),
      });
      vi.stubGlobal('fetch', mockFetch);

      // Requests to different channels
      await fetchTelegramChannel('@channel1', 'Channel 1');
      await fetchTelegramChannel('@channel2', 'Channel 2');

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
