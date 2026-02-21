/**
 * Tests for telegram-group.ts fetcher
 *
 * Validates the fetchTelegramGroup function with mocked ScriptRunnerPrimitive.
 * Tests success, auth failure, and timeout cases.
 */

import { describe, it, expect, vi } from 'vitest';
import { fetchTelegramGroup } from '../../../../../src/plugins/news/fetchers/telegram-group.js';
import type { ScriptRunnerPrimitive, PluginScriptRunResult } from '../../../../../src/types/plugin.js';

function createMockRunner(result: PluginScriptRunResult): ScriptRunnerPrimitive {
  return {
    runScript: vi.fn().mockResolvedValue(result),
  };
}

function createThrowingRunner(error: Error): ScriptRunnerPrimitive {
  return {
    runScript: vi.fn().mockRejectedValue(error),
  };
}

describe('fetchTelegramGroup', () => {
  const profile = 'telegram';
  const groupUrl = 'https://web.telegram.org/a/#-1001234567890';
  const sourceId = 'src_test';
  const sourceName = 'Test Group';

  describe('successful fetch', () => {
    it('should return articles from script output', async () => {
      const runner = createMockRunner({
        ok: true,
        runId: 'run-1',
        output: {
          ok: true,
          messages: [
            { id: '100', text: 'Hello world', date: '2024-01-15T10:00:00Z', from: 'Alice' },
            { id: '101', text: 'Second message', date: '2024-01-15T10:05:00Z', from: 'Bob' },
          ],
          latestId: '101',
        },
        stats: { durationMs: 5000, exitCode: 0 },
      });

      const result = await fetchTelegramGroup(profile, groupUrl, sourceId, sourceName, undefined, runner);

      expect(result.success).toBe(true);
      expect(result.articles).toHaveLength(2);
      expect(result.articles[0].title).toContain('Alice');
      expect(result.articles[0].title).toContain('Hello world');
      expect(result.articles[0].id).toContain('tg_group_');
      expect(result.articles[0].sourceId).toBe(sourceId);
      expect(result.articles[0].sourceName).toBe(sourceName);
      expect(result.latestId).toBe('101');
    });

    it('should pass inputs to script runner', async () => {
      const runner = createMockRunner({
        ok: true,
        runId: 'run-2',
        output: { ok: true, messages: [], latestId: null },
        stats: { durationMs: 100, exitCode: 0 },
      });

      await fetchTelegramGroup(profile, groupUrl, sourceId, sourceName, 'last-99', runner);

      expect(runner.runScript).toHaveBeenCalledWith({
        scriptId: 'news.telegram_group.fetch',
        inputs: {
          profile: 'telegram',
          groupUrl,
          lastSeenId: 'last-99',
          maxMessages: 500,
        },
        timeoutMs: 120_000,
      });
    });

    it('should handle empty messages', async () => {
      const runner = createMockRunner({
        ok: true,
        runId: 'run-3',
        output: { ok: true, messages: [], latestId: null },
        stats: { durationMs: 100, exitCode: 0 },
      });

      const result = await fetchTelegramGroup(profile, groupUrl, sourceId, sourceName, undefined, runner);

      expect(result.success).toBe(true);
      expect(result.articles).toHaveLength(0);
    });
  });

  describe('NOT_AUTHENTICATED error', () => {
    it('should return errorCode NOT_AUTHENTICATED', async () => {
      const runner = createMockRunner({
        ok: true,
        runId: 'run-4',
        output: {
          ok: false,
          error: { code: 'NOT_AUTHENTICATED', message: 'Redirected to login page' },
          messages: [],
          latestId: null,
        },
        stats: { durationMs: 3000, exitCode: 0 },
      });

      const result = await fetchTelegramGroup(profile, groupUrl, sourceId, sourceName, undefined, runner);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('NOT_AUTHENTICATED');
      expect(result.error).toContain('login');
    });
  });

  describe('script execution failure', () => {
    it('should handle script run error (ok: false)', async () => {
      const runner = createMockRunner({
        ok: false,
        runId: 'run-5',
        error: { code: 'TIMED_OUT', message: 'Script timed out' },
        stats: { durationMs: 120_000, exitCode: undefined },
      });

      const result = await fetchTelegramGroup(profile, groupUrl, sourceId, sourceName, undefined, runner);

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    });

    it('should handle thrown errors', async () => {
      const runner = createThrowingRunner(new Error('Docker unavailable'));

      const result = await fetchTelegramGroup(profile, groupUrl, sourceId, sourceName, undefined, runner);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Docker unavailable');
    });

    it('should handle null output', async () => {
      const runner = createMockRunner({
        ok: true,
        runId: 'run-6',
        stats: { durationMs: 100, exitCode: 0 },
      });

      const result = await fetchTelegramGroup(profile, groupUrl, sourceId, sourceName, undefined, runner);

      expect(result.success).toBe(false);
      expect(result.error).toContain('no output');
    });
  });

  describe('article conversion', () => {
    it('should truncate long message text in title', async () => {
      const longText = 'A'.repeat(300);
      const runner = createMockRunner({
        ok: true,
        runId: 'run-7',
        output: {
          ok: true,
          messages: [{ id: '200', text: longText, date: '', from: '' }],
          latestId: '200',
        },
        stats: { durationMs: 100, exitCode: 0 },
      });

      const result = await fetchTelegramGroup(profile, groupUrl, sourceId, sourceName, undefined, runner);

      expect(result.articles[0].title.length).toBeLessThanOrEqual(160); // 150 + some room for prefix
    });

    it('should handle messages without text', async () => {
      const runner = createMockRunner({
        ok: true,
        runId: 'run-8',
        output: {
          ok: true,
          messages: [{ id: '300', text: '', date: '2024-01-15T10:00:00Z', from: 'Charlie' }],
          latestId: '300',
        },
        stats: { durationMs: 100, exitCode: 0 },
      });

      const result = await fetchTelegramGroup(profile, groupUrl, sourceId, sourceName, undefined, runner);

      expect(result.articles[0].title).toContain('Message 300');
    });

    it('should parse valid dates', async () => {
      const runner = createMockRunner({
        ok: true,
        runId: 'run-9',
        output: {
          ok: true,
          messages: [{ id: '400', text: 'Test', date: '2024-06-15T14:30:00Z', from: '' }],
          latestId: '400',
        },
        stats: { durationMs: 100, exitCode: 0 },
      });

      const result = await fetchTelegramGroup(profile, groupUrl, sourceId, sourceName, undefined, runner);

      expect(result.articles[0].publishedAt).toBeInstanceOf(Date);
      expect(result.articles[0].publishedAt?.getFullYear()).toBe(2024);
    });

    it('should handle invalid dates gracefully', async () => {
      const runner = createMockRunner({
        ok: true,
        runId: 'run-10',
        output: {
          ok: true,
          messages: [{ id: '500', text: 'Test', date: 'not-a-date', from: '' }],
          latestId: '500',
        },
        stats: { durationMs: 100, exitCode: 0 },
      });

      const result = await fetchTelegramGroup(profile, groupUrl, sourceId, sourceName, undefined, runner);

      expect(result.articles[0].publishedAt).toBeUndefined();
    });
  });
});
