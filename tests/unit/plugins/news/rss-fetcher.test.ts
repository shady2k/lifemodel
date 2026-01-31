/**
 * RSS Fetcher Tests
 *
 * Tests for RSS/Atom feed fetching and XML parsing.
 * Uses anonymized fixtures to test real-world RSS structures.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchRssFeed } from '../../../../src/plugins/news/fetchers/rss.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load RSS fixture (anonymized tech blog data)
const TECH_BLOG_RSS = readFileSync(
  join(__dirname, '../../../fixtures/rss-tech-blog.xml'),
  'utf-8'
);

// Minimal RSS for edge case testing
const EMPTY_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Empty Feed</title>
    <link>https://empty.example.com/</link>
    <description>No articles here</description>
  </channel>
</rss>`;

const SINGLE_ITEM_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Single Item Feed</title>
    <link>https://single.example.com/</link>
    <item>
      <title>The Only Article</title>
      <link>https://single.example.com/article/1</link>
      <guid>article-1</guid>
      <pubDate>Mon, 27 Jan 2026 10:00:00 GMT</pubDate>
      <description>This is the only article in the feed.</description>
    </item>
  </channel>
</rss>`;

const ATOM_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed Test</title>
  <link href="https://atom.example.com/"/>
  <updated>2026-01-27T12:00:00Z</updated>
  <entry>
    <title>Atom Article One</title>
    <link href="https://atom.example.com/entry/1"/>
    <id>urn:uuid:1234-5678-atom-entry-1</id>
    <published>2026-01-27T10:00:00Z</published>
    <summary>This is an Atom feed entry.</summary>
  </entry>
  <entry>
    <title>Atom Article Two</title>
    <link rel="alternate" href="https://atom.example.com/entry/2"/>
    <id>urn:uuid:1234-5678-atom-entry-2</id>
    <published>2026-01-26T15:00:00Z</published>
    <content type="html">&lt;p&gt;Content with HTML markup.&lt;/p&gt;</content>
  </entry>
</feed>`;

const MALFORMED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Broken Feed
    <item><title>Unclosed tags`;

const HTML_IN_CONTENT_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Feed with HTML</title>
    <link>https://html.example.com/</link>
    <item>
      <title>&lt;script&gt;alert('xss')&lt;/script&gt;Title</title>
      <link>https://html.example.com/article/1</link>
      <guid>xss-test-1</guid>
      <description><![CDATA[<p>Paragraph with <strong>bold</strong> and <a href="http://evil.com" onclick="steal()">link</a>.</p><script>alert('xss')</script>]]></description>
    </item>
  </channel>
</rss>`;

describe('RSS Fetcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('fetchRssFeed - with mocked fetch (tech blog fixture)', () => {
    it('should parse all articles from RSS feed', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map([['content-length', String(TECH_BLOG_RSS.length)]]),
        body: {
          getReader: () => createMockReader(TECH_BLOG_RSS),
        },
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchRssFeed(
        'https://techblog.example.com/rss/',
        'techblog',
        'Tech Blog'
      );

      expect(result.success).toBe(true);
      expect(result.articles.length).toBe(8); // 8 articles in fixture
    });

    it('should extract article titles correctly', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map(),
        body: {
          getReader: () => createMockReader(TECH_BLOG_RSS),
        },
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchRssFeed(
        'https://techblog.example.com/rss/',
        'techblog',
        'Tech Blog'
      );

      expect(result.success).toBe(true);

      const titles = result.articles.map((a) => a.title);
      expect(titles).toContain('Building a Custom IoT Controller with ESP32');
      expect(titles).toContain('Optimizing React Performance: Practical Tips');
      expect(titles).toContain('Why I Switched from VS Code to Neovim (And Back)');
    });

    it('should extract article URLs correctly', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map(),
        body: {
          getReader: () => createMockReader(TECH_BLOG_RSS),
        },
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchRssFeed(
        'https://techblog.example.com/rss/',
        'techblog',
        'Tech Blog'
      );

      expect(result.success).toBe(true);

      for (const article of result.articles) {
        expect(article.url).toMatch(/^https:\/\/techblog\.example\.com\/articles\/\d+\/$/);
      }
    });

    it('should extract dates and sort by newest first', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map(),
        body: {
          getReader: () => createMockReader(TECH_BLOG_RSS),
        },
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchRssFeed(
        'https://techblog.example.com/rss/',
        'techblog',
        'Tech Blog'
      );

      expect(result.success).toBe(true);

      // All articles should have dates
      for (const article of result.articles) {
        expect(article.publishedAt).toBeInstanceOf(Date);
      }

      // Should be sorted by date descending
      for (let i = 1; i < result.articles.length; i++) {
        const prev = result.articles[i - 1].publishedAt!;
        const curr = result.articles[i].publishedAt!;
        expect(prev.getTime()).toBeGreaterThanOrEqual(curr.getTime());
      }
    });

    it('should set sourceName correctly', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map(),
        body: {
          getReader: () => createMockReader(TECH_BLOG_RSS),
        },
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchRssFeed(
        'https://techblog.example.com/rss/',
        'techblog',
        'My Custom Name'
      );

      expect(result.success).toBe(true);

      for (const article of result.articles) {
        expect(article.sourceName).toBe('My Custom Name');
        expect(article.sourceId).toBe('techblog');
      }
    });

    it('should return latestId from first article', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map(),
        body: {
          getReader: () => createMockReader(TECH_BLOG_RSS),
        },
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchRssFeed(
        'https://techblog.example.com/rss/',
        'techblog',
        'Tech Blog'
      );

      expect(result.success).toBe(true);
      expect(result.latestId).toBeDefined();
      // Latest should be the first article (newest by date)
      expect(result.latestId).toBe(result.articles[0].id);
    });

    it('should strip HTML from descriptions (XSS protection)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map(),
        body: {
          getReader: () => createMockReader(TECH_BLOG_RSS),
        },
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchRssFeed(
        'https://techblog.example.com/rss/',
        'techblog',
        'Tech Blog'
      );

      expect(result.success).toBe(true);

      for (const article of result.articles) {
        if (article.summary) {
          // No HTML tags should remain
          expect(article.summary).not.toMatch(/<[^>]*>/);
        }
      }
    });
  });

  describe('fetchRssFeed - Atom format', () => {
    it('should parse Atom feeds correctly', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map(),
        body: {
          getReader: () => createMockReader(ATOM_FEED),
        },
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchRssFeed(
        'https://atom.example.com/feed',
        'atom-test',
        'Atom Test'
      );

      expect(result.success).toBe(true);
      expect(result.articles.length).toBe(2);
      expect(result.articles[0].title).toBe('Atom Article One');
      expect(result.articles[0].url).toBe('https://atom.example.com/entry/1');
    });

    it('should handle Atom link rel="alternate"', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map(),
        body: {
          getReader: () => createMockReader(ATOM_FEED),
        },
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchRssFeed(
        'https://atom.example.com/feed',
        'atom-test',
        'Atom Test'
      );

      expect(result.success).toBe(true);
      expect(result.articles[1].url).toBe('https://atom.example.com/entry/2');
    });
  });

  describe('fetchRssFeed - edge cases', () => {
    it('should return empty articles for empty feed', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map(),
        body: {
          getReader: () => createMockReader(EMPTY_RSS),
        },
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchRssFeed(
        'https://empty.example.com/rss',
        'empty',
        'Empty Feed'
      );

      expect(result.success).toBe(true);
      expect(result.articles).toEqual([]);
    });

    it('should handle single item feed', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map(),
        body: {
          getReader: () => createMockReader(SINGLE_ITEM_RSS),
        },
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchRssFeed(
        'https://single.example.com/rss',
        'single',
        'Single Item'
      );

      expect(result.success).toBe(true);
      expect(result.articles.length).toBe(1);
      expect(result.articles[0].title).toBe('The Only Article');
    });

    it('should handle malformed XML gracefully', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map(),
        body: {
          getReader: () => createMockReader(MALFORMED_XML),
        },
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchRssFeed(
        'https://broken.example.com/rss',
        'broken',
        'Broken Feed'
      );

      // Should either succeed with partial data or fail gracefully
      expect(typeof result.success).toBe('boolean');
      expect(Array.isArray(result.articles)).toBe(true);
    });

    it('should sanitize HTML/XSS in titles and descriptions', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map(),
        body: {
          getReader: () => createMockReader(HTML_IN_CONTENT_RSS),
        },
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchRssFeed(
        'https://html.example.com/rss',
        'html',
        'HTML Feed'
      );

      expect(result.success).toBe(true);
      expect(result.articles.length).toBe(1);

      const article = result.articles[0];
      // Script tags should be stripped (only tags, not text content)
      expect(article.title).not.toContain('<script>');
      expect(article.title).not.toContain('</script>');
      // Summary should have HTML tags stripped
      expect(article.summary).not.toContain('<script>');
      expect(article.summary).not.toContain('<p>');
      expect(article.summary).not.toContain('<strong>');
      expect(article.summary).not.toContain('<a ');
      expect(article.summary).not.toContain('onclick');
      // Text content should be preserved
      expect(article.summary).toContain('bold'); // Text from <strong>bold</strong>
      expect(article.summary).toContain('link'); // Text from <a>link</a>
    });
  });

  describe('fetchRssFeed - error handling', () => {
    it('should handle 404 not found', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchRssFeed(
        'https://notfound.example.com/rss',
        'notfound',
        'Not Found'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('404');
    });

    it('should handle 500 server error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchRssFeed(
        'https://error.example.com/rss',
        'error',
        'Error Feed'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('500');
    });

    it('should handle network errors', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error: ECONNREFUSED'));
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchRssFeed(
        'https://offline.example.com/rss',
        'offline',
        'Offline Feed'
      );

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

      const result = await fetchRssFeed(
        'https://slow.example.com/rss',
        'slow',
        'Slow Feed'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('timeout');
    });

    it('should reject feeds that are too large', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map([['content-length', '10000000']]), // 10MB
        body: {
          getReader: () => createMockReader(TECH_BLOG_RSS),
        },
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchRssFeed(
        'https://huge.example.com/rss',
        'huge',
        'Huge Feed'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('too large');
    });

    it('should handle unknown feed format', async () => {
      const unknownFormat = `<?xml version="1.0"?>
<unknown>
  <data>Not a feed</data>
</unknown>`;

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map(),
        body: {
          getReader: () => createMockReader(unknownFormat),
        },
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchRssFeed(
        'https://unknown.example.com/data',
        'unknown',
        'Unknown'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown feed format');
    });
  });

  describe('fetchRssFeed - User-Agent and headers', () => {
    it('should send proper User-Agent header', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map(),
        body: {
          getReader: () => createMockReader(EMPTY_RSS),
        },
      });
      vi.stubGlobal('fetch', mockFetch);

      await fetchRssFeed(
        'https://techblog.example.com/rss/',
        'test',
        'Test'
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://techblog.example.com/rss/',
        expect.objectContaining({
          headers: expect.objectContaining({
            'User-Agent': expect.stringContaining('LifeModel'),
          }),
        })
      );
    });

    it('should send Accept header for RSS/Atom', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map(),
        body: {
          getReader: () => createMockReader(EMPTY_RSS),
        },
      });
      vi.stubGlobal('fetch', mockFetch);

      await fetchRssFeed(
        'https://techblog.example.com/rss/',
        'test',
        'Test'
      );

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Accept: expect.stringContaining('application/rss+xml'),
          }),
        })
      );
    });
  });
});

/**
 * Helper to create a mock ReadableStream reader for fetch responses.
 */
function createMockReader(content: string): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  let consumed = false;

  return {
    read: async () => {
      if (consumed) {
        return { done: true, value: undefined };
      }
      consumed = true;
      return { done: false, value: data };
    },
    cancel: async () => {},
    releaseLock: () => {},
    closed: Promise.resolve(undefined),
  } as ReadableStreamDefaultReader<Uint8Array>;
}
