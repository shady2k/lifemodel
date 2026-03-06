/**
 * Topic Extractor Tests
 *
 * Tests for breaking pattern detection and article conversion.
 * Note: Topic extraction was removed - LLM handles understanding
 * article content and user interests naturally via memory search.
 */

import { describe, it, expect } from 'vitest';
import { hasBreakingPattern, convertToNewsArticle, sanitizeTopics } from '../../../../src/plugins/news/topic-extractor.js';
import type { FetchedArticle } from '../../../../src/plugins/news/types.js';

describe('Topic Extractor', () => {
  describe('hasBreakingPattern', () => {
    it('should detect "breaking" keyword', () => {
      expect(hasBreakingPattern('Breaking: Stock market crashes')).toBe(true);
    });

    it('should detect "urgent" keyword', () => {
      expect(hasBreakingPattern('Urgent update on the situation')).toBe(true);
    });

    it('should detect "just in" keyword', () => {
      expect(hasBreakingPattern('Just in: New development reported')).toBe(true);
    });

    it('should detect "developing" keyword', () => {
      expect(hasBreakingPattern('Developing story: Fire breaks out')).toBe(true);
    });

    it('should detect "alert" keyword', () => {
      expect(hasBreakingPattern('Weather alert for the region')).toBe(true);
    });

    it('should detect "emergency" keyword', () => {
      expect(hasBreakingPattern('Emergency declared in the city')).toBe(true);
    });

    it('should detect "crisis" keyword', () => {
      expect(hasBreakingPattern('Economic crisis deepens')).toBe(true);
    });

    it('should be case-insensitive', () => {
      expect(hasBreakingPattern('BREAKING NEWS: Major event')).toBe(true);
      expect(hasBreakingPattern('breaking news: major event')).toBe(true);
    });

    it('should detect Russian breaking patterns', () => {
      expect(hasBreakingPattern('Срочно: важные новости')).toBe(true);
      expect(hasBreakingPattern('Молния: событие произошло')).toBe(true);
      expect(hasBreakingPattern('Экстренно: требуется внимание')).toBe(true);
    });

    it('should return false for regular news', () => {
      expect(hasBreakingPattern('Apple releases new iPhone')).toBe(false);
      expect(hasBreakingPattern('Scientists discover new species')).toBe(false);
    });

    it('should return false for empty text', () => {
      expect(hasBreakingPattern('')).toBe(false);
    });

    it('should handle undefined/null gracefully', () => {
      expect(hasBreakingPattern(null as unknown as string)).toBe(false);
      expect(hasBreakingPattern(undefined as unknown as string)).toBe(false);
    });
  });

  describe('sanitizeTopics', () => {
    it('should lowercase and deduplicate tags', () => {
      expect(sanitizeTopics(['AI', 'ai', 'Machine Learning', 'AI'])).toEqual(['ai', 'machine learning']);
    });

    it('should drop tags shorter than 2 characters', () => {
      expect(sanitizeTopics(['a', 'ai', '', 'x', 'ml'])).toEqual(['ai', 'ml']);
    });

    it('should drop tags longer than 60 characters', () => {
      const longTag = 'a'.repeat(61);
      expect(sanitizeTopics([longTag, 'ai'])).toEqual(['ai']);
    });

    it('should trim whitespace', () => {
      expect(sanitizeTopics(['  ai  ', ' ml ', 'ai'])).toEqual(['ai', 'ml']);
    });

    it('should cap at 15 topics', () => {
      const tags = Array.from({ length: 100 }, (_, i) => `topic-${i}`);
      const result = sanitizeTopics(tags);
      expect(result).toHaveLength(15);
      expect(result[0]).toBe('topic-0');
      expect(result[14]).toBe('topic-14');
    });

    it('should return empty array for empty input', () => {
      expect(sanitizeTopics([])).toEqual([]);
    });

    it('should handle Habr-style tag floods', () => {
      const habrTags = Array.from({ length: 500 }, (_, i) => `tag-${i}`);
      const result = sanitizeTopics(habrTags);
      expect(result).toHaveLength(15);
    });
  });

  describe('convertToNewsArticle', () => {
    const baseFetchedArticle: FetchedArticle = {
      id: 'article-123',
      title: 'Test Article Title',
      url: 'https://example.com/article',
      sourceId: 'test-source',
      publishedAt: new Date('2024-01-15T10:00:00Z'),
    };

    it('should convert basic article without summary', () => {
      const result = convertToNewsArticle(baseFetchedArticle);

      expect(result.id).toBe('article-123');
      expect(result.title).toBe('Test Article Title');
      expect(result.url).toBe('https://example.com/article');
      expect(result.source).toBe('test-source');
      expect(result.publishedAt).toEqual(new Date('2024-01-15T10:00:00Z'));
      expect(result.topics).toEqual([]);
      expect(result.hasBreakingPattern).toBe(false);
    });

    it('should convert article with summary', () => {
      const article: FetchedArticle = {
        ...baseFetchedArticle,
        summary: 'This is a test summary',
      };

      const result = convertToNewsArticle(article);

      expect(result.summary).toBe('This is a test summary');
    });

    it('should use tags from feed as topics', () => {
      const article: FetchedArticle = {
        ...baseFetchedArticle,
        tags: ['Technology', 'AI', 'Machine Learning'],
      };

      const result = convertToNewsArticle(article);

      expect(result.topics).toEqual(['technology', 'ai', 'machine learning']);
    });

    it('should detect breaking pattern in title', () => {
      const article: FetchedArticle = {
        ...baseFetchedArticle,
        title: 'Breaking: Major announcement',
      };

      const result = convertToNewsArticle(article);

      expect(result.hasBreakingPattern).toBe(true);
    });

    it('should detect breaking pattern in summary', () => {
      const article: FetchedArticle = {
        ...baseFetchedArticle,
        summary: 'Urgent update on the situation',
      };

      const result = convertToNewsArticle(article);

      expect(result.hasBreakingPattern).toBe(true);
    });

    it('should handle empty tags array', () => {
      const article: FetchedArticle = {
        ...baseFetchedArticle,
        tags: [],
      };

      const result = convertToNewsArticle(article);

      expect(result.topics).toEqual([]);
    });
  });
});
