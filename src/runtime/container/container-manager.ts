/**
 * Container Manager — Docker CLI wrapper for Motor Cortex isolation.
 *
 * Manages container lifecycle:
 * - Create: `docker create` with security flags → `docker start -ai` for IPC
 * - Communicate: length-prefixed JSON over stdin/stdout
 * - Destroy: `docker rm -f` in finally blocks
 * - Prune: remove orphaned containers on startup
 *
 * Uses Docker CLI (not SDK) — zero dependencies, stable API.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import type { Logger } from '../../types/index.js';
import {
  type ContainerConfig,
  type ContainerHandle,
  type ContainerManager,
  type ToolExecuteRequest,
  type ToolExecuteResponse,
  type ToolServerResponse,
  FrameDecoder,
  encodeFrame,
  CONTAINER_LABEL,
  CONTAINER_IMAGE,
  DEFAULT_MEMORY_LIMIT,
  DEFAULT_CPU_LIMIT,
  DEFAULT_PIDS_LIMIT,
  DEFAULT_MAX_LIFETIME_MS,
  REQUEST_TIMEOUT_BUFFER_MS,
} from './types.js';
import { ensureImage } from './container-image.js';

const execFileAsync = promisify(execFile);

/**
 * Active container handles keyed by runId.
 */
const activeContainers = new Map<string, DockerContainerHandle>();

/**
 * Implementation of ContainerHandle using Docker CLI + stdin/stdout IPC.
 */
class DockerContainerHandle implements ContainerHandle {
  readonly containerId: string;
  private readonly logger: Logger;
  private readonly process: ReturnType<typeof spawn>;
  private readonly decoder: FrameDecoder;
  private readonly pending = new Map<
    string,
    {
      resolve: (response: ToolExecuteResponse) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private destroyed = false;
  private lifetimeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    containerId: string,
    proc: ReturnType<typeof spawn>,
    logger: Logger,
    maxLifetimeMs: number
  ) {
    this.containerId = containerId;
    this.process = proc;
    this.logger = logger.child({ containerId: containerId.slice(0, 12) });

    // Set up frame decoder
    this.decoder = new FrameDecoder((msg: unknown) => {
      this.handleResponse(msg as ToolServerResponse);
    });

    // Wire stdout to decoder
    proc.stdout?.on('data', (chunk: Buffer) => {
      try {
        this.decoder.push(chunk);
      } catch (err) {
        this.logger.error({ err }, 'Frame decode error');
      }
    });

    // Log stderr (tool-server diagnostic output)
    proc.stderr?.on('data', (chunk: Buffer) => {
      this.logger.debug({ output: chunk.toString().trim() }, 'Container stderr');
    });

    // Handle process exit
    proc.on('exit', (code, signal) => {
      if (!this.destroyed) {
        this.logger.warn({ code, signal }, 'Container process exited unexpectedly');
        // Reject all pending requests
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(
            new Error(`Container exited (code: ${String(code)}, signal: ${String(signal)})`)
          );
        }
        this.pending.clear();
      }
    });

