import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScriptRunner } from '../../../../src/runtime/motor-cortex/script-runner.js';
import type { ContainerManager } from '../../../../src/runtime/container/types.js';
import type { LockService, LockHandle } from '../../../../src/runtime/motor-cortex/script-types.js';

function createMockLogger() {
  return {
    child: vi.fn().mockReturnThis(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    level: 'info',
    silent: vi.fn(),
  } as unknown as import('../../../../src/types/index.js').Logger;
}

function createMockContainerManager(
  overrides: Partial<ContainerManager> = {}
): ContainerManager {
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    create: vi.fn(),
    destroy: vi.fn(),
    prune: vi.fn(),
    destroyAll: vi.fn(),
    runScript: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '{"echo":"hello"}' }),
    ...overrides,
  } as ContainerManager;
}

function createMockLockService(overrides: Partial<LockService> = {}): LockService {
  const mockHandle: LockHandle = {
    id: 'lock_test123',
    key: 'test-key',
    acquiredAt: Date.now(),
    leaseMs: 5000,
  };
  return {
    acquire: vi.fn().mockResolvedValue(mockHandle),
    renew: vi.fn(),
    release: vi.fn(),
    pruneExpired: vi.fn(),
    ...overrides,
  };
}

describe('ScriptRunner', () => {
  let runner: ScriptRunner;
  let containerManager: ContainerManager;
  let lockService: LockService;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    containerManager = createMockContainerManager();
    lockService = createMockLockService();
    logger = createMockLogger();
    runner = new ScriptRunner({
      containerManager,
      lockService,
      logger,
    });
  });

  describe('happy path', () => {
    it('should execute echo test script successfully', async () => {
      const result = await runner.execute({
        task: 'Test echo',
        scriptId: 'test.echo.run',
        inputs: { message: 'hello' },
      });

      expect(result.ok).toBe(true);
      expect(result.output).toEqual({ echo: 'hello' });
      expect(result.stats.exitCode).toBe(0);
      expect(result.stats.durationMs).toBeGreaterThanOrEqual(0);

      // Should have called runScript
      expect(containerManager.runScript).toHaveBeenCalledOnce();
      const [runId, config, timeout] = (containerManager.runScript as ReturnType<typeof vi.fn>)
        .mock.calls[0] as [string, unknown, number];
      expect(runId).toBeTruthy();
      expect(config).toMatchObject({
        image: 'lifemodel-motor:latest',
        entrypoint: ['node', '/opt/motor/scripts/echo-test.js'],
        inputsJson: JSON.stringify({ message: 'hello' }),
      });
      expect(timeout).toBe(10000); // maxTimeoutMs from registry
    });
  });

  describe('unknown scriptId', () => {
    it('should return SCRIPT_NOT_FOUND for unknown script', async () => {
      const result = await runner.execute({
        task: 'Unknown script',
        scriptId: 'nonexistent.script.run',
        inputs: {},
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('SCRIPT_NOT_FOUND');
    });
  });

  describe('input validation', () => {
    it('should reject invalid inputs', async () => {
      const result = await runner.execute({
        task: 'Bad input',
        scriptId: 'test.echo.run',
        inputs: { message: 123 }, // Should be string
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
    });

    it('should reject missing required inputs', async () => {
      const result = await runner.execute({
        task: 'Missing input',
        scriptId: 'test.echo.run',
        inputs: {}, // Missing 'message'
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
    });
  });

  describe('output schema mismatch', () => {
    it('should return INVALID_OUTPUT for wrong output shape', async () => {
      containerManager = createMockContainerManager({
        runScript: vi.fn().mockResolvedValue({
          exitCode: 0,
          stdout: '{"wrong":"shape"}',
        }),
      });
      runner = new ScriptRunner({ containerManager, lockService, logger });

      const result = await runner.execute({
        task: 'Bad output',
        scriptId: 'test.echo.run',
        inputs: { message: 'hello' },
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('INVALID_OUTPUT');
    });

    it('should return INVALID_OUTPUT for non-JSON stdout', async () => {
      containerManager = createMockContainerManager({
        runScript: vi.fn().mockResolvedValue({
          exitCode: 0,
          stdout: 'not json',
        }),
      });
      runner = new ScriptRunner({ containerManager, lockService, logger });

      const result = await runner.execute({
        task: 'Non-JSON',
        scriptId: 'test.echo.run',
        inputs: { message: 'hello' },
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('INVALID_OUTPUT');
    });
  });

  describe('concurrency limit', () => {
    it('should reject when max concurrent scripts reached', async () => {
      // Create a slow runScript that blocks
      let resolveFirst: (() => void) | undefined;
      let resolveSecond: (() => void) | undefined;
      const slowContainerManager = createMockContainerManager({
        runScript: vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise<{ exitCode: number; stdout: string }>((resolve) => {
                resolveFirst = () => resolve({ exitCode: 0, stdout: '{"echo":"1"}' });
              })
          )
          .mockImplementationOnce(
            () =>
              new Promise<{ exitCode: number; stdout: string }>((resolve) => {
                resolveSecond = () => resolve({ exitCode: 0, stdout: '{"echo":"2"}' });
              })
          )
          .mockResolvedValue({ exitCode: 0, stdout: '{"echo":"3"}' }),
      });

      runner = new ScriptRunner({
        containerManager: slowContainerManager,
        lockService,
        logger,
      });

      // Start 2 scripts (max concurrent = 2)
      const p1 = runner.execute({ task: 'T1', scriptId: 'test.echo.run', inputs: { message: '1' } });
      const p2 = runner.execute({ task: 'T2', scriptId: 'test.echo.run', inputs: { message: '2' } });

      // 3rd should be rejected
      const result3 = await runner.execute({
        task: 'T3',
        scriptId: 'test.echo.run',
        inputs: { message: '3' },
      });

      expect(result3.ok).toBe(false);
      expect(result3.error?.code).toBe('CONCURRENCY_LIMIT');

      // Clean up
      resolveFirst?.();
      resolveSecond?.();
      await Promise.all([p1, p2]);
    });
  });

  describe('lock contention', () => {
    it('should return LOCK_UNAVAILABLE when lock cannot be acquired', async () => {
      // Register a script entry with lock config for this test
      const { registerScriptEntry } = await import(
        '../../../../src/runtime/motor-cortex/script-registry.js'
      );
      const { z } = await import('zod');

      registerScriptEntry({
        id: 'test.locked.run',
        image: 'lifemodel-motor:latest',
        entrypoint: ['node', '/opt/motor/scripts/echo-test.js'],
        domains: [],
        maxTimeoutMs: 10000,
        inputSchema: z.object({ message: z.string() }),
        outputSchema: z.object({ echo: z.string() }),
        lock: {
          keyTemplate: 'test:${inputs.message}',
          exclusive: true,
          waitPolicy: 'fail_fast',
          waitTimeoutMs: 0,
          leaseMs: 5000,
        },
      });

      const failingLockService = createMockLockService({
        acquire: vi.fn().mockRejectedValue(new Error('Lock unavailable: test:hello')),
      });

      runner = new ScriptRunner({
        containerManager,
        lockService: failingLockService,
        logger,
      });

      const result = await runner.execute({
        task: 'Locked',
        scriptId: 'test.locked.run',
        inputs: { message: 'hello' },
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('LOCK_UNAVAILABLE');
    });
  });

  describe('timeout handling', () => {
    it('should return TIMED_OUT when container times out', async () => {
      containerManager = createMockContainerManager({
        runScript: vi.fn().mockResolvedValue({ exitCode: -1, stdout: '' }),
      });
      runner = new ScriptRunner({ containerManager, lockService, logger });

      const result = await runner.execute({
        task: 'Timeout',
        scriptId: 'test.echo.run',
        inputs: { message: 'hello' },
        timeoutMs: 1000,
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('TIMED_OUT');
    });
  });

  describe('non-zero exit', () => {
    it('should return SCRIPT_EXIT_NONZERO for exit code != 0', async () => {
      containerManager = createMockContainerManager({
        runScript: vi.fn().mockResolvedValue({ exitCode: 1, stdout: '' }),
      });
      runner = new ScriptRunner({ containerManager, lockService, logger });

      const result = await runner.execute({
        task: 'Exit 1',
        scriptId: 'test.echo.run',
        inputs: { message: 'hello' },
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('SCRIPT_EXIT_NONZERO');
    });

    it('should detect NOT_AUTHENTICATED from structured error', async () => {
      containerManager = createMockContainerManager({
        runScript: vi.fn().mockResolvedValue({
          exitCode: 1,
          stdout: JSON.stringify({
            ok: false,
            error: { code: 'NOT_AUTHENTICATED', message: 'Login required' },
          }),
        }),
      });
      runner = new ScriptRunner({ containerManager, lockService, logger });

      const result = await runner.execute({
        task: 'Auth check',
        scriptId: 'test.echo.run',
        inputs: { message: 'hello' },
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('NOT_AUTHENTICATED');
      expect(result.error?.message).toBe('Login required');
    });
  });

  describe('timeout capping', () => {
    it('should cap timeout to maxTimeoutMs from registry', async () => {
      await runner.execute({
        task: 'High timeout',
        scriptId: 'test.echo.run',
        inputs: { message: 'hello' },
        timeoutMs: 999999, // Way above maxTimeoutMs (10000)
      });

      const [, , timeout] = (containerManager.runScript as ReturnType<typeof vi.fn>)
        .mock.calls[0] as [string, unknown, number];
      expect(timeout).toBe(10000); // Capped to maxTimeoutMs
    });
  });
});
