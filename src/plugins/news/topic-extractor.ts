/**
 * Topic Extraction Utility
 *
 * Extracts potential topics from article titles and summaries
 * to help COGNITION categorize and match against user preferences.
 *
 * Uses simple keyword matching - no ML required.
 * Topics align with common user interest categories.
 */

import type { NewsArticle } from '../../types/news.js';
import type { FetchedArticle } from './types.js';

/**
 * Topic definition with keywords that trigger it.
 */
interface TopicPattern {
  topic: string;
  keywords: string[];
  /** Require word boundary match (default: true) */
  wordBoundary?: boolean;
}

/**
 * Common topic patterns for news categorization.
 * Order matters - more specific patterns should come first.
 */
const TOPIC_PATTERNS: TopicPattern[] = [
  // Technology subcategories (check before general "tech")
  {
    topic: 'artificial_intelligence',
    keywords: [
      'ai',
      'artificial intelligence',
      'machine learning',
      'deep learning',
      'neural network',
      'chatgpt',
      'gpt-4',
      'gpt-5',
      'claude',
      'llm',
      'large language model',
      'openai',
      'anthropic',
      'deepmind',
      'midjourney',
      'stable diffusion',
      'generative ai',
    ],
  },
  {
    topic: 'cryptocurrency',
    keywords: [
      'bitcoin',
      'btc',
      'ethereum',
      'eth',
      'crypto',
      'cryptocurrency',
      'blockchain',
      'defi',
      'nft',
      'web3',
      'binance',
      'coinbase',
      'solana',
      'dogecoin',
    ],
  },
  {
    topic: 'cybersecurity',
    keywords: [
      'hack',
      'breach',
      'vulnerability',
      'ransomware',
      'malware',
      'phishing',
      'cybersecurity',
      'cyber attack',
      'data leak',
      'zero-day',
    ],
  },
  {
    topic: 'startups',
    keywords: [
      'startup',
      'series a',
      'series b',
      'seed funding',
      'vc',
      'venture capital',
      'unicorn',
      'ipo',
      'acquisition',
      'y combinator',
      'techcrunch',
    ],
  },
  {
    topic: 'tech',
    keywords: [
      'technology',
      'software',
      'hardware',
      'app',
      'programming',
      'developer',
      'code',
      'silicon valley',
      'tech industry',
    ],
  },

  // Finance
  {
    topic: 'finance',
    keywords: [
      'stock',
      'market',
      'nasdaq',
      'dow',
      's&p',
      'fed',
      'federal reserve',
      'interest rate',
      'inflation',
      'recession',
      'gdp',
      'earnings',
      'investor',
      'wall street',
    ],
  },

  // Science
  {
    topic: 'space',
    keywords: [
      'nasa',
      'spacex',
      'rocket',
      'satellite',
      'mars',
      'moon',
      'astronaut',
      'orbit',
      'telescope',
      'james webb',
    ],
  },
  {
    topic: 'science',
    keywords: [
      'research',
      'study',
      'scientist',
      'discovery',
      'experiment',
      'laboratory',
      'physics',
      'chemistry',
      'biology',
    ],
  },
  {
    topic: 'climate',
    keywords: [
      'climate',
      'global warming',
      'carbon',
      'emissions',
      'renewable',
      'solar',
      'wind power',
      'ev',
      'electric vehicle',
      'sustainability',
    ],
  },

  // Business
  {
    topic: 'business',
    keywords: [
      'company',
      'corporation',
      'ceo',
      'revenue',
      'profit',
      'layoff',
      'hiring',
      'merger',
      'deal',
    ],
  },

  // Politics & World
  {
    topic: 'politics',
    keywords: [
      'election',
      'vote',
      'congress',
      'senate',
      'president',
      'government',
      'policy',
      'legislation',
      'democrat',
      'republican',
    ],
  },
  {
    topic: 'world_news',
    keywords: [
      'war',
      'conflict',
      'treaty',
      'diplomat',
      'united nations',
      'sanctions',
      'international',
    ],
  },

  // Entertainment & Culture
  {
    topic: 'entertainment',
    keywords: [
      'movie',
      'film',
      'netflix',
      'streaming',
      'tv show',
      'series',
      'actor',
      'actress',
      'director',
      'box office',
    ],
  },
  {
    topic: 'gaming',
    keywords: [
      'game',
      'gaming',
      'playstation',
      'xbox',
      'nintendo',
      'steam',
      'esports',
      'twitch',
      'video game',
    ],
  },
  {
    topic: 'sports',
    keywords: [
      'football',
      'basketball',
      'soccer',
      'nfl',
      'nba',
      'mlb',
      'olympics',
      'championship',
      'tournament',
      'world cup',
    ],
  },
  {
    topic: 'celebrity',
    keywords: [
      'celebrity',
      'kardashian',
      'royal family',
      'prince',
      'princess',
      'hollywood',
      'gossip',
      'scandal',
    ],
  },

  // Health
  {
    topic: 'health',
    keywords: [
      'health',
      'medical',
      'doctor',
      'hospital',
      'disease',
      'treatment',
      'vaccine',
      'fda',
      'drug',
      'pharmaceutical',
    ],
  },
];

