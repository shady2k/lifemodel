/**
 * Script Runner
 *
 * Orchestration layer between core.act (script mode) and ContainerManager.
 * Handles: registry lookup → input validation → lock acquisition →
 * heartbeat renewal → container execution → output parsing/validation →
 * lock release.
 *
 * Concurrency: max 2 concurrent script runs (semaphore).
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from '../../types/index.js';
import type { ContainerManager } from '../container/types.js';
import type {
  ScriptRunRequest,
  ScriptRunResult,
  ScriptErrorCode,
  ScriptContainerConfig,
  ScriptRegistryEntry,
  LockHandle,
  LockService,
} from './script-types.js';
import { getScriptEntry } from './script-registry.js';
import { BROWSER_IMAGE } from '../container/types.js';

const MAX_CONCURRENT_SCRIPTS = 2;

/**
 * Script Runner — orchestrates script execution lifecycle.
 */
export class ScriptRunner {
  private readonly containerManager: ContainerManager;
  private readonly lockService: LockService;
  private readonly logger: Logger;
  private activeCount = 0;

  constructor(deps: {
    containerManager: ContainerManager;
    lockService: LockService;
    logger: Logger;
  }) {
    this.containerManager = deps.containerManager;
    this.lockService = deps.lockService;
    this.logger = deps.logger.child({ component: 'script-runner' });
  }

