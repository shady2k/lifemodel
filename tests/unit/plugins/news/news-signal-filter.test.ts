/**
 * NewsSignalFilter Tests
 *
 * Tests for Telegram digest consolidation and article batch classification.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NewsSignalFilter } from '../../../../src/plugins/news/news-signal-filter.js';
import { createSignal } from '../../../../src/types/signal.js';
import type { PluginEventData } from '../../../../src/types/signal.js';
import type { NewsArticle } from '../../../../src/types/news.js';
import type { FilterContext } from '../../../../src/layers/autonomic/filter-registry.js';
import { NEWS_PLUGIN_ID, NEWS_EVENT_KINDS } from '../../../../src/plugins/news/types.js';

// ============================================================
// Helpers
// ============================================================

function makeLogger() {
  const noop = vi.fn().mockReturnThis();
  return {
    info: noop,
    debug: noop,
    warn: noop,
    error: noop,
    trace: noop,
    child: vi.fn().mockReturnThis(),
    level: 'silent',
  } as any;
}

function makeContext(overrides: Partial<FilterContext> = {}): FilterContext {
  return {
    state: 'awake',
    alertness: 0.5,
    correlationId: 'test-corr',
    userModel: null,
    primaryRecipientId: 'user-1',
    ...overrides,
  } as FilterContext;
}

function makeArticle(overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Test message',
    source: 'telegram:test',
    topics: [],
    hasBreakingPattern: false,
    ...overrides,
  };
}

function makeBatchSignal(
  articles: NewsArticle[],
  sourceId: string,
  options: {
    sourceType?: 'rss' | 'telegram' | 'telegram-group';
    fetchedAt?: Date;
  } = {}
) {
  const fetchedAt = options.fetchedAt ?? new Date('2026-02-20T12:00:00Z');
  const data: PluginEventData = {
    kind: 'plugin_event',
    eventKind: NEWS_EVENT_KINDS.ARTICLE_BATCH,
    pluginId: NEWS_PLUGIN_ID,
    payload: {
      articles,
      sourceId,
      fetchedAt,
      ...(options.sourceType && { sourceType: options.sourceType }),
    },
  };

  return createSignal('plugin_event', `plugin.${NEWS_PLUGIN_ID}`, { value: articles.length }, {
    priority: 2,
    data,
  });
}

// ============================================================
// Tests
// ============================================================

describe('NewsSignalFilter', () => {
  let filter: NewsSignalFilter;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    logger = makeLogger();
    filter = new NewsSignalFilter(logger);
  });

  describe('RSS batch (unchanged per-article behavior)', () => {
    it('should process RSS articles individually', () => {
      const articles = [
        makeArticle({ title: 'Article 1', topics: ['tech'], source: 'rss:test' }),
        makeArticle({ title: 'Article 2', topics: ['tech'], source: 'rss:test' }),
      ];
      const signal = makeBatchSignal(articles, 'rss:test', { sourceType: 'rss' });
      const context = makeContext();

      const result = filter.process([signal], context);

      // With no interests, curious baseline should pass articles as interesting
      const interestingSignals = result.filter((s) => {
        const d = s.data as PluginEventData;
        return d.eventKind === 'news:interesting';
      });

      // Each article scored individually → still 2 articles in the batch
      expect(interestingSignals.length).toBeGreaterThanOrEqual(1);
      const facts = (interestingSignals[0]?.data as any)?.facts;
      expect(facts).toHaveLength(2);
    });
  });

  describe('backward compatibility (no sourceType)', () => {
    it('should process per-article when sourceType is missing', () => {
      const articles = [
        makeArticle({ title: 'Legacy article 1', topics: ['news'] }),
        makeArticle({ title: 'Legacy article 2', topics: ['news'] }),
      ];
      // No sourceType passed
      const signal = makeBatchSignal(articles, 'legacy:source');
      const context = makeContext();

      const result = filter.process([signal], context);

      // Should behave like RSS (per-article)
      const interestingSignals = result.filter((s) => {
        const d = s.data as PluginEventData;
        return d.eventKind === 'news:interesting';
      });
      expect(interestingSignals.length).toBeGreaterThanOrEqual(1);
      const facts = (interestingSignals[0]?.data as any)?.facts;
      expect(facts).toHaveLength(2);
    });
  });

  describe('Telegram digest consolidation', () => {
    it('should consolidate Telegram messages into digest chunks', () => {
      const baseTime = new Date('2026-02-20T10:00:00Z');
      const articles = Array.from({ length: 10 }, (_, i) =>
        makeArticle({
          title: `[User${String(i)}] Message about topic ${String(i)} with enough content`,
          summary: `This is a detailed message number ${String(i)} discussing various things in the group chat`,
          source: 'tg:group-1',
          publishedAt: new Date(baseTime.getTime() + i * 60_000), // 1 min apart
        })
      );

      const signal = makeBatchSignal(articles, 'tg:group-1', { sourceType: 'telegram-group' });
      const context = makeContext();

      const result = filter.process([signal], context);

      // Should produce digests, not 10 individual facts
      const interestingSignals = result.filter((s) => {
        const d = s.data as PluginEventData;
        return d.eventKind === 'news:interesting';
      });
      expect(interestingSignals.length).toBeGreaterThanOrEqual(1);
      const facts = (interestingSignals[0]?.data as any)?.facts;

      // 10 messages within 10 min → should be consolidated into 1 digest
      expect(facts.length).toBeLessThan(10);
      expect(facts.length).toBe(1);

      // Digest fact content should contain multiple messages
      const content = facts[0].content as string;
      expect(content).toContain('msgs)');
      expect(content).toContain('Message about topic');
    });

    it('should split on time gaps > 15 minutes', () => {
      const articles = [
        // Session 1: messages at 10:00, 10:05, 10:10
        makeArticle({
          title: '[Alice] First session message one with enough text to pass quality',
          summary: 'Additional content for the first message in session one',
          source: 'tg:group',
          publishedAt: new Date('2026-02-20T10:00:00Z'),
        }),
        makeArticle({
          title: '[Bob] First session message two with sufficient content',
          summary: 'More content for the second message in session one',
          source: 'tg:group',
          publishedAt: new Date('2026-02-20T10:05:00Z'),
        }),
        makeArticle({
          title: '[Carol] First session message three with long text here',
          summary: 'Even more content for the third message in session one',
          source: 'tg:group',
          publishedAt: new Date('2026-02-20T10:10:00Z'),
        }),
        // Session 2: messages at 10:30, 10:35 (20 min gap from session 1)
        makeArticle({
          title: '[Dave] Second session starts here with a new topic discussion',
          summary: 'This is a detailed message starting a new conversation thread',
          source: 'tg:group',
          publishedAt: new Date('2026-02-20T10:30:00Z'),
        }),
        makeArticle({
          title: '[Eve] Second session continues with more information shared',
          summary: 'Following up with additional details about the new topic',
          source: 'tg:group',
          publishedAt: new Date('2026-02-20T10:35:00Z'),
        }),
      ];

      const signal = makeBatchSignal(articles, 'tg:group', { sourceType: 'telegram' });
      const context = makeContext();

      const result = filter.process([signal], context);

      const interestingSignals = result.filter((s) => {
        const d = s.data as PluginEventData;
        return d.eventKind === 'news:interesting';
      });
      expect(interestingSignals.length).toBeGreaterThanOrEqual(1);

      const facts = (interestingSignals[0]?.data as any)?.facts;
      // 2 time sessions → 2 digest chunks
      expect(facts).toHaveLength(2);
    });

    it('should split when message count exceeds 25', () => {
      const baseTime = new Date('2026-02-20T10:00:00Z');
      // 30 messages, all 1 minute apart (no time gap)
      const articles = Array.from({ length: 30 }, (_, i) =>
        makeArticle({
          title: `[User] Message ${String(i)} with detailed content for the group discussion`,
          source: 'tg:group',
          publishedAt: new Date(baseTime.getTime() + i * 60_000),
        })
      );

      const signal = makeBatchSignal(articles, 'tg:group', { sourceType: 'telegram-group' });
      const context = makeContext();

      const result = filter.process([signal], context);

      const interestingSignals = result.filter((s) => {
        const d = s.data as PluginEventData;
        return d.eventKind === 'news:interesting';
      });
      expect(interestingSignals.length).toBeGreaterThanOrEqual(1);

      const facts = (interestingSignals[0]?.data as any)?.facts;
      // 30 messages → split at 25 → 2 chunks
      expect(facts).toHaveLength(2);
    });

    it('should drop chunks below minimum content threshold', () => {
      const articles = [
        // Very short messages — should be dropped
        makeArticle({
          title: '+1',
          source: 'tg:group',
          publishedAt: new Date('2026-02-20T10:00:00Z'),
        }),
        makeArticle({
          title: 'ok',
          source: 'tg:group',
          publishedAt: new Date('2026-02-20T10:01:00Z'),
        }),
        makeArticle({
          title: '👍',
          source: 'tg:group',
          publishedAt: new Date('2026-02-20T10:02:00Z'),
        }),
      ];

      const signal = makeBatchSignal(articles, 'tg:group', { sourceType: 'telegram-group' });
      const context = makeContext();

      const result = filter.process([signal], context);

      // All messages too short → chunk dropped → no output signals
      // (or only filtered topic signals)
      const interestingSignals = result.filter((s) => {
        const d = s.data as PluginEventData;
        return d.eventKind === 'news:interesting';
      });
      expect(interestingSignals).toHaveLength(0);
    });

    it('should propagate hasBreakingPattern from any message in chunk', () => {
      const articles = [
        makeArticle({
          title: '[Admin] Normal message with enough content to pass quality threshold test',
          summary: 'Additional content for this normal message with some more text',
          source: 'tg:group',
          publishedAt: new Date('2026-02-20T10:00:00Z'),
          hasBreakingPattern: false,
        }),
        makeArticle({
          title: '[Admin] BREAKING: urgent update about critical infrastructure',
          summary: 'This is a breaking news message with critical information',
          source: 'tg:group',
          publishedAt: new Date('2026-02-20T10:01:00Z'),
          hasBreakingPattern: true,
        }),
        makeArticle({
          title: '[User] Follow-up discussion about the urgent news with more detail',
          summary: 'Continuing the conversation about the breaking update',
          source: 'tg:group',
          publishedAt: new Date('2026-02-20T10:02:00Z'),
          hasBreakingPattern: false,
        }),
      ];

      const signal = makeBatchSignal(articles, 'tg:group', { sourceType: 'telegram' });
      const context = makeContext();

      const result = filter.process([signal], context);

      // The consolidated digest should have hasBreakingPattern = true
      // Check all output facts
      for (const sig of result) {
        const d = sig.data as any;
        if (d.facts) {
          for (const fact of d.facts) {
            if (fact.provenance?.hasBreakingPattern !== undefined) {
              expect(fact.provenance.hasBreakingPattern).toBe(true);
            }
          }
        }
      }
    });

    it('should union topics from all messages in chunk', () => {
      const articles = [
        makeArticle({
          title: '[User1] Discussing cryptocurrency market trends today in great detail',
          summary: 'Extended discussion about crypto market movements and analysis',
          source: 'tg:group',
          topics: ['crypto', 'bitcoin'],
          publishedAt: new Date('2026-02-20T10:00:00Z'),
        }),
        makeArticle({
          title: '[User2] The stock market is also looking quite interesting right now',
          summary: 'Analysis of stock market performance alongside cryptocurrency',
          source: 'tg:group',
          topics: ['stocks', 'bitcoin'],
          publishedAt: new Date('2026-02-20T10:01:00Z'),
        }),
      ];

      const signal = makeBatchSignal(articles, 'tg:group', { sourceType: 'telegram-group' });
      const context = makeContext();

      const result = filter.process([signal], context);

      const interestingSignals = result.filter((s) => {
        const d = s.data as PluginEventData;
        return d.eventKind === 'news:interesting';
      });

      if (interestingSignals.length > 0) {
        const facts = (interestingSignals[0]?.data as any)?.facts;
        expect(facts).toHaveLength(1);
        const tags: string[] = facts[0].tags;
        // Should contain union of topics (lowercase, deduped)
        expect(tags).toContain('crypto');
        expect(tags).toContain('bitcoin');
        expect(tags).toContain('stocks');
      }
    });

    it('should score digests with empty topics through curious baseline', () => {
      // No interests configured (cold start) + no topics on articles
      const articles = Array.from({ length: 5 }, (_, i) =>
        makeArticle({
          title: `[User${String(i)}] A sufficiently long message about various things happening today`,
          summary: `More detail in this follow-up message number ${String(i)} for the group`,
          source: 'tg:group',
          topics: [], // No topics
          publishedAt: new Date(new Date('2026-02-20T10:00:00Z').getTime() + i * 60_000),
        })
      );

      const signal = makeBatchSignal(articles, 'tg:group', { sourceType: 'telegram-group' });
      // No user model → curious baseline scoring
      const context = makeContext({ userModel: null });

      const result = filter.process([signal], context);

      // Should still pass through curious baseline (interest ≥ 0.4)
      const interestingSignals = result.filter((s) => {
        const d = s.data as PluginEventData;
        return d.eventKind === 'news:interesting';
      });
      expect(interestingSignals.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle telegram channel type the same as telegram-group', () => {
      const articles = Array.from({ length: 5 }, (_, i) =>
        makeArticle({
          title: `Channel post ${String(i)} with enough content to pass the quality threshold`,
          summary: `Detailed channel post content for message number ${String(i)}`,
          source: 'telegram:@channel',
          publishedAt: new Date(new Date('2026-02-20T10:00:00Z').getTime() + i * 60_000),
        })
      );

      const signal = makeBatchSignal(articles, 'telegram:@channel', { sourceType: 'telegram' });
      const context = makeContext();

      const result = filter.process([signal], context);

      const interestingSignals = result.filter((s) => {
        const d = s.data as PluginEventData;
        return d.eventKind === 'news:interesting';
      });
      expect(interestingSignals.length).toBeGreaterThanOrEqual(1);
      const facts = (interestingSignals[0]?.data as any)?.facts;
      // 5 messages within 5 min → 1 digest
      expect(facts).toHaveLength(1);
    });
  });
});