/**
 * Extract topics from text content.
 *
 * @param text - Article title and/or summary
 * @returns Array of detected topic strings (deduplicated)
 */
export function extractTopics(text: string): string[] {
  if (!text) return [];

  const lowerText = text.toLowerCase();
  const detectedTopics = new Set<string>();

  for (const pattern of TOPIC_PATTERNS) {
    for (const keyword of pattern.keywords) {
      // Default to word boundary matching
      const useWordBoundary = pattern.wordBoundary !== false;

      let found = false;
      if (useWordBoundary) {
        // Match as whole word (with word boundaries)
        const regex = new RegExp(`\\b${escapeRegex(keyword)}\\b`, 'i');
        found = regex.test(lowerText);
      } else {
        // Simple substring match
        found = lowerText.includes(keyword);
      }

      if (found) {
        detectedTopics.add(pattern.topic);
        break; // Found this topic, move to next pattern
      }
    }
  }

  return Array.from(detectedTopics);
}

/**
 * Extract topics from an article (combines title and summary).
 */
export function extractArticleTopics(title: string, summary?: string): string[] {
  const combined = summary ? `${title} ${summary}` : title;
  return extractTopics(combined);
}

/**
 * Get all unique topics from a batch of articles.
 */
export function extractBatchTopics(
  articles: { title: string; summary?: string | undefined }[]
): string[] {
  const allTopics = new Set<string>();

  for (const article of articles) {
    const topics = extractArticleTopics(article.title, article.summary);
    for (const topic of topics) {
      allTopics.add(topic);
    }
  }

  return Array.from(allTopics).sort();
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Format topics for display (converts snake_case to Title Case).
 */
export function formatTopic(topic: string): string {
  return topic
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Format multiple topics as a readable list.
 */
export function formatTopicList(topics: string[]): string {
  if (topics.length === 0) return 'general news';

  const first = topics[0];
  if (topics.length === 1 && first) return formatTopic(first);

  const second = topics[1];
  if (topics.length === 2 && first && second) {
    return `${formatTopic(first)} and ${formatTopic(second)}`;
  }

  const formatted = topics.map(formatTopic);
  const last = formatted.pop() ?? '';
  return `${formatted.join(', ')}, and ${last}`;
}

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
 * Enriches with topic extraction and breaking pattern detection.
 */
export function convertToNewsArticle(article: FetchedArticle): NewsArticle {
  const combinedText = article.summary ? `${article.title} ${article.summary}` : article.title;

  return {
    id: article.id,
    title: article.title,
    source: article.sourceId,
    topics: extractArticleTopics(article.title, article.summary),
    url: article.url,
    summary: article.summary,
    publishedAt: article.publishedAt,
    hasBreakingPattern: hasBreakingPattern(combinedText),
  };
}