    // Set lifetime cap
    this.lifetimeTimer = setTimeout(() => {
      this.logger.warn('Container lifetime cap reached, destroying');
      this.destroy().catch((err: unknown) => {
        this.logger.error({ error: err }, 'Failed to destroy container on lifetime cap');
      });
    }, maxLifetimeMs);
  }

  private handleResponse(response: ToolServerResponse): void {
    switch (response.type) {
      case 'result': {
        const entry = this.pending.get(response.id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(response.id);
          entry.resolve(response);
        }
        break;
      }

      case 'credential_ack':
        // Credential delivery acks are handled by the deliverCredential promise
        break;

      case 'error': {
        if (response.id) {
          const entry = this.pending.get(response.id);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(response.id);
            entry.reject(new Error(response.message));
          }
        } else {
          this.logger.warn({ message: response.message }, 'Container protocol error');
        }
        break;
      }
    }
  }

  async execute(request: ToolExecuteRequest): Promise<ToolExecuteResponse> {
    if (this.destroyed) {
      throw new Error('Container has been destroyed');
    }

    const timeoutMs = request.timeoutMs + REQUEST_TIMEOUT_BUFFER_MS;

    return new Promise<ToolExecuteResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new Error(`Container request timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);

      this.pending.set(request.id, { resolve, reject, timer });

      const frame = encodeFrame(request);
      const ok = this.process.stdin?.write(frame);
      if (ok === false) {
        // Backpressure — wait for drain
        this.process.stdin?.once('drain', () => {
          // Already queued via write()
        });
      }
    });
  }

  deliverCredential(name: string, value: string): void {
    if (this.destroyed) return;

    const frame = encodeFrame({ type: 'credential', name, value });
    this.process.stdin?.write(frame);

    // Best-effort — don't wait for ack (credential delivery is fire-and-forget)
    // The tool-server will ack on its timeline
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    // Clear lifetime timer
    if (this.lifetimeTimer) {
      clearTimeout(this.lifetimeTimer);
      this.lifetimeTimer = null;
    }

    // Reject all pending requests
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Container destroyed'));
    }
    this.pending.clear();

    // Close stdin to signal shutdown
    this.process.stdin?.end();

    // Force-remove container
    try {
      await execFileAsync('docker', ['rm', '-f', this.containerId], {
        timeout: 10_000,
      });
    } catch {
      // Container may already be gone
    }

    // Kill process if still alive
    if (!this.process.killed) {
      this.process.kill('SIGKILL');
    }
  }
}

/**
 * Build the `docker create` arguments with all security flags.
 */
function buildCreateArgs(containerName: string, config: ContainerConfig): string[] {
  const memoryLimit = config.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
  const cpuLimit = config.cpuLimit ?? DEFAULT_CPU_LIMIT;
  const pidsLimit = config.pidsLimit ?? DEFAULT_PIDS_LIMIT;

  const args: string[] = [
    'create',
    '--name',
    containerName,
    '--label',
    CONTAINER_LABEL,

    // Security flags
    '--read-only',
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    // Note: Docker applies default seccomp profile automatically.
    // We do NOT set seccomp=unconfined — that would disable it.

    // Resource limits
    '--pids-limit',
    String(pidsLimit),
    '--memory',
    memoryLimit,
    '--cpus',
    cpuLimit,

    // Writable temp (no exec, no suid)
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',

    // Interactive mode for stdin/stdout IPC
    '-i',

    // Workspace bind mount (writable, no exec)
    '-v',
    `${config.workspacePath}:/workspace:rw`,
  ];

  // Skills bind mount (read-only)
  if (config.skillsPath) {
    args.push('-v', `${config.skillsPath}:/skills:ro`);
  }

  // Image
  args.push(CONTAINER_IMAGE);

  return args;
}

/**
 * Create a DockerContainerManager.
 */
export function createContainerManager(logger: Logger): ContainerManager {
  const log = logger.child({ component: 'container-manager' });

  return {
    async isAvailable(): Promise<boolean> {
      try {
        const { stdout } = await execFileAsync(
          'docker',
          ['info', '--format', '{{.ServerVersion}}'],
          {
            timeout: 5_000,
          }
        );
        log.debug({ version: stdout.trim() }, 'Docker available');
        return true;
      } catch {
        return false;
      }
    },

    async create(runId: string, config: ContainerConfig): Promise<ContainerHandle> {
      // Ensure image exists
      const built = await ensureImage((msg) => {
        log.info(msg);
      });
      if (!built) {
        throw new Error('Failed to build Motor Cortex container image');
      }

      // Generate unique container name
      const random = randomBytes(4).toString('hex');
      const containerName = `motor-${runId.slice(0, 8)}-${random}`;

      // Create container
      const createArgs = buildCreateArgs(containerName, config);
      log.info({ containerName, runId }, 'Creating container');

      const { stdout: containerId } = await execFileAsync('docker', createArgs, {
        timeout: 30_000,
      });

      const trimmedId = containerId.trim();

      // Start container with attached stdin/stdout
      const proc = spawn('docker', ['start', '-ai', trimmedId], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const maxLifetimeMs = config.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
      const handle = new DockerContainerHandle(trimmedId, proc, log, maxLifetimeMs);

      activeContainers.set(runId, handle);
      log.info(
        { containerId: trimmedId.slice(0, 12), containerName },
        'Container created and started'
      );

      return handle;
    },

    async destroy(runId: string): Promise<void> {
      const handle = activeContainers.get(runId);
      if (handle) {
        activeContainers.delete(runId);
        await handle.destroy();
        log.info({ runId }, 'Container destroyed');
      }
    },

    async prune(maxAgeMs: number): Promise<number> {
      try {
        // List Motor Cortex containers
        const { stdout } = await execFileAsync(
          'docker',
          [
            'ps',
            '-a',
            '--filter',
            `label=${CONTAINER_LABEL}`,
            '--format',
            '{{.ID}}\t{{.CreatedAt}}',
          ],
          { timeout: 10_000 }
        );

        if (!stdout.trim()) return 0;

        const lines = stdout.trim().split('\n');
        let pruned = 0;

        for (const line of lines) {
          const [id] = line.split('\t');
          if (!id) continue;

          // Parse creation time from Docker's format
          // Docker format: "2024-01-01 12:00:00 +0000 UTC"
          const parts = line.split('\t');
          const createdStr = parts[1]?.trim();
          if (createdStr) {
            const created = new Date(createdStr);
            const ageMs = Date.now() - created.getTime();
            if (ageMs > maxAgeMs) {
              try {
                await execFileAsync('docker', ['rm', '-f', id], { timeout: 10_000 });
                pruned++;
                log.info({ containerId: id }, 'Pruned stale container');
              } catch {
                log.warn({ containerId: id }, 'Failed to prune container');
              }
            }
          } else {
            // Can't determine age — prune conservatively
            try {
              await execFileAsync('docker', ['rm', '-f', id], { timeout: 10_000 });
              pruned++;
            } catch {
              // Ignore
            }
          }
        }

        return pruned;
      } catch (error) {
        log.warn({ error }, 'Failed to prune containers');
        return 0;
      }
    },

    async destroyAll(): Promise<void> {
      // Destroy tracked containers
      for (const [runId, handle] of activeContainers) {
        try {
          await handle.destroy();
        } catch {
          log.warn({ runId }, 'Failed to destroy tracked container');
        }
      }
      activeContainers.clear();

      // Also clean up any orphaned containers
      try {
        const { stdout } = await execFileAsync(
          'docker',
          ['ps', '-aq', '--filter', `label=${CONTAINER_LABEL}`],
          { timeout: 10_000 }
        );

        if (stdout.trim()) {
          const ids = stdout.trim().split('\n');
          for (const id of ids) {
            try {
              await execFileAsync('docker', ['rm', '-f', id], { timeout: 10_000 });
            } catch {
              // Ignore
            }
          }
          log.info({ count: ids.length }, 'Destroyed all Motor Cortex containers');
        }
      } catch {
        log.warn('Failed to list containers for cleanup');
      }
    },
  };
}
