/**
 * Tests for scoped-script-runner.ts
 *
 * Validates that the scoped runner gates scripts to the plugin's allowlist
 * and forwards allowed requests to the executor.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createScopedScriptRunner,
  type ScriptExecutor,
  type AllowedScriptsLookup,
} from '../../../src/core/scoped-script-runner.js';

function createMockExecutor(): ScriptExecutor {
  return {
    executeScript: vi.fn().mockResolvedValue({
      ok: true,
      runId: 'run-123',
      output: { messages: [] },
      stats: { durationMs: 100, exitCode: 0 },
    }),
  };
}

function createMockLookup(allowedScripts: string[]): AllowedScriptsLookup {
  return {
    getAllowedScripts: vi.fn().mockReturnValue(allowedScripts),
  };
}

describe('createScopedScriptRunner', () => {
  it('should allow execution of a listed script', async () => {
    const executor = createMockExecutor();
    const lookup = createMockLookup(['news.telegram_group.fetch']);
    const runner = createScopedScriptRunner(executor, 'news', lookup);

    const result = await runner.runScript({
      scriptId: 'news.telegram_group.fetch',
      inputs: { profile: 'telegram', groupUrl: 'https://web.telegram.org/a/#-123' },
    });

    expect(result.ok).toBe(true);
    expect(result.runId).toBe('run-123');
    expect(executor.executeScript).toHaveBeenCalledWith({
      task: 'news:news.telegram_group.fetch',
      scriptId: 'news.telegram_group.fetch',
      inputs: { profile: 'telegram', groupUrl: 'https://web.telegram.org/a/#-123' },
      timeoutMs: undefined,
    });
  });

  it('should reject execution of an unlisted script', async () => {
    const executor = createMockExecutor();
    const lookup = createMockLookup(['news.telegram_group.fetch']);
    const runner = createScopedScriptRunner(executor, 'news', lookup);

    const result = await runner.runScript({
      scriptId: 'test.echo.run',
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SCRIPT_NOT_FOUND');
    expect(result.error?.message).toContain('not allowed');
    expect(result.error?.message).toContain('test.echo.run');
    expect(executor.executeScript).not.toHaveBeenCalled();
  });

  it('should reject when plugin has no allowed scripts', async () => {
    const executor = createMockExecutor();
    const lookup = createMockLookup([]);
    const runner = createScopedScriptRunner(executor, 'some-plugin', lookup);

    const result = await runner.runScript({
      scriptId: 'any.script.id',
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SCRIPT_NOT_FOUND');
    expect(executor.executeScript).not.toHaveBeenCalled();
  });

  it('should pass through timeoutMs to executor', async () => {
    const executor = createMockExecutor();
    const lookup = createMockLookup(['test.echo.run']);
    const runner = createScopedScriptRunner(executor, 'test', lookup);

    await runner.runScript({
      scriptId: 'test.echo.run',
      inputs: { message: 'hello' },
      timeoutMs: 5000,
    });

    expect(executor.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 5000 })
    );
  });

  it('should default inputs to empty object when not provided', async () => {
    const executor = createMockExecutor();
    const lookup = createMockLookup(['test.echo.run']);
    const runner = createScopedScriptRunner(executor, 'test', lookup);

    await runner.runScript({ scriptId: 'test.echo.run' });

    expect(executor.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ inputs: {} })
    );
  });

  it('should look up scripts using the correct plugin ID', async () => {
    const executor = createMockExecutor();
    const lookup = createMockLookup(['news.telegram_group.fetch']);
    const runner = createScopedScriptRunner(executor, 'news', lookup);

    await runner.runScript({ scriptId: 'news.telegram_group.fetch' });

    expect(lookup.getAllowedScripts).toHaveBeenCalledWith('news');
  });

  it('should return error stats with zero duration on rejection', async () => {
    const executor = createMockExecutor();
    const lookup = createMockLookup([]);
    const runner = createScopedScriptRunner(executor, 'test', lookup);

    const result = await runner.runScript({ scriptId: 'bad.script' });

    expect(result.stats.durationMs).toBe(0);
    expect(result.stats.exitCode).toBeUndefined();
    expect(result.runId).toBe('');
  });
});
