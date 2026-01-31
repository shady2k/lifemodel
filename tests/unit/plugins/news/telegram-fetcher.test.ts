/**
 * Telegram Fetcher Tests
 *
 * Tests for Telegram channel fetching and HTML parsing.
 * Uses mock HTML data since we can't make real network requests in tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchTelegramChannel, clearRateLimitTracking } from '../../../../src/plugins/news/fetchers/telegram.js';

// Sample HTML that mimics Telegram's t.me/s/{channel} format
// Each message div needs to be followed by another message div or end of content for regex to match
const SAMPLE_CHANNEL_HTML = `
<!DOCTYPE html>
<html>
<head><title>Test Channel</title></head>
<body>
<div class="tgme_channel_info">
  <div class="tgme_page_title">Test Channel</div>
</div>
<div class="tgme_widget_message_wrap js-widget_message_wrap">
<div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="testchannel/123">
<div class="tgme_widget_message_bubble">
<div class="tgme_widget_message_text js-message_text" dir="auto">Breaking: Major tech announcement today!
This is a summary of the announcement with more details.</div>
<div class="tgme_widget_message_info"><time class="time" datetime="2024-03-15T10:30:00+00:00">10:30</time></div>
</div>
</div>
<div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="testchannel/122">
<div class="tgme_widget_message_bubble">
<div class="tgme_widget_message_text js-message_text" dir="auto">Previous news about market updates and important developments</div>
<div class="tgme_widget_message_info"><time class="time" datetime="2024-03-15T09:00:00+00:00">09:00</time></div>
</div>
</div>
<div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="testchannel/121">
<div class="tgme_widget_message_bubble">
<div class="tgme_widget_message_text js-message_text" dir="auto">Earlier post with &amp; HTML entities &lt;test&gt; decoded</div>
<div class="tgme_widget_message_info"><time class="time" datetime="2024-03-14T18:00:00+00:00">18:00</time></div>
</div>
</div>
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

describe('Telegram Fetcher', () => {
  beforeEach(() => {
    clearRateLimitTracking();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('fetchTelegramChannel - successful fetch', () => {
    it('should parse messages from channel HTML', async () => {
      // Mock fetch to return sample HTML
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(SAMPLE_CHANNEL_HTML),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchTelegramChannel('@testchannel', 'Test Channel');

      expect(result.success).toBe(true);
      expect(result.articles.length).toBeGreaterThan(0);
      expect(result.latestId).toBeDefined();
    });

    it('should normalize channel handle (remove @)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(SAMPLE_CHANNEL_HTML),
      });
      vi.stubGlobal('fetch', mockFetch);

      await fetchTelegramChannel('@testchannel', 'Test Channel');

      // URL should not have double @
      expect(mockFetch).toHaveBeenCalledWith(
        'https://t.me/s/testchannel',
        expect.any(Object)
      );
    });

    it('should handle channel handle without @', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(SAMPLE_CHANNEL_HTML),
      });
      vi.stubGlobal('fetch', mockFetch);

      await fetchTelegramChannel('testchannel', 'Test Channel');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://t.me/s/testchannel',
        expect.any(Object)
      );
    });

    it('should extract article URLs correctly', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(SAMPLE_CHANNEL_HTML),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchTelegramChannel('testchannel', 'Test Channel');

      expect(result.success).toBe(true);
      // Check that URLs are formatted correctly
      const article = result.articles.find((a) => a.id.includes('123'));
      expect(article?.url).toBe('https://t.me/testchannel/123');
    });

    it('should decode HTML entities in message text', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(SAMPLE_CHANNEL_HTML),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchTelegramChannel('testchannel', 'Test Channel');

      expect(result.success).toBe(true);
      expect(result.articles.length).toBeGreaterThan(0);

      // Find the article with HTML entities
      const article = result.articles.find((a) => a.id.includes('121'));
      expect(article).toBeDefined();
      // Verify & is decoded (was &amp;) and doesn't contain raw entities
      expect(article!.title).toContain('&');
      expect(article!.title).not.toContain('&amp;');
      expect(article!.title).not.toContain('&lt;');
      expect(article!.title).not.toContain('&gt;');
    });
  });

  describe('fetchTelegramChannel - error handling', () => {
    it('should handle 404 (channel not found)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchTelegramChannel('nonexistent', 'Missing Channel');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should handle 429 (rate limited)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchTelegramChannel('testchannel', 'Test Channel');

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

      const result = await fetchTelegramChannel('privatechannel', 'Private Channel');

      expect(result.success).toBe(false);
      expect(result.error).toContain('private');
    });

    it('should handle network errors', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchTelegramChannel('testchannel', 'Test Channel');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');
    });

    it('should handle timeout', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      const mockFetch = vi.fn().mockRejectedValue(abortError);
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchTelegramChannel('testchannel', 'Test Channel');

      expect(result.success).toBe(false);
      expect(result.error).toContain('timeout');
    });
  });

  describe('fetchTelegramChannel - empty results', () => {
    it('should handle empty channel (no messages)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(EMPTY_CHANNEL_HTML),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchTelegramChannel('emptychannel', 'Empty Channel');

      expect(result.success).toBe(true);
      expect(result.articles).toEqual([]);
    });
  });

  describe('rate limiting', () => {
    it('should apply rate limiting between requests to same channel', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(SAMPLE_CHANNEL_HTML),
      });
      vi.stubGlobal('fetch', mockFetch);

      // First request
      const promise1 = fetchTelegramChannel('testchannel', 'Test');

      // Advance time slightly (not enough for rate limit)
      vi.advanceTimersByTime(500);

      // Second request (should be delayed)
      const promise2 = fetchTelegramChannel('testchannel', 'Test');

      // Advance time to allow both to complete
      vi.advanceTimersByTime(3000);

      await Promise.all([promise1, promise2]);

      // Both should succeed
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should not apply rate limiting to different channels', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(SAMPLE_CHANNEL_HTML),
      });
      vi.stubGlobal('fetch', mockFetch);

      // Requests to different channels should not be rate limited
      const promise1 = fetchTelegramChannel('channel1', 'Channel 1');
      const promise2 = fetchTelegramChannel('channel2', 'Channel 2');

      vi.advanceTimersByTime(100);

      await Promise.all([promise1, promise2]);

      // Both should be called immediately (no rate limit delay)
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('message sorting', () => {
    it('should sort messages by ID descending (newest first)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(SAMPLE_CHANNEL_HTML),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchTelegramChannel('testchannel', 'Test Channel');

      expect(result.success).toBe(true);

      if (result.articles.length >= 2) {
        // First article should have higher ID than second
        const id1 = parseInt(result.articles[0]!.id.split('_').pop() ?? '0', 10);
        const id2 = parseInt(result.articles[1]!.id.split('_').pop() ?? '0', 10);
        expect(id1).toBeGreaterThan(id2);
      }
    });
  });
});
