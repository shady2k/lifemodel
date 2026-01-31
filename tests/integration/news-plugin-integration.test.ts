/**
 * News Plugin Integration Tests
 *
 * Tests the full news plugin lifecycle:
 * 1. Plugin activation with scheduler setup
 * 2. Tool operations (add_source, list_sources, remove_source)
 * 3. Poll event triggering thought emission
 *
 * Uses mock HTTP responses for RSS/Telegram fetching.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  PluginPrimitives,
  StoragePrimitive,
  SchedulerPrimitive,
  IntentEmitterPrimitive,
  PluginServices,
} from '../../src/types/plugin.js';
import type { Logger } from '../../src/types/logger.js';
import newsPlugin, { NEWS_EVENT_KINDS, NEWS_PLUGIN_ID } from '../../src/plugins/news/index.js';
import { NEWS_STORAGE_KEYS } from '../../src/plugins/news/types.js';
import { clearRateLimitTracking } from '../../src/plugins/news/fetchers/telegram.js';

/**
 * Create a mock Response with streaming body support (for RSS fetcher).
 */
function createMockResponse(
  body: string,
  options: { ok?: boolean; status?: number; statusText?: string; headers?: Record<string, string> } = {}
): Response {
  const { ok = true, status = 200, statusText = 'OK', headers = {} } = options;
  const encoder = new TextEncoder();
  const data = encoder.encode(body);

  // Create a readable stream from the body
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });

  return {
    ok,
    status,
    statusText,
    headers: new Headers(headers),
    body: stream,
    text: async () => body,
  } as Response;
}

// Sample RSS feed response
const SAMPLE_RSS_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Tech News</title>
    <link>https://example.com</link>
    <description>Latest tech news</description>
    <item>
      <title>AI Breakthrough: New Model Released</title>
      <link>https://example.com/ai-news</link>
      <description>Major tech announcement about artificial intelligence developments.</description>
      <guid>article-123</guid>
      <pubDate>Sat, 01 Jan 2025 12:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Security Update for Popular Framework</title>
      <link>https://example.com/security</link>
      <description>Important security patch released for widely-used framework.</description>
      <guid>article-122</guid>
      <pubDate>Sat, 01 Jan 2025 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

// Create mock storage primitive
function createMockStorage(): StoragePrimitive & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();

  return {
    data,
    get: vi.fn(async <T>(key: string): Promise<T | null> => {
      const value = data.get(key);
      return value !== undefined ? (value as T) : null;
    }),
    set: vi.fn(async <T>(key: string, value: T): Promise<void> => {
      data.set(key, value);
    }),
    delete: vi.fn(async (key: string): Promise<boolean> => {
      return data.delete(key);
    }),
    keys: vi.fn(async (): Promise<string[]> => {
      return Array.from(data.keys());
    }),
    query: vi.fn(async <T>(prefix: string): Promise<Array<{ key: string; value: T }>> => {
      const results: Array<{ key: string; value: T }> = [];
      for (const [key, value] of data.entries()) {
        if (key.startsWith(prefix)) {
          results.push({ key, value: value as T });
        }
      }
      return results;
    }),
    clear: vi.fn(async (): Promise<void> => {
      data.clear();
    }),
  };
}

// Create mock scheduler primitive
function createMockScheduler(): SchedulerPrimitive & { schedules: Map<string, unknown> } {
  const schedules = new Map<string, unknown>();
  let scheduleIdCounter = 0;

  return {
    schedules,
    schedule: vi.fn(async (options: unknown): Promise<string> => {
      const id = `schedule_${++scheduleIdCounter}`;
      schedules.set(id, options);
      return id;
    }),
    cancel: vi.fn(async (id: string): Promise<boolean> => {
      return schedules.delete(id);
    }),
    list: vi.fn(async (): Promise<string[]> => {
      return Array.from(schedules.keys());
    }),
  };
}

// Create mock intent emitter primitive
function createMockIntentEmitter(): IntentEmitterPrimitive & {
  thoughts: string[];
  messages: Array<{ recipientId: string; text: string }>;
} {
  const thoughts: string[] = [];
  const messages: Array<{ recipientId: string; text: string }> = [];
  let signalIdCounter = 0;

  return {
    thoughts,
    messages,
    emitThought: vi.fn((content: string): { success: boolean; signalId?: string; error?: string } => {
      thoughts.push(content);
      return { success: true, signalId: `sig_${++signalIdCounter}` };
    }),
    emitSendMessage: vi.fn((recipientId: string, text: string): { success: boolean; error?: string } => {
      messages.push({ recipientId, text });
      return { success: true };
    }),
    emitSignal: vi.fn((): { success: boolean; signalId?: string; error?: string } => {
      return { success: true, signalId: `sig_${++signalIdCounter}` };
    }),
  };
}

