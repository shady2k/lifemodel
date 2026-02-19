/**
 * Script Mode Types
 *
 * Types for deterministic Docker-based script execution (no LLM loop).
 * Scripts are single-process jobs that read SCRIPT_INPUTS env and write
 * JSON to stdout. No IPC tool-server — just process lifecycle.
 *
 * Error taxonomy:
 * TIMED_OUT | LOCK_UNAVAILABLE | INVALID_INPUT | INVALID_OUTPUT |
 * SCRIPT_EXIT_NONZERO | DOCKER_UNAVAILABLE | SCRIPT_NOT_FOUND |
 * CONCURRENCY_LIMIT | NOT_AUTHENTICATED
 */

import type { ZodType } from 'zod';

// ─── Script Error Codes ──────────────────────────────────────

export type ScriptErrorCode =
  | 'TIMED_OUT'
  | 'LOCK_UNAVAILABLE'
  | 'INVALID_INPUT'
  | 'INVALID_OUTPUT'
  | 'SCRIPT_EXIT_NONZERO'
  | 'DOCKER_UNAVAILABLE'
  | 'SCRIPT_NOT_FOUND'
  | 'CONCURRENCY_LIMIT'
  | 'NOT_AUTHENTICATED';

// ─── Script Run Result ───────────────────────────────────────

export interface ScriptRunResult {
  ok: boolean;
  runId: string;
  output?: unknown;
  error?: { code: ScriptErrorCode; message: string } | undefined;
  stats: {
    durationMs: number;
    exitCode: number | undefined;
  };
}

// ─── Script Registry ─────────────────────────────────────────

export interface ScriptRegistryEntry {
  /** Script ID: <domain>.<resource>.<action> */
  id: string;

  /** Docker image to run (e.g., CONTAINER_IMAGE or BROWSER_IMAGE) */
  image: string;

  /** Entrypoint command inside the container */
  entrypoint: string[];

  /** Allowed network domains (empty = no network) */
  domains: string[];

  /** Lock configuration (undefined = no lock needed) */
  lock?: ScriptLockConfig | undefined;

  /** Named Docker volume for browser profile (undefined = none) */
  profileVolume?: ScriptProfileVolume | undefined;

  /** Zod schema for validating inputs (undefined = no validation) */
  inputSchema?: ZodType | undefined;

  /** Zod schema for validating stdout JSON output (undefined = no validation) */
  outputSchema?: ZodType | undefined;

  /** Maximum timeout in ms (runner caps requested timeout to this) */
  maxTimeoutMs: number;
}

export interface ScriptLockConfig {
  /** Lock key template — supports ${inputs.fieldName} interpolation */
  keyTemplate: string;

  /** Whether the lock is exclusive (only one holder at a time) */
  exclusive: boolean;

  /** Wait policy when lock is held */
  waitPolicy: 'fail_fast' | 'block';

  /** How long to wait for a blocked lock (ms) */
  waitTimeoutMs: number;

  /** Lease duration in ms (auto-released if holder crashes) */
  leaseMs: number;
}

export interface ScriptProfileVolume {
  /** Docker volume name prefix (e.g., 'lifemodel-browser-profile') */
  volumeNamePrefix: string;

  /** Mount path inside container */
  containerPath: string;

  /** Mount mode */
  mode: 'ro' | 'rw';
}

// ─── Script Container Config ─────────────────────────────────

/**
 * Config passed to ContainerManager.runScript().
 * Separate from agentic ContainerConfig — no workspace volume, different entrypoint.
 */
export interface ScriptContainerConfig {
  /** Docker image name */
  image: string;

  /** Entrypoint override */
  entrypoint: string[];

  /** JSON-encoded inputs (set as SCRIPT_INPUTS env var) */
  inputsJson: string;

  /** Profile volume mount (undefined = none) */
  profileMount?: { volumeName: string; containerPath: string; mode: 'ro' | 'rw' } | undefined;

  /** Allowed network domains (undefined = no network) */
  allowedDomains?: string[] | undefined;

  /** Extra environment variables */
  extraEnv?: Record<string, string> | undefined;

  /** Additional writable tmpfs mounts (e.g., /home/pwuser for Chromium cache) */
  tmpfs?: string[] | undefined;

  /** Process limit override (default: 64, Chromium needs ~256) */
  pidsLimit?: number | undefined;

  /** Container user override as "uid:gid" (default: "1000:1000") */
  user?: string | undefined;
}

// ─── Script Container Result ─────────────────────────────────

/**
 * Raw result from ContainerManager.runScript().
 */
export interface ScriptContainerResult {
  exitCode: number;
  stdout: string;
}

// ─── Script Run Request ──────────────────────────────────────

/**
 * Request to execute a script (from core.act or plugin).
 */
export interface ScriptRunRequest {
  /** Human-readable task description (for logging) */
  task: string;

  /** Script ID from registry */
  scriptId: string;

  /** Input values (validated against registry schema) */
  inputs: Record<string, unknown>;

  /** Requested timeout in ms (capped to entry.maxTimeoutMs) */
  timeoutMs?: number | undefined;
}

// ─── Lock Service ────────────────────────────────────────────

export interface LockHandle {
  /** Unique handle ID */
  id: string;

  /** Lock key */
  key: string;

  /** When the lock was acquired */
  acquiredAt: number;

  /** Lease duration in ms */
  leaseMs: number;
}

export interface LockService {
  /** Acquire a lock. Throws on failure (fail_fast) or timeout (block). */
  acquire(
    key: string,
    options: {
      waitPolicy: 'fail_fast' | 'block';
      waitTimeoutMs?: number | undefined;
      leaseMs: number;
    }
  ): Promise<LockHandle>;

  /** Renew a lock's lease (extends from now by original leaseMs). */
  renew(handle: LockHandle): void;

  /** Release a lock. Pops next waiter from FIFO queue. */
  release(handle: LockHandle): void;

  /** Clear all expired leases. */
  pruneExpired(): void;
}
