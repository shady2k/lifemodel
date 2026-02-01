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

/**
 * Convert a FetchedArticle to a NewsArticle for signal emission.
 * Uses tags from RSS/Atom feeds if available, otherwise empty.
 */
export function convertToNewsArticle(article: FetchedArticle): NewsArticle {
  const combinedText = article.summary ? `${article.title} ${article.summary}` : article.title;

  // Use tags from feed if available (normalized to lowercase)
  const topics = article.tags?.map((tag) => tag.toLowerCase()) ?? [];

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