// Create mock logger
function createMockLogger(): Logger & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {
    trace: [],
    debug: [],
    info: [],
    warn: [],
    error: [],
  };

  const logger = {
    trace: vi.fn((...args: unknown[]) => calls.trace.push(args)),
    debug: vi.fn((...args: unknown[]) => calls.debug.push(args)),
    info: vi.fn((...args: unknown[]) => calls.info.push(args)),
    warn: vi.fn((...args: unknown[]) => calls.warn.push(args)),
    error: vi.fn((...args: unknown[]) => calls.error.push(args)),
    child: () => logger,
    calls,
  };

  return logger as Logger & { calls: Record<string, unknown[][]> };
}

// Create mock plugin services
function createMockServices(): PluginServices {
  return {
    registerEventSchema: vi.fn(),
    getTimezone: vi.fn().mockReturnValue('UTC'),
  };
}

describe('News Plugin Integration', () => {
  let storage: ReturnType<typeof createMockStorage>;
  let scheduler: ReturnType<typeof createMockScheduler>;
  let intentEmitter: ReturnType<typeof createMockIntentEmitter>;
  let logger: ReturnType<typeof createMockLogger>;
  let services: ReturnType<typeof createMockServices>;
  let primitives: PluginPrimitives;

  beforeEach(() => {
    vi.useFakeTimers();
    clearRateLimitTracking();

    storage = createMockStorage();
    scheduler = createMockScheduler();
    intentEmitter = createMockIntentEmitter();
    logger = createMockLogger();
    services = createMockServices();

    primitives = {
      storage,
      scheduler,
      intentEmitter,
      logger: logger as Logger,
      services,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('Plugin Lifecycle', () => {
    it('should have valid manifest', () => {
      expect(newsPlugin.manifest).toBeDefined();
      expect(newsPlugin.manifest.manifestVersion).toBe(2);
      expect(newsPlugin.manifest.id).toBe(NEWS_PLUGIN_ID); // 'news'
      expect(newsPlugin.manifest.provides).toContainEqual({ type: 'tool', id: 'news' });
    });

    it('should declare poll schedule in manifest', () => {
      // Schedules are now declared in manifest, created by core (not plugin)
      const schedules = newsPlugin.manifest.schedules;
      expect(schedules).toBeDefined();
      expect(schedules?.length).toBe(1);
      expect(schedules?.[0].id).toBe('poll_feeds');
      expect(schedules?.[0].cron).toBe('0 */2 * * *'); // Every 2 hours
      expect(schedules?.[0].eventKind).toBe(NEWS_EVENT_KINDS.POLL_FEEDS);
    });

    it('should activate and register tool', async () => {
      await newsPlugin.lifecycle.activate(primitives);

      // Should register tool (schedules are managed by core now)
      expect(newsPlugin.tools.length).toBe(1);
      expect(newsPlugin.tools[0].name).toBe('news');

      // Cleanup
      await newsPlugin.lifecycle.deactivate?.();
    });

    it('should deactivate and cleanup tools', async () => {
      await newsPlugin.lifecycle.activate(primitives);
      await newsPlugin.lifecycle.deactivate?.();

      // Manifest schedules are cancelled by core, not plugin
      expect(newsPlugin.tools.length).toBe(0);
    });

    it('should pass health check when activated', async () => {
      await newsPlugin.lifecycle.activate(primitives);

      const health = await newsPlugin.lifecycle.healthCheck?.();
      expect(health?.healthy).toBe(true);

      await newsPlugin.lifecycle.deactivate?.();
    });
  });

  describe('Tool Operations', () => {
    beforeEach(async () => {
      await newsPlugin.lifecycle.activate(primitives);
    });

    afterEach(async () => {
      await newsPlugin.lifecycle.deactivate?.();
    });

    it('should add an RSS source', async () => {
      const tool = newsPlugin.tools[0];
      const result = await tool.execute({
        action: 'add_source',
        type: 'rss',
        url: 'https://example.com/feed.xml',
        name: 'Test Feed',
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('add_source');
      expect(result.sourceId).toBeDefined();

      // Verify storage (plugin uses namespaced key internally)
      const sources = await storage.get(NEWS_STORAGE_KEYS.SOURCES);
      expect(sources).toHaveLength(1);
    });

    it('should add a Telegram source', async () => {
      const tool = newsPlugin.tools[0];
      const result = await tool.execute({
        action: 'add_source',
        type: 'telegram',
        url: '@testchannel',
        name: 'Test Channel',
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('add_source');
    });

    it('should reject duplicate sources', async () => {
      const tool = newsPlugin.tools[0];

      // Add first source
      await tool.execute({
        action: 'add_source',
        type: 'rss',
        url: 'https://example.com/feed.xml',
        name: 'Test Feed',
      });

      // Try to add duplicate
      const result = await tool.execute({
        action: 'add_source',
        type: 'rss',
        url: 'https://example.com/feed.xml',
        name: 'Duplicate Feed',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('should list sources', async () => {
      const tool = newsPlugin.tools[0];

      // Add some sources
      await tool.execute({
        action: 'add_source',
        type: 'rss',
        url: 'https://example.com/feed1.xml',
        name: 'Feed One',
      });
      await tool.execute({
        action: 'add_source',
        type: 'telegram',
        url: '@channel1',
        name: 'Channel One',
      });

      // List sources
      const result = await tool.execute({ action: 'list_sources' });

      expect(result.success).toBe(true);
      expect(result.sources).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('should remove a source', async () => {
      const tool = newsPlugin.tools[0];

      // Add source
      const addResult = await tool.execute({
        action: 'add_source',
        type: 'rss',
        url: 'https://example.com/feed.xml',
        name: 'Test Feed',
      });

      // Remove it
      const removeResult = await tool.execute({
        action: 'remove_source',
        sourceId: addResult.sourceId,
      });

      expect(removeResult.success).toBe(true);

      // Verify it's gone
      const listResult = await tool.execute({ action: 'list_sources' });
      expect(listResult.sources).toHaveLength(0);
    });

    it('should validate RSS URLs', async () => {
      const tool = newsPlugin.tools[0];

      const result = await tool.execute({
        action: 'add_source',
        type: 'rss',
        url: 'not-a-valid-url',
        name: 'Bad Feed',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should validate Telegram handles', async () => {
      const tool = newsPlugin.tools[0];

      const result = await tool.execute({
        action: 'add_source',
        type: 'telegram',
        url: 'invalid handle with spaces',
        name: 'Bad Channel',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('Poll Event and Thought Emission', () => {
    beforeEach(async () => {
      await newsPlugin.lifecycle.activate(primitives);
    });

    afterEach(async () => {
      await newsPlugin.lifecycle.deactivate?.();
    });

    it('should emit thought when new articles are found', async () => {
      // Mock fetch to return RSS feed with proper streaming response
      const mockFetch = vi.fn().mockResolvedValue(
        createMockResponse(SAMPLE_RSS_FEED, {
          headers: { 'content-type': 'application/rss+xml' },
        })
      );
      vi.stubGlobal('fetch', mockFetch);

      // Add an RSS source
      const tool = newsPlugin.tools[0];
      await tool.execute({
        action: 'add_source',
        type: 'rss',
        url: 'https://example.com/feed.xml',
        name: 'Tech News',
      });

      // Trigger poll event
      await newsPlugin.lifecycle.onEvent?.(NEWS_EVENT_KINDS.POLL_FEEDS, {});

      // Should have emitted thoughts about new articles (fetch-on-add)
      expect(intentEmitter.emitThought).toHaveBeenCalled();
      expect(intentEmitter.thoughts.length).toBeGreaterThan(0);

      // Check thought content includes article info (fetch-on-add format)
      const thought = intentEmitter.thoughts[0];
      expect(thought).toContain('added');
      expect(thought).toContain('Tech News');
      expect(thought).toContain('article');
    });

    it('should not emit thoughts when no new articles', async () => {
      // Mock fetch to return RSS feed with proper streaming response
      const mockFetch = vi.fn().mockResolvedValue(
        createMockResponse(SAMPLE_RSS_FEED, {
          headers: { 'content-type': 'application/rss+xml' },
        })
      );
      vi.stubGlobal('fetch', mockFetch);

      // Add an RSS source
      const tool = newsPlugin.tools[0];
      await tool.execute({
        action: 'add_source',
        type: 'rss',
        url: 'https://example.com/feed.xml',
        name: 'Tech News',
      });

      // First poll - gets articles
      await newsPlugin.lifecycle.onEvent?.(NEWS_EVENT_KINDS.POLL_FEEDS, {});
      const thoughtsAfterFirstPoll = intentEmitter.thoughts.length;

      // Second poll - same articles, no new thoughts (deduplication)
      await newsPlugin.lifecycle.onEvent?.(NEWS_EVENT_KINDS.POLL_FEEDS, {});

      // Should not have emitted additional thoughts for same articles
      expect(intentEmitter.thoughts.length).toBe(thoughtsAfterFirstPoll);
    });

    it('should handle fetch failures gracefully', async () => {
      // Mock fetch to fail
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
      vi.stubGlobal('fetch', mockFetch);

      // Add an RSS source
      const tool = newsPlugin.tools[0];
      await tool.execute({
        action: 'add_source',
        type: 'rss',
        url: 'https://example.com/feed.xml',
        name: 'Failing Feed',
      });

      // Poll should not throw
      await expect(
        newsPlugin.lifecycle.onEvent?.(NEWS_EVENT_KINDS.POLL_FEEDS, {})
      ).resolves.not.toThrow();

      // Should log error
      expect(logger.calls.warn.length + logger.calls.error.length).toBeGreaterThan(0);
    });

    it('should log warning about failing sources after consecutive failures', async () => {
      // Mock fetch to fail with proper Response structure
      const mockFetch = vi.fn().mockResolvedValue(
        createMockResponse('', { ok: false, status: 500, statusText: 'Internal Server Error' })
      );
      vi.stubGlobal('fetch', mockFetch);

      // Add an RSS source
      const tool = newsPlugin.tools[0];
      await tool.execute({
        action: 'add_source',
        type: 'rss',
        url: 'https://example.com/feed.xml',
        name: 'Failing Feed',
      });

      // Poll multiple times to trigger failure threshold (3 consecutive failures)
      await newsPlugin.lifecycle.onEvent?.(NEWS_EVENT_KINDS.POLL_FEEDS, {});
      await newsPlugin.lifecycle.onEvent?.(NEWS_EVENT_KINDS.POLL_FEEDS, {});
      await newsPlugin.lifecycle.onEvent?.(NEWS_EVENT_KINDS.POLL_FEEDS, {});

      // In v2 architecture, failed sources are logged (source health monitoring)
      // instead of emitting thoughts. Verify warnings were logged.
      expect(logger.calls.warn.length).toBeGreaterThan(0);
    });
  });

  describe('Topic Extraction in Thoughts', () => {
    beforeEach(async () => {
      await newsPlugin.lifecycle.activate(primitives);
    });

    afterEach(async () => {
      await newsPlugin.lifecycle.deactivate?.();
    });

    it('should include topic categories in thoughts', async () => {
      // Mock fetch to return RSS feed with AI-related content
      const mockFetch = vi.fn().mockResolvedValue(
        createMockResponse(SAMPLE_RSS_FEED, {
          headers: { 'content-type': 'application/rss+xml' },
        })
      );
      vi.stubGlobal('fetch', mockFetch);

      // Add source
      const tool = newsPlugin.tools[0];
      await tool.execute({
        action: 'add_source',
        type: 'rss',
        url: 'https://example.com/feed.xml',
        name: 'Tech News',
      });

      // Poll
      await newsPlugin.lifecycle.onEvent?.(NEWS_EVENT_KINDS.POLL_FEEDS, {});

      // Check thought includes topic context
      const thought = intentEmitter.thoughts[0];
      expect(thought).toContain('covering'); // "covering [topics]"
    });

    it('should include self-learning guidance in thoughts', async () => {
      // Mock fetch with proper streaming response
      const mockFetch = vi.fn().mockResolvedValue(
        createMockResponse(SAMPLE_RSS_FEED, {
          headers: { 'content-type': 'application/rss+xml' },
        })
      );
      vi.stubGlobal('fetch', mockFetch);

      // Add source and poll
      const tool = newsPlugin.tools[0];
      await tool.execute({
        action: 'add_source',
        type: 'rss',
        url: 'https://example.com/feed.xml',
        name: 'Tech News',
      });
      await newsPlugin.lifecycle.onEvent?.(NEWS_EVENT_KINDS.POLL_FEEDS, {});

      // Check thought includes COGNITION guidance
      const thought = intentEmitter.thoughts[0];
      expect(thought).toContain('core.memory'); // Guidance to use memory tool
      expect(thought).toContain('USE YOUR JUDGMENT'); // Let COGNITION decide what's interesting
    });
  });
});
