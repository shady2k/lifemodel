/**
 * Container IPC Protocol & Configuration Types
 *
 * Defines the communication protocol between the host process (trusted controller)
 * and the Docker container (untrusted worker). Uses length-prefixed JSON framing
 * for reliable message boundaries — NOT JSON-lines, which breaks if anything
 * logs to stdout.
 *
 * Wire format: [4-byte uint32 BE length][JSON payload of that length]
 */

import type { MotorToolResult } from '../motor-cortex/motor-protocol.js';

// ─── IPC Protocol ────────────────────────────────────────────────

/**
 * Request types sent from host → container tool-server.
 */
export type ToolServerRequest = ToolExecuteRequest | CredentialDeliverRequest | ShutdownRequest;

/**
 * Execute a tool inside the container.
 */
export interface ToolExecuteRequest {
  type: 'execute';
  id: string;
  tool: string;
  args: Record<string, unknown>;
  timeoutMs: number;
}

/**
 * Deliver a credential to the tool-server's in-memory store.
 * Credentials are never written to disk inside the container.
 */
export interface CredentialDeliverRequest {
  type: 'credential';
  name: string;
  value: string;
}

/**
 * Request graceful shutdown of the tool-server.
 */
export interface ShutdownRequest {
  type: 'shutdown';
}

/**
 * Response types sent from container tool-server → host.
 */
export type ToolServerResponse = ToolExecuteResponse | CredentialAckResponse | ErrorResponse;

/**
 * Result of tool execution.
 */
export interface ToolExecuteResponse {
  type: 'result';
  id: string;
  result: MotorToolResult;
}

/**
 * Acknowledgement of credential delivery.
 */
export interface CredentialAckResponse {
  type: 'credential_ack';
  name: string;
}

/**
 * Error response for protocol-level failures.
 */
export interface ErrorResponse {
  type: 'error';
  id?: string;
  message: string;
}

// ─── Length-Prefixed Framing ─────────────────────────────────────

/**
 * Encode a message as a length-prefixed buffer.
 *
 * Format: [4-byte uint32 BE length][UTF-8 JSON payload]
 */
export function encodeFrame(message: ToolServerRequest | ToolServerResponse): Buffer {
  const json = JSON.stringify(message);
  const payload = Buffer.from(json, 'utf-8');
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

/**
 * Streaming frame decoder.
 *
 * Accumulates data chunks and emits complete messages.
 * Handles partial reads (TCP-style buffering).
 */
export class FrameDecoder {
  private buffer = Buffer.alloc(0);
  private readonly onMessage: (msg: unknown) => void;

  constructor(onMessage: (msg: unknown) => void) {
    this.onMessage = onMessage;
  }

  /**
   * Feed data into the decoder. May emit zero or more messages.
   */
  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 4) {
      const payloadLength = this.buffer.readUInt32BE(0);

      // Sanity check: reject absurdly large frames (>10MB)
      if (payloadLength > 10 * 1024 * 1024) {
        throw new Error(`Frame too large: ${String(payloadLength)} bytes`);
      }

      if (this.buffer.length < 4 + payloadLength) {
        break; // Wait for more data
      }

      const json = this.buffer.subarray(4, 4 + payloadLength).toString('utf-8');
      this.buffer = this.buffer.subarray(4 + payloadLength);

      try {
        const parsed: unknown = JSON.parse(json);
        this.onMessage(parsed);
      } catch {
        throw new Error(`Invalid JSON in frame: ${json.slice(0, 100)}`);
      }
    }
  }
}

// ─── Container Configuration ─────────────────────────────────────

/**
 * Configuration for creating a Docker container.
 */
export interface ContainerConfig {
  /** Staging directory on host to copy workspace files FROM (via docker cp) */
  workspacePath: string;

  /** Named Docker volume for /workspace isolation (e.g., motor-ws-<runId>) */
  volumeName: string;

  /** Memory limit (default: '512m') */
  memoryLimit?: string;

  /** CPU limit (default: '1.0') */
  cpuLimit?: string;

  /** PID limit (default: 64) */
  pidsLimit?: number;

  /** Container lifetime cap in ms (default: 30 minutes) */
  maxLifetimeMs?: number;

  /** Allowed domains for network access (empty = no network) */
  allowedDomains?: string[];

  /** Allowed ports for network access (default: [80, 443]) */
  allowedPorts?: number[];

  /** Extra bind mounts (e.g. pre-installed dependency packs) */
  extraMounts?: { hostPath: string; containerPath: string; mode: 'ro' | 'rw' }[];

  /** Extra environment variables (e.g. NODE_PATH, PYTHONPATH for dependency mounts) */
  extraEnv?: Record<string, string>;
}

/**
 * Handle to a running container.
 *
 * Provides the IPC interface for tool execution and credential delivery.
 * Must be destroyed when the run completes (or fails).
 */
export interface ContainerHandle {
  /** Docker container ID */
  readonly containerId: string;

  /** Execute a tool request and wait for the response */
  execute(request: ToolExecuteRequest): Promise<ToolExecuteResponse>;

  /** Deliver a credential to the container's in-memory store */
  deliverCredential(name: string, value: string): Promise<void>;

  /**
   * Copy workspace files out of the container to a host directory.
   * Called after the run completes (container may be stopped).
   */
  copyWorkspaceOut(hostDir: string): Promise<void>;

  /** Destroy the container and its workspace volume (force-remove) */
  destroy(): Promise<void>;
}

/**
 * Manages Docker container lifecycle for Motor Cortex runs.
 */
export interface ContainerManager {
  /** Check if Docker is available and functional */
  isAvailable(): Promise<boolean>;

  /** Create a new container for a run */
  create(runId: string, config: ContainerConfig): Promise<ContainerHandle>;

  /** Destroy a specific run's container */
  destroy(runId: string): Promise<void>;

  /** Prune stale containers older than maxAgeMs */
  prune(maxAgeMs: number): Promise<number>;

  /** Destroy all Motor Cortex containers */
  destroyAll(): Promise<void>;
}

// ─── Constants ───────────────────────────────────────────────────

/** Docker label for identifying Motor Cortex containers */
export const CONTAINER_LABEL = 'com.lifemodel.component=motor-cortex';

/** Docker image name */
export const CONTAINER_IMAGE = 'lifemodel-motor:latest';

/** Default memory limit */
export const DEFAULT_MEMORY_LIMIT = '512m';

/** Default CPU limit */
export const DEFAULT_CPU_LIMIT = '1.0';

/** Default PID limit */
export const DEFAULT_PIDS_LIMIT = 64;

/** Default container lifetime cap (30 minutes) */
export const DEFAULT_MAX_LIFETIME_MS = 30 * 60 * 1000;

/** Tool-server idle timeout (5 minutes) */
export const TOOL_SERVER_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Per-request timeout buffer added on host side (10 seconds) */
export const REQUEST_TIMEOUT_BUFFER_MS = 10 * 1000;
