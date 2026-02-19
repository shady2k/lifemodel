/**
 * Tests for the list_groups action in the news tool.
 *
 * Validates the list_groups flow with mocked ScriptRunnerPrimitive.
 * Tests happy path, auth failure, empty groups, and script failure.
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  PluginPrimitives,
  ScriptRunnerPrimitive,
  PluginScriptRunResult,
  PluginToolContext,
} from '../../../../../src/types/plugin.js';
import { createNewsTool } from '../../../../../src/plugins/news/tools/news-tool.js';

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

function createMockPrimitives(
  scriptRunner?: ScriptRunnerPrimitive | undefined
): PluginPrimitives {
  return {
    storage: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      keys: vi.fn().mockResolvedValue([]),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
      fatal: vi.fn(),
      trace: vi.fn(),
      silent: vi.fn(),
      level: 'info',
    } as unknown as PluginPrimitives['logger'],
    intentEmitter: {
      emitSignal: vi.fn().mockReturnValue({ success: true }),
      emitPendingIntention: vi.fn(),
    },
    memorySearch: {
      searchOwnFacts: vi.fn().mockResolvedValue({
        entries: [],
        pagination: { page: 1, totalPages: 0, total: 0, hasMore: false },
      }),
    },
    scriptRunner,
    services: {
      registerEventSchema: vi.fn(),
    } as unknown as PluginPrimitives['services'],
  } as unknown as PluginPrimitives;
}

describe('list_groups action', () => {
  const profile = 'telegram';

  describe('happy path', () => {
    it('should return groups from script output', async () => {
      const runner = createMockRunner({
        ok: true,
        runId: 'run-1',
        output: {
          ok: true,
          groups: [
            { id: '-1001234567890', name: 'Test Group', url: 'https://web.telegram.org/a/#-1001234567890' },
            { id: '-1009876543210', name: 'Another Group', url: 'https://web.telegram.org/a/#-1009876543210' },
          ],
        },
        stats: { durationMs: 5000, exitCode: 0 },
      });

      const primitives = createMockPrimitives(runner);
      const tool = createNewsTool(primitives);

      const result = await tool.execute(
        { action: 'list_groups', profile },
        undefined as unknown as PluginToolContext
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe('list_groups');
      expect(result.groups).toHaveLength(2);
      expect(result.groups![0].name).toBe('Test Group');
      expect(result.groups![1].id).toBe('-1009876543210');
      expect(result.total).toBe(2);
      expect(result.hint).toContain('add_source');
    });

    it('should pass correct inputs to script runner', async () => {
      const runner = createMockRunner({
        ok: true,
        runId: 'run-2',
        output: { ok: true, groups: [] },
        stats: { durationMs: 100, exitCode: 0 },
      });

      const primitives = createMockPrimitives(runner);
      const tool = createNewsTool(primitives);

      await tool.execute(
        { action: 'list_groups', profile: 'my-profile' },
        undefined as unknown as PluginToolContext
      );

      expect(runner.runScript).toHaveBeenCalledWith({
        scriptId: 'news.telegram_group.list',
        inputs: { profile: 'my-profile' },
        timeoutMs: 60_000,
      });
    });
  });

  describe('empty groups list', () => {
    it('should handle no groups found', async () => {
      const runner = createMockRunner({
        ok: true,
        runId: 'run-3',
        output: { ok: true, groups: [] },
        stats: { durationMs: 100, exitCode: 0 },
      });

      const primitives = createMockPrimitives(runner);
      const tool = createNewsTool(primitives);

      const result = await tool.execute(
        { action: 'list_groups', profile },
        undefined as unknown as PluginToolContext
      );

      expect(result.success).toBe(true);
      expect(result.groups).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.hint).toContain('No groups found');
    });
  });

  describe('NOT_AUTHENTICATED error', () => {
    it('should report browser auth unavailable when NOT_AUTHENTICATED and no browserAuth', async () => {
      const runner = createMockRunner({
        ok: true,
        runId: 'run-4',
        output: {
          ok: false,
          error: { code: 'NOT_AUTHENTICATED', message: 'Redirected to login page' },
          groups: [],
        },
        stats: { durationMs: 3000, exitCode: 0 },
      });

      const primitives = createMockPrimitives(runner);
      const tool = createNewsTool(primitives);

      const result = await tool.execute(
        { action: 'list_groups', profile },
        undefined as unknown as PluginToolContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });

    it('should report browser auth unavailable when script runner reports NOT_AUTHENTICATED', async () => {
      const runner = createMockRunner({
        ok: false,
        runId: 'run-5',
        error: { code: 'NOT_AUTHENTICATED', message: 'Not authenticated' },
        stats: { durationMs: 1000, exitCode: undefined },
      });

      const primitives = createMockPrimitives(runner);
      const tool = createNewsTool(primitives);

      const result = await tool.execute(
        { action: 'list_groups', profile },
        undefined as unknown as PluginToolContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });
  });

  describe('script failure', () => {
    it('should handle script execution error', async () => {
      const runner = createThrowingRunner(new Error('Docker unavailable'));

      const primitives = createMockPrimitives(runner);
      const tool = createNewsTool(primitives);

      const result = await tool.execute(
        { action: 'list_groups', profile },
        undefined as unknown as PluginToolContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Docker unavailable');
    });

    it('should handle null script output', async () => {
      const runner = createMockRunner({
        ok: true,
        runId: 'run-6',
        stats: { durationMs: 100, exitCode: 0 },
      });

      const primitives = createMockPrimitives(runner);
      const tool = createNewsTool(primitives);

      const result = await tool.execute(
        { action: 'list_groups', profile },
        undefined as unknown as PluginToolContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle script run error (ok: false)', async () => {
      const runner = createMockRunner({
        ok: false,
        runId: 'run-7',
        error: { code: 'TIMED_OUT', message: 'Script timed out' },
        stats: { durationMs: 60_000, exitCode: undefined },
      });

      const primitives = createMockPrimitives(runner);
      const tool = createNewsTool(primitives);

      const result = await tool.execute(
        { action: 'list_groups', profile },
        undefined as unknown as PluginToolContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    });
  });

  describe('validation', () => {
    it('should require profile parameter', async () => {
      const primitives = createMockPrimitives();
      const tool = createNewsTool(primitives);

      const result = await tool.execute(
        { action: 'list_groups' },
        undefined as unknown as PluginToolContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('profile');
    });

    it('should fail when scriptRunner is not available', async () => {
      const primitives = createMockPrimitives(undefined);
      const tool = createNewsTool(primitives);

      const result = await tool.execute(
        { action: 'list_groups', profile },
        undefined as unknown as PluginToolContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Script runner not available');
    });
  });
});
