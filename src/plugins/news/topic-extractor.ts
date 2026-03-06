/**
 * Article Processing Utility
 *
 * Converts fetched articles to NewsArticle format.
 * Breaking pattern detection for urgency scoring.
 *
 * Note: Topic extraction removed - LLM handles understanding
 * article content and user interests naturally via memory search.
 */

import type { NewsArticle } from '../../types/news.js';
import type { FetchedArticle } from './types.js';

/**
 * Patterns that indicate urgent/breaking news.
 * Case-insensitive matching. Supports English and Russian.
 */
const BREAKING_PATTERNS = [
  // English
  'breaking',
  'urgent',
  'just in',
  'developing',
  'alert',
  'emergency',
  'crisis',
  'breaking news',
  'just announced',
  // Russian
  'срочно',
  'молния',
  'экстренно',
  'важно',
  'внимание',
  'чрезвычайное',
  'тревога',
  'только что',
];

/**
 * Check if text contains breaking/urgent patterns.
 */
export function hasBreakingPattern(text: string): boolean {
  if (!text) return false;

  const lowerText = text.toLowerCase();

  for (const pattern of BREAKING_PATTERNS) {
    if (lowerText.includes(pattern)) {
      return true;
    }
  }

  return false;
}

/** Max topics kept per article — prevents tag-flood feeds (e.g. Habr) from dominating scoring. */
const MAX_TOPICS = 15;

/** Minimum meaningful tag length. */
const MIN_TAG_LENGTH = 2;

/** Maximum tag length — longer strings are usually sentence fragments, not topics. */
const MAX_TAG_LENGTH = 60;

/**
 * Normalize, deduplicate, and cap feed tags.
 * Drops junk (empty, too short/long) and limits to MAX_TOPICS.
 */
export function sanitizeTopics(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (tag.length < MIN_TAG_LENGTH || tag.length > MAX_TAG_LENGTH) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
    if (result.length >= MAX_TOPICS) break;
  }

  return result;
}

/**
 * Convert a FetchedArticle to a NewsArticle for signal emission.
 * Uses tags from RSS/Atom feeds if available, otherwise empty.
 */
export function convertToNewsArticle(article: FetchedArticle): NewsArticle {
  const combinedText = article.summary ? `${article.title} ${article.summary}` : article.title;

  const topics = sanitizeTopics(article.tags ?? []);

  return {
    id: article.id,
    title: article.title,
    source: article.sourceId,
    topics,
    url: article.url,
    summary: article.summary,
    publishedAt: article.publishedAt,
    hasBreakingPattern: hasBreakingPattern(combinedText),
  };
}
