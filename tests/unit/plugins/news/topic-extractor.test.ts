/**
 * Topic Extractor Tests
 *
 * Tests for topic extraction from article titles and summaries.
 */

import { describe, it, expect } from 'vitest';
import {
  extractTopics,
  extractArticleTopics,
  extractBatchTopics,
  formatTopic,
  formatTopicList,
} from '../../../../src/plugins/news/topic-extractor.js';

describe('Topic Extractor', () => {
  describe('extractTopics - AI/Tech', () => {
    it('should detect artificial_intelligence from "AI"', () => {
      const topics = extractTopics('OpenAI releases new AI model');
      expect(topics).toContain('artificial_intelligence');
    });

    it('should detect artificial_intelligence from "machine learning"', () => {
      const topics = extractTopics('New machine learning breakthrough');
      expect(topics).toContain('artificial_intelligence');
    });

    it('should detect artificial_intelligence from "ChatGPT"', () => {
      const topics = extractTopics('ChatGPT reaches 100 million users');
      expect(topics).toContain('artificial_intelligence');
    });

    it('should detect artificial_intelligence from "LLM"', () => {
      const topics = extractTopics('New LLM outperforms previous models');
      expect(topics).toContain('artificial_intelligence');
    });

    it('should detect tech from "software"', () => {
      const topics = extractTopics('Software industry trends for 2024');
      expect(topics).toContain('tech');
    });
  });

  describe('extractTopics - Cryptocurrency', () => {
    it('should detect cryptocurrency from "Bitcoin"', () => {
      const topics = extractTopics('Bitcoin price surges past $50,000');
      expect(topics).toContain('cryptocurrency');
    });

    it('should detect cryptocurrency from "crypto"', () => {
      const topics = extractTopics('Crypto market sees massive gains');
      expect(topics).toContain('cryptocurrency');
    });

    it('should detect cryptocurrency from "blockchain"', () => {
      const topics = extractTopics('Blockchain technology adoption grows');
      expect(topics).toContain('cryptocurrency');
    });

    it('should detect cryptocurrency from "ETH"', () => {
      const topics = extractTopics('ETH hits new all-time high');
      expect(topics).toContain('cryptocurrency');
    });
  });

  describe('extractTopics - Finance', () => {
    it('should detect finance from "stock market"', () => {
      const topics = extractTopics('Stock market closes at record high');
      expect(topics).toContain('finance');
    });

    it('should detect finance from "Federal Reserve"', () => {
      const topics = extractTopics('Federal Reserve announces rate decision');
      expect(topics).toContain('finance');
    });

    it('should detect finance from "inflation"', () => {
      const topics = extractTopics('Inflation data shows cooling trend');
      expect(topics).toContain('finance');
    });
  });

  describe('extractTopics - Science & Space', () => {
    it('should detect space from "NASA"', () => {
      const topics = extractTopics('NASA launches new Mars mission');
      expect(topics).toContain('space');
    });

    it('should detect space from "SpaceX"', () => {
      const topics = extractTopics('SpaceX Starship completes test flight');
      expect(topics).toContain('space');
    });

    it('should detect science from "research"', () => {
      const topics = extractTopics('New research shows promising results');
      expect(topics).toContain('science');
    });

    it('should detect climate from "global warming"', () => {
      const topics = extractTopics('Global warming accelerates ice melt');
      expect(topics).toContain('climate');
    });
  });

  describe('extractTopics - Entertainment', () => {
    it('should detect entertainment from "Netflix"', () => {
      const topics = extractTopics('Netflix announces new series');
      expect(topics).toContain('entertainment');
    });

    it('should detect gaming from "PlayStation"', () => {
      const topics = extractTopics('PlayStation 6 specs revealed');
      expect(topics).toContain('gaming');
    });

    it('should detect sports from "NBA"', () => {
      const topics = extractTopics('NBA finals set to begin');
      expect(topics).toContain('sports');
    });

    it('should detect celebrity from "Kardashian"', () => {
      const topics = extractTopics('Kardashian launches new brand');
      expect(topics).toContain('celebrity');
    });
  });

  describe('extractTopics - Politics & World', () => {
    it('should detect politics from "election"', () => {
      const topics = extractTopics('Election results spark debate');
      expect(topics).toContain('politics');
    });

    it('should detect world_news from "war"', () => {
      const topics = extractTopics('War escalates in the region');
      expect(topics).toContain('world_news');
    });
  });

  describe('extractTopics - multiple topics', () => {
    it('should detect multiple topics in one text', () => {
      const topics = extractTopics('AI startup raises $100M in Series A funding');
      expect(topics).toContain('artificial_intelligence');
      expect(topics).toContain('startups');
    });

    it('should detect crypto and finance together', () => {
      const topics = extractTopics('Bitcoin ETF approved by SEC, stock market reacts');
      expect(topics).toContain('cryptocurrency');
      expect(topics).toContain('finance');
    });
  });

  describe('extractTopics - edge cases', () => {
    it('should return empty array for empty text', () => {
      const topics = extractTopics('');
      expect(topics).toEqual([]);
    });

    it('should return empty array for generic text', () => {
      const topics = extractTopics('Hello world');
      expect(topics).toEqual([]);
    });

    it('should be case-insensitive', () => {
      const topics = extractTopics('BITCOIN SURGES, AI ADVANCES');
      expect(topics).toContain('cryptocurrency');
      expect(topics).toContain('artificial_intelligence');
    });

    it('should match whole words only (not substrings)', () => {
      // "ai" should not match inside "main" or "again"
      const topics = extractTopics('The main concern remains');
      expect(topics).not.toContain('artificial_intelligence');
    });
  });

  describe('extractArticleTopics', () => {
    it('should extract topics from title only', () => {
      const topics = extractArticleTopics('Bitcoin hits new high');
      expect(topics).toContain('cryptocurrency');
    });

    it('should extract topics from title and summary', () => {
      const topics = extractArticleTopics(
        'Tech industry update',
        'AI and machine learning continue to advance rapidly'
      );
      expect(topics).toContain('artificial_intelligence');
      expect(topics).toContain('tech');
    });

    it('should handle undefined summary', () => {
      const topics = extractArticleTopics('NASA launches probe', undefined);
      expect(topics).toContain('space');
    });
  });

  describe('extractBatchTopics', () => {
    it('should extract unique topics from multiple articles', () => {
      const articles = [
        { title: 'Bitcoin surges', summary: 'Crypto market rallies' },
        { title: 'NASA mission success', summary: 'SpaceX rocket lands' },
        { title: 'AI breakthrough', summary: 'New model released' },
      ];

      const topics = extractBatchTopics(articles);

      expect(topics).toContain('cryptocurrency');
      expect(topics).toContain('space');
      expect(topics).toContain('artificial_intelligence');
    });

    it('should return sorted unique topics', () => {
      const articles = [
        { title: 'Bitcoin news' },
        { title: 'More Bitcoin news' },
        { title: 'AI update' },
      ];

      const topics = extractBatchTopics(articles);

      // Should be sorted alphabetically
      expect(topics[0]!.localeCompare(topics[1]!) <= 0).toBe(true);
      // Should be deduplicated (cryptocurrency appears only once)
      expect(topics.filter((t) => t === 'cryptocurrency').length).toBe(1);
    });

    it('should handle empty batch', () => {
      const topics = extractBatchTopics([]);
      expect(topics).toEqual([]);
    });
  });

  describe('formatTopic', () => {
    it('should convert snake_case to Title Case', () => {
      expect(formatTopic('artificial_intelligence')).toBe('Artificial Intelligence');
    });

    it('should handle single word', () => {
      expect(formatTopic('tech')).toBe('Tech');
    });

    it('should handle multiple underscores', () => {
      expect(formatTopic('world_news')).toBe('World News');
    });
  });

  describe('formatTopicList', () => {
    it('should return "general news" for empty list', () => {
      expect(formatTopicList([])).toBe('general news');
    });

    it('should format single topic', () => {
      expect(formatTopicList(['tech'])).toBe('Tech');
    });

    it('should format two topics with "and"', () => {
      expect(formatTopicList(['tech', 'finance'])).toBe('Tech and Finance');
    });

    it('should format multiple topics with commas and "and"', () => {
      const result = formatTopicList(['tech', 'finance', 'science']);
      expect(result).toBe('Tech, Finance, and Science');
    });

    it('should format four topics correctly', () => {
      const result = formatTopicList(['tech', 'finance', 'science', 'health']);
      expect(result).toBe('Tech, Finance, Science, and Health');
    });
  });
});