  /**
   * Execute a script request.
   *
   * Flow: resolve registry → validate inputs → check concurrency →
   * compute timeout → acquire lock → start heartbeat → run container →
   * parse output → validate output → release lock
   */
  async execute(request: ScriptRunRequest): Promise<ScriptRunResult> {
    const runId = randomUUID();
    const startTime = Date.now();

    // 1. Resolve registry entry
    const entry = getScriptEntry(request.scriptId);
    if (!entry) {
      return this.errorResult(runId, startTime, 'SCRIPT_NOT_FOUND', undefined, {
        message: `Unknown script: ${request.scriptId}`,
      });
    }

    // 2. Validate inputs
    if (entry.inputSchema) {
      const parsed = entry.inputSchema.safeParse(request.inputs);
      if (!parsed.success) {
        const zodError = parsed.error;
        const message =
          zodError && typeof zodError === 'object' && 'message' in zodError
            ? (zodError as { message: string }).message
            : 'Input validation failed';
        return this.errorResult(runId, startTime, 'INVALID_INPUT', undefined, { message });
      }
    }

    // 3. Concurrency check
    if (this.activeCount >= MAX_CONCURRENT_SCRIPTS) {
      return this.errorResult(runId, startTime, 'CONCURRENCY_LIMIT', undefined, {
        message: `Max concurrent scripts (${String(MAX_CONCURRENT_SCRIPTS)}) reached`,
      });
    }

    this.activeCount++;
    let lockHandle: LockHandle | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

    try {
      // 4. Compute effective timeout
      const requestedTimeout = request.timeoutMs ?? entry.maxTimeoutMs;
      const effectiveTimeout = Math.min(requestedTimeout, entry.maxTimeoutMs);

      // 5. Acquire lock (if configured)
      if (entry.lock) {
        const lockKey = this.interpolateLockKey(entry.lock.keyTemplate, request.inputs);
        try {
          lockHandle = await this.lockService.acquire(lockKey, {
            waitPolicy: entry.lock.waitPolicy,
            waitTimeoutMs: entry.lock.waitTimeoutMs,
            leaseMs: entry.lock.leaseMs,
          });
          this.logger.debug(
            { runId, lockKey, handleId: lockHandle.id },
            'Lock acquired for script'
          );

          // Start heartbeat renewal (renew at half the lease interval)
          const renewInterval = Math.max(entry.lock.leaseMs / 2, 1000);
          heartbeatTimer = setInterval(() => {
            if (lockHandle) {
              this.lockService.renew(lockHandle);
            }
          }, renewInterval);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return this.errorResult(runId, startTime, 'LOCK_UNAVAILABLE', undefined, { message });
        }
      }

      // 6. Build container config
      const containerConfig = this.buildContainerConfig(entry, request);

      // 7. Run container
      this.logger.info(
        { runId, scriptId: request.scriptId, timeout: effectiveTimeout },
        'Running script'
      );

      const containerResult = await this.containerManager.runScript(
        runId,
        containerConfig,
        effectiveTimeout
      );

      // 8. Handle timeout
      if (containerResult.exitCode === -1) {
        return this.errorResult(runId, startTime, 'TIMED_OUT', -1, {
          message: `Script timed out after ${String(effectiveTimeout)}ms`,
        });
      }

      // 9. Handle non-zero exit
      if (containerResult.exitCode !== 0) {
        // Check if stdout contains a structured error (e.g., NOT_AUTHENTICATED)
        const structuredError = this.tryParseStructuredError(containerResult.stdout);
        if (structuredError) {
          return this.errorResult(
            runId,
            startTime,
            structuredError.code,
            containerResult.exitCode,
            { message: structuredError.message }
          );
        }

        return this.errorResult(runId, startTime, 'SCRIPT_EXIT_NONZERO', containerResult.exitCode, {
          message: `Script exited with code ${String(containerResult.exitCode)}`,
        });
      }

      // 10. Parse stdout JSON
      let output: unknown;
      try {
        output = JSON.parse(containerResult.stdout);
      } catch {
        return this.errorResult(runId, startTime, 'INVALID_OUTPUT', 0, {
          message: `Script stdout is not valid JSON: ${containerResult.stdout.slice(0, 200)}`,
        });
      }

      // 11. Validate output schema
      if (entry.outputSchema) {
        const parsed = entry.outputSchema.safeParse(output);
        if (!parsed.success) {
          const zodError = parsed.error;
          const message =
            zodError && typeof zodError === 'object' && 'message' in zodError
              ? (zodError as { message: string }).message
              : 'Output validation failed';
          return this.errorResult(runId, startTime, 'INVALID_OUTPUT', 0, { message });
        }
      }

      // 12. Success!
      this.logger.info(
        { runId, scriptId: request.scriptId, durationMs: Date.now() - startTime },
        'Script completed successfully'
      );

      return {
        ok: true,
        runId,
        output,
        stats: {
          durationMs: Date.now() - startTime,
          exitCode: containerResult.exitCode,
        },
      };
    } catch (error) {
      // Unexpected error (Docker failure, etc.)
      const message = error instanceof Error ? error.message : String(error);
      const isDockerError = /docker|container|image/i.test(message);
      const code: ScriptErrorCode = isDockerError ? 'DOCKER_UNAVAILABLE' : 'SCRIPT_EXIT_NONZERO';

      this.logger.error({ runId, error: message }, 'Script execution failed');
      return this.errorResult(runId, startTime, code, undefined, { message });
    } finally {
      this.activeCount--;

      // Clear heartbeat timer
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }

      // Release lock
      if (lockHandle) {
        this.lockService.release(lockHandle);
        this.logger.debug({ runId, handleId: lockHandle.id }, 'Lock released for script');
      }
    }
  }

  /**
   * Interpolate lock key template with input values.
   * Template: 'browserProfile:${inputs.profile}' → 'browserProfile:telegram'
   */
  private interpolateLockKey(template: string, inputs: Record<string, unknown>): string {
    return template.replace(/\$\{inputs\.(\w+)\}/g, (_match, key: string) => {
      const value = inputs[key];
      if (value === undefined || value === null) return '';
      return typeof value === 'string' ? value : JSON.stringify(value);
    });
  }

  /**
   * Build ScriptContainerConfig from registry entry and request.
   */
  private buildContainerConfig(
    entry: ScriptRegistryEntry,
    request: ScriptRunRequest
  ): ScriptContainerConfig {
    const config: ScriptContainerConfig = {
      image: entry.image,
      entrypoint: entry.entrypoint,
      inputsJson: JSON.stringify(request.inputs),
    };

    if (entry.domains.length > 0) {
      config.allowedDomains = entry.domains;
    }

    if (entry.profileVolume) {
      // Resolve volume name from inputs (e.g., profile field)
      const profileInput = request.inputs['profile'] as string | undefined;
      const suffix = profileInput ?? 'default';
      config.profileMount = {
        volumeName: `${entry.profileVolume.volumeNamePrefix}-${suffix}`,
        containerPath: entry.profileVolume.containerPath,
        mode: entry.profileVolume.mode,
      };
    }

    // Browser image scripts need additional writable mounts and higher resource limits:
    // - /home/pwuser tmpfs: Chromium needs writable cache/lock directories
    // - pidsLimit 256: Chromium spawns renderer, GPU, network, utility processes (64 is too low)
    if (entry.image === BROWSER_IMAGE) {
      config.tmpfs = ['/home/pwuser:rw,nosuid,size=64m'];
      config.pidsLimit = 256;
      // Playwright v1.58+ image uses pwuser at UID 1001 (not 1000).
      // Must match the auth container's user to access profile volume files.
      config.user = '1001:1001';
    }

    return config;
  }

  /**
   * Try to parse a structured error from stdout.
   * Scripts can output { ok: false, error: { code, message } } for known errors.
   */
  private tryParseStructuredError(
    stdout: string
  ): { code: ScriptErrorCode; message: string } | undefined {
    try {
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      if (
        parsed['ok'] === false &&
        parsed['error'] &&
        typeof parsed['error'] === 'object' &&
        'code' in (parsed['error'] as Record<string, unknown>)
      ) {
        const err = parsed['error'] as { code: string; message?: string };
        // Validate it's a known error code
        const validCodes = new Set<string>([
          'TIMED_OUT',
          'LOCK_UNAVAILABLE',
          'INVALID_INPUT',
          'INVALID_OUTPUT',
          'SCRIPT_EXIT_NONZERO',
          'DOCKER_UNAVAILABLE',
          'SCRIPT_NOT_FOUND',
          'CONCURRENCY_LIMIT',
          'NOT_AUTHENTICATED',
        ]);
        if (validCodes.has(err.code)) {
          return {
            code: err.code as ScriptErrorCode,
            message: err.message ?? err.code,
          };
        }
      }
    } catch {
      // Not JSON or wrong shape — fall through
    }
    return undefined;
  }

  /**
   * Build a standardized error result.
   */
  private errorResult(
    runId: string,
    startTime: number,
    code: ScriptErrorCode,
    exitCode: number | undefined,
    error: { message: string }
  ): ScriptRunResult {
    return {
      ok: false,
      runId,
      error: { code, message: error.message },
      stats: {
        durationMs: Date.now() - startTime,
        exitCode,
      },
    };
  }
}
