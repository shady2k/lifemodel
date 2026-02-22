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
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Logger } from '../../types/index.js';
import { APT_PACKAGE_NAME_REGEX, APT_VERSION_REGEX } from '../skills/skill-loader.js';
import {
  type ContainerConfig,
  type ContainerHandle,
  type ContainerManager,
  type ToolExecuteRequest,
  type ToolExecuteResponse,
  type ToolServerResponse,
  type ScriptContainerConfig,
  type ScriptContainerResult,
  FrameDecoder,
  encodeFrame,
  CONTAINER_LABEL,
  SCRIPT_CONTAINER_LABEL,
  DETACHED_CONTAINER_LABEL,
  CONTAINER_IMAGE,
  BROWSER_IMAGE,
  DEFAULT_MEMORY_LIMIT,
  DEFAULT_CPU_LIMIT,
  DEFAULT_PIDS_LIMIT,
  DEFAULT_MAX_LIFETIME_MS,
  REQUEST_TIMEOUT_BUFFER_MS,
  type DetachedContainerConfig,
  type DetachedContainerHandle,
} from './types.js';
import { ensureImage } from './container-image.js';
import { ensureBrowserImage, browserImageExists } from './browser-image.js';
import { ensureNetpolicyImage } from './netpolicy-image.js';
import { applyProxyNetworkPolicy } from './network-policy.js';
import { egressProxyManager } from './egress-proxy.js';

const execFileAsync = promisify(execFile);

// ─── Derived Apt Image ──────────────────────────────────────────

/** Schema version for derived apt images — bump to invalidate all cached images */
const APT_IMAGE_SCHEMA_VERSION = 1;

/** Docker label prefix for derived apt images */
const APT_IMAGE_LABEL = 'com.lifemodel.component=apt-deps';

/** Stale lock threshold for apt image builds (15 minutes) */
const APT_IMAGE_LOCK_STALE_MS = 15 * 60 * 1000;

/** Build timeout (10 minutes) */
const APT_IMAGE_BUILD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Ensure a derived Docker image with apt packages baked in.
 *
 * Uses a content-addressed hash to cache images: same packages + same base image
 * = same derived image. The image is built via `docker build` with a Dockerfile
 * that runs `apt-get install` inside the build context — packages are installed
 * normally by the package manager, avoiding the glibc conflicts that `dpkg -x`
 * extraction caused (two different glibc versions in one process).
 *
 * Security note: this runs full `apt-get install` (with postinst scripts) inside
 * the Docker build. We trust Debian's official repos — same trust boundary as
 * the `node:24-slim` base image.
 *
 * @returns The derived image name (e.g., `lifemodel-motor-apt-<hash>:latest`)
 */
export async function ensureAptImage(
  packages: { name: string; version: string }[],
  baseImage: string,
  cacheDir: string,
  logger: Logger
): Promise<string> {
  // ── Validate packages ──────────────────────────────────────────
  const seen = new Set<string>();
  for (const pkg of packages) {
    if (!APT_PACKAGE_NAME_REGEX.test(pkg.name)) {
      throw new Error(`Invalid apt package name: ${pkg.name}`);
    }
    if (!APT_VERSION_REGEX.test(pkg.version)) {
      throw new Error(`Invalid apt package version: ${pkg.version}`);
    }
    if (seen.has(pkg.name)) {
      throw new Error(`Duplicate apt package: ${pkg.name}`);
    }
    seen.add(pkg.name);
  }

  // ── Compute deterministic hash ─────────────────────────────────
  let baseImageId: string;
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['inspect', '--format', '{{.Id}}', baseImage],
      { timeout: 10_000 }
    );
    baseImageId = stdout.trim();
  } catch {
    baseImageId = 'unknown';
  }

  const sorted = [...packages].sort((a, b) => a.name.localeCompare(b.name));
  const canonical = JSON.stringify({
    schemaVersion: APT_IMAGE_SCHEMA_VERSION,
    packages: sorted.map((p) => ({ name: p.name, version: p.version })),
    baseImageId,
    platform: `${process.platform}-${process.arch}`,
  });
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  const derivedImage = `lifemodel-motor-apt-${hash}:latest`;

  // ── Cache check ────────────────────────────────────────────────
  const expectedLabels: Record<string, string> = {
    'com.lifemodel.component': 'apt-deps',
    'com.lifemodel.apt-hash': hash,
    'com.lifemodel.base-image-id': baseImageId,
    'com.lifemodel.schema-version': String(APT_IMAGE_SCHEMA_VERSION),
  };

  if (await imageMatchesLabels(derivedImage, expectedLabels)) {
    logger.info({ hash, derivedImage }, 'Apt image cache hit');
    return derivedImage;
  }

  // ── Acquire lock ───────────────────────────────────────────────
  await mkdir(cacheDir, { recursive: true });
  const lockPath = join(cacheDir, `apt-image-${hash}.lock`);
  const locked = await acquireAptImageLock(lockPath);
  if (!locked) {
    // Poll until the image appears or we timeout (builds can take 30-120s)
    logger.info({ hash }, 'Waiting for concurrent apt image build');
    const pollInterval = 5_000;
    const maxWait = APT_IMAGE_BUILD_TIMEOUT_MS;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      if (await imageMatchesLabels(derivedImage, expectedLabels)) {
        logger.info({ hash, derivedImage }, 'Apt image ready (built by concurrent process)');
        return derivedImage;
      }
      // If lock file is gone, the other build finished (or failed)
      if (!existsSync(lockPath)) break;
    }
    // Final check
    if (await imageMatchesLabels(derivedImage, expectedLabels)) {
      return derivedImage;
    }
    throw new Error('Concurrent apt image build did not complete');
  }

  try {
    // Double-check after acquiring lock
    if (await imageMatchesLabels(derivedImage, expectedLabels)) {
      logger.info({ hash, derivedImage }, 'Apt image cache hit (after lock)');
      return derivedImage;
    }

    // ── Build the image ────────────────────────────────────────────
    const pkgSpecs = sorted
      .map((p) => (p.version === 'latest' ? p.name : `${p.name}=${p.version}`))
      .join(' ');

    const dockerfile = [
      `FROM ${baseImage}`,
      'ARG DEBIAN_FRONTEND=noninteractive',
      'USER root',
      `RUN echo 'Package: *\\nPin: release a=unstable\\nPin-Priority: 100' > /etc/apt/preferences.d/unstable \\`,
      `    && echo 'deb http://deb.debian.org/debian unstable main' > /etc/apt/sources.list.d/unstable.list \\`,
      `    && apt-get update \\`,
      `    && apt-get install -y --no-install-recommends -t unstable ${pkgSpecs} \\`,
      `    && rm -rf /var/lib/apt/lists/*`,
      'USER node',
    ].join('\n');

    // Use empty temp dir as build context (not `.` which could send gigabytes)
    const contextDir = join(tmpdir(), `apt-build-${hash}`);
    await mkdir(contextDir, { recursive: true });

    logger.info(
      { hash, packageCount: packages.length, derivedImage },
      'Building derived apt image'
    );

    try {
      const buildArgs = [
        'build',
        '-t',
        derivedImage,
        '--label',
        APT_IMAGE_LABEL,
        '--label',
        `com.lifemodel.apt-hash=${hash}`,
        '--label',
        `com.lifemodel.base-image-id=${baseImageId}`,
        '--label',
        `com.lifemodel.schema-version=${String(APT_IMAGE_SCHEMA_VERSION)}`,
        '-f',
        '-', // Read Dockerfile from stdin
        contextDir,
      ];

      await new Promise<void>((resolve, reject) => {
        const proc = spawn('docker', buildArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stderr = '';
        proc.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        let stdout = '';
        proc.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });

        const timer = setTimeout(() => {
          proc.kill('SIGTERM');
          reject(
            new Error(
              `Apt image build timed out after ${String(APT_IMAGE_BUILD_TIMEOUT_MS / 1000)}s`
            )
          );
        }, APT_IMAGE_BUILD_TIMEOUT_MS);

        proc.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) {
            if (stdout) logger.debug({ output: stdout.slice(0, 1000) }, 'Apt image build stdout');
            resolve();
          } else {
            // Surface apt error from stderr for debugging
            const aptError = extractAptError(stderr);
            reject(
              new Error(
                `Apt image build failed (exit ${String(code)}): ${aptError || stderr.slice(-500)}`
              )
            );
          }
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });

        // Write Dockerfile to stdin
        proc.stdin?.write(dockerfile);
        proc.stdin?.end();
      });

      logger.info({ hash, derivedImage }, 'Derived apt image built successfully');
      return derivedImage;
    } finally {
      // Clean up context dir
      await rm(contextDir, { recursive: true, force: true }).catch(() => {
        /* best-effort */
      });
    }
  } finally {
    await releaseAptImageLock(lockPath);
  }
}

/**
 * Check if a Docker image exists and its labels match expected values.
 */
async function imageMatchesLabels(
  imageName: string,
  expected: Record<string, string>
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['inspect', '--format', '{{json .Config.Labels}}', imageName],
      { timeout: 10_000 }
    );
    const labels = JSON.parse(stdout.trim()) as Record<string, string> | null;
    if (!labels) return false;
    for (const [key, value] of Object.entries(expected)) {
      if (labels[key] !== value) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract the most useful apt error message from stderr.
 */
function extractAptError(stderr: string): string {
  // Look for apt-get error lines (E:) which are the most informative
  const lines = stderr.split('\n');
  const errorLines = lines.filter((l) => /^\s*E:\s/.test(l));
  if (errorLines.length > 0) {
    return errorLines.join('\n').trim();
  }
  return '';
}

/**
 * Acquire a file lock for apt image builds.
 */
async function acquireAptImageLock(lockPath: string): Promise<boolean> {
  try {
    if (existsSync(lockPath)) {
      const s = await stat(lockPath);
      if (Date.now() - s.mtimeMs > APT_IMAGE_LOCK_STALE_MS) {
        await rm(lockPath, { force: true });
      } else {
        return false;
      }
    }
    await writeFile(lockPath, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Release an apt image build lock.
 */
async function releaseAptImageLock(lockPath: string): Promise<void> {
  try {
    await rm(lockPath, { force: true });
  } catch {
    // Best-effort
  }
}

/**
 * Cached host-gateway IP (resolved once per process lifetime).
 * On Docker Desktop / OrbStack this is a special IP (e.g. 0.250.250.254) that
 * routes from containers to the macOS host. On Linux Docker, it equals the
 * bridge gateway. Used for iptables ACCEPT rules on the egress proxy port.
 */
let cachedHostGatewayIp: string | null = null;

/**
 * Resolve the host-gateway IP that containers use to reach the host process.
 *
 * Uses a short-lived container with `--add-host host.docker.internal:host-gateway`
 * to let Docker/OrbStack resolve the platform-specific IP. Cached after first call
 * (~1-2s overhead only on first script run per process).
 *
 * - OrbStack on macOS: 0.250.250.254
 * - Docker Desktop on macOS: 192.168.65.254 (varies)
 * - Linux Docker: bridge gateway (e.g. 172.17.0.1)
 */
async function resolveHostGatewayIp(log: Logger): Promise<string> {
  if (cachedHostGatewayIp) return cachedHostGatewayIp;

  const { stdout } = await execFileAsync(
    'docker',
    [
      'run',
      '--rm',
      '--add-host',
      'host.docker.internal:host-gateway',
      'node:24-slim',
      'cat',
      '/etc/hosts',
    ],
    { timeout: 15_000 }
  );

  // Parse: "0.250.250.254\thost.docker.internal"
  let ip: string | null = null;
  for (const line of stdout.split('\n')) {
    if (line.includes('host.docker.internal')) {
      ip = line.split(/\s+/)[0]?.trim() || null;
      break;
    }
  }

  // Fallback: bridge network gateway (Linux Docker where bridge gateway = host)
  if (!ip) {
    const { stdout: networkInspect } = await execFileAsync(
      'docker',
      ['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}'],
      { timeout: 10_000 }
    );
    ip = networkInspect.trim() || null;
    log.debug({ ip, source: 'bridge-fallback' }, 'Host-gateway IP (bridge fallback)');
  }

  if (!ip) {
    throw new Error('Could not determine host-gateway IP for egress proxy');
  }

  log.info({ hostGatewayIp: ip }, 'Host-gateway IP resolved');
  cachedHostGatewayIp = ip;
  return ip;
}

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
  private readonly volumeName: string;

  constructor(
    containerId: string,
    volumeName: string,
    proc: ReturnType<typeof spawn>,
    logger: Logger,
    maxLifetimeMs: number
  ) {
    this.containerId = containerId;
    this.volumeName = volumeName;
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

  async deliverCredential(name: string, value: string): Promise<void> {
    if (this.destroyed) return;

    const frame = encodeFrame({ type: 'credential', name, value });
    this.process.stdin?.write(frame);

    // Best-effort — don't wait for ack (credential delivery is fire-and-forget)
    // The tool-server will ack on its timeline
    return Promise.resolve();
  }

  async copyWorkspaceOut(hostDir: string): Promise<void> {
    // Copy workspace files from container to host directory.
    // Works on stopped containers (docker cp doesn't require running state).
    this.logger.debug({ hostDir }, 'Copying workspace out of container');

    try {
      await execFileAsync('docker', ['cp', `${this.containerId}:/workspace/.`, hostDir], {
        timeout: 60_000,
      });
      this.logger.info({ hostDir }, 'Workspace copied out');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ hostDir, error: message }, 'Failed to copy workspace out');
      throw new Error(`Failed to copy workspace out: ${message}`);
    }
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

    // Remove workspace volume (independent of container removal)
    if (this.volumeName) {
      try {
        await execFileAsync('docker', ['volume', 'rm', this.volumeName], {
          timeout: 10_000,
        });
        this.logger.debug({ volumeName: this.volumeName }, 'Workspace volume removed');
      } catch {
        // Volume may already be gone or still in use
      }
    }

    // Kill process if still alive
    if (!this.process.killed) {
      this.process.kill('SIGKILL');
    }
  }
}

/**
 * Build the `docker create` arguments with all security flags.
 *
 * Network mode selection:
 * - No allowedDomains → --network none (default, most secure)
 * - Has allowedDomains → --network bridge with egress proxy
 *
 * @param containerName - Container name
 * @param config - Container configuration
 * @param proxyPort - Egress proxy port (null if no network)
 */
function buildCreateArgs(
  containerName: string,
  config: ContainerConfig,
  proxyPort: number | null,
  image?: string
): string[] {
  const memoryLimit = config.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
  const cpuLimit = config.cpuLimit ?? DEFAULT_CPU_LIMIT;
  const pidsLimit = config.pidsLimit ?? DEFAULT_PIDS_LIMIT;

  const hasDomains = proxyPort !== null;

  const args: string[] = [
    'create',
    '--name',
    containerName,
    '--label',
    CONTAINER_LABEL,

    // Security flags
    '--read-only',
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
  ];

  // Network configuration
  if (hasDomains) {
    // Bridge mode with egress proxy
    args.push('--network', 'bridge');

    // Block normal DNS (defense-in-depth against tools bypassing proxy)
    args.push('--dns', '127.0.0.1');

    // Disable IPv6 (simplifies iptables rules)
    args.push('--sysctl', 'net.ipv6.conf.all.disable_ipv6=1');

    // Enable host.docker.internal (proxy runs on host)
    args.push('--add-host', 'host.docker.internal:host-gateway');

    // Proxy environment variables — tools using standard HTTP libraries will route through proxy
    const proxyUrl = `http://host.docker.internal:${String(proxyPort)}`;
    args.push('-e', `HTTP_PROXY=${proxyUrl}`);
    args.push('-e', `HTTPS_PROXY=${proxyUrl}`);
    args.push('-e', `http_proxy=${proxyUrl}`);
    args.push('-e', `https_proxy=${proxyUrl}`);
    args.push('-e', 'NO_PROXY=localhost,127.0.0.1');
    args.push('-e', 'no_proxy=localhost,127.0.0.1');
  } else {
    // No network access (default, most secure)
    args.push('--network', 'none');
  }

  // Workspace: named volume mount (no host filesystem access)
  // Docker pre-populates from image's /workspace (owned by node:node)
  // Validate volume name format: only alphanumeric, hyphens, underscores allowed
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(config.volumeName)) {
    throw new Error(`Invalid volume name: ${config.volumeName}`);
  }
  args.push('--mount', `type=volume,src=${config.volumeName},dst=/workspace`);

  // Run as node user (UID/GID 1000) for deterministic ownership
  args.push('--user', '1000:1000');

  // Extra named volume mounts (e.g. pre-installed dependency packs)
  // Defense-in-depth: validate hostPath is a Docker volume name (not a host path).
  // Docker volume names: alphanumeric, hyphens, underscores, dots. No slashes, dots-only, or tildes.
  // Any path-like value (absolute, relative, ~) would create a host bind mount.
  if (config.extraMounts) {
    for (const mount of config.extraMounts) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(mount.hostPath)) {
        throw new Error(
          `extraMounts.hostPath must be a Docker volume name, not a path: ${mount.hostPath}`
        );
      }
      args.push('-v', `${mount.hostPath}:${mount.containerPath}:${mount.mode}`);
    }
  }

  // Extra environment variables (e.g. NODE_PATH, PYTHONPATH)
  if (config.extraEnv) {
    for (const [key, value] of Object.entries(config.extraEnv)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Image
  args.push(image ?? CONTAINER_IMAGE);

  return args;
}

/**
 * Build `docker create` args for a script container.
 *
 * Key differences from agentic buildCreateArgs():
 * - No workspace volume mount
 * - Custom entrypoint (not tool-server)
 * - SCRIPT_INPUTS env var with JSON inputs
 * - Uses SCRIPT_CONTAINER_LABEL for identification
 * - Optional profile volume mount
 *
 * @param containerName - Container name
 * @param config - Script container configuration
 * @param proxyPort - Egress proxy port (null if no network)
 */
function buildScriptCreateArgs(
  containerName: string,
  config: ScriptContainerConfig,
  proxyPort: number | null
): string[] {
  const hasDomains = proxyPort !== null;

  const args: string[] = [
    'create',
    '--name',
    containerName,
    '--label',
    SCRIPT_CONTAINER_LABEL,

    // Security flags
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',

    // Resource limits
    '--pids-limit',
    String(config.pidsLimit ?? 64),
    '--memory',
    config.memoryLimit ?? '512m',
    '--cpus',
    '1.0',

    // Writable temp
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
  ];

  // Network configuration
  if (hasDomains) {
    args.push('--network', 'bridge');
    args.push('--dns', '127.0.0.1');
    args.push('--sysctl', 'net.ipv6.conf.all.disable_ipv6=1');

    // Enable host.docker.internal (proxy runs on host)
    args.push('--add-host', 'host.docker.internal:host-gateway');

    // Proxy environment variables — host.docker.internal is the only address that routes
    // to the macOS host from Docker Desktop containers. The bridge gateway (192.168.x.1)
    // stays inside the Linux VM and can't reach host processes.
    const proxyUrl = `http://host.docker.internal:${String(proxyPort)}`;
    args.push('-e', `HTTP_PROXY=${proxyUrl}`);
    args.push('-e', `HTTPS_PROXY=${proxyUrl}`);
    args.push('-e', `http_proxy=${proxyUrl}`);
    args.push('-e', `https_proxy=${proxyUrl}`);
    args.push('-e', 'NO_PROXY=localhost,127.0.0.1');
    args.push('-e', 'no_proxy=localhost,127.0.0.1');

    // Tell the script to block on stdin until we send "ready" after iptables are applied.
    args.push('-e', 'WAIT_FOR_READY=1');
  } else {
    args.push('--network', 'none');
  }

  // Extra tmpfs mounts (e.g., /dev/shm for Chromium)
  if (config.tmpfs) {
    for (const mount of config.tmpfs) {
      args.push('--tmpfs', mount);
    }
  }

  // Profile volume mount (e.g., browser profile)
  if (config.profileMount) {
    const { volumeName, containerPath, mode } = config.profileMount;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(volumeName)) {
      throw new Error(`Invalid profile volume name: ${volumeName}`);
    }
    args.push('-v', `${volumeName}:${containerPath}:${mode}`);
  }

  // Run as unprivileged user (default UID 1000, configurable for images with different UIDs)
  args.push('--user', config.user ?? '1000:1000');

  // Environment: SCRIPT_INPUTS
  args.push('-e', `SCRIPT_INPUTS=${config.inputsJson}`);

  // Extra environment variables
  if (config.extraEnv) {
    for (const [key, value] of Object.entries(config.extraEnv)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Entrypoint override (must come before image)
  // docker create syntax: docker create [OPTIONS] IMAGE [COMMAND] [ARG...]
  // --entrypoint sets the binary, remaining args are the CMD
  const [entryBinary, ...entryArgs] = config.entrypoint;
  if (entryBinary) {
    args.push('--entrypoint', entryBinary);
  }

  // Image
  args.push(config.image);

  // Command args (after image)
  args.push(...entryArgs);

  return args;
}

/**
 * Create a DockerContainerManager.
 */
export function createContainerManager(logger: Logger): ContainerManager {
  const log = logger.child({ component: 'container-manager' });

  // Wire logger to egress proxy singleton for request-level diagnostics
  egressProxyManager.setLogger(logger);

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
      // Ensure images exist
      const built = await ensureImage((msg) => {
        log.info(msg);
      });
      if (!built) {
        throw new Error('Failed to build Motor Cortex container image');
      }

      // Build derived apt image if packages declared (before proxy/volume so failure is cheap)
      let derivedImage: string | undefined;
      if (config.aptPackages && config.aptPackages.length > 0) {
        const aptCacheDir = join('data', 'dependency-cache');
        derivedImage = await ensureAptImage(config.aptPackages, CONTAINER_IMAGE, aptCacheDir, log);
        log.info({ runId, derivedImage }, 'Using derived apt image');
      }

      let hasDomains = config.allowedDomains && config.allowedDomains.length > 0;
      let proxyPort: number | null = null;

      if (hasDomains) {
        // Ensure netpolicy helper image exists (still needed for iptables)
        const netpolicyBuilt = await ensureNetpolicyImage((msg) => {
          log.info(msg);
        });
        if (!netpolicyBuilt) {
          // Degrade gracefully: fall back to --network none instead of crashing.
          // The task loses network access but can still use filesystem/code tools.
          log.warn(
            { runId },
            'Network policy helper image failed to build — falling back to --network none (no network access)'
          );
          hasDomains = false;
        }

        if (hasDomains) {
          // Allocate egress proxy for this run
          try {
            const alloc = await egressProxyManager.allocate(
              runId,
              config.allowedDomains ?? [],
              config.allowedPorts
            );
            proxyPort = alloc.port;
            log.info(
              {
                runId,
                proxyPort,
                domains: config.allowedDomains,
              },
              'Egress proxy allocated'
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to allocate egress proxy: ${message}`);
          }
        }
      }

      // Generate unique container name
      const random = randomBytes(4).toString('hex');
      const containerName = `motor-${runId.slice(0, 8)}-${random}`;

      // Create named volume for workspace isolation
      const volumeName = config.volumeName;
      log.debug({ volumeName }, 'Creating workspace volume');
      try {
        await execFileAsync('docker', ['volume', 'create', volumeName], { timeout: 10_000 });
      } catch (error) {
        // Clean up proxy on volume creation failure
        if (proxyPort !== null) {
          await egressProxyManager.release(runId).catch(() => {
            /* best-effort cleanup */
          });
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to create workspace volume: ${message}`);
      }

      // Create container with proxy env vars (no more --add-host per domain)
      const createArgs = buildCreateArgs(containerName, config, proxyPort, derivedImage);
      log.info(
        {
          containerName,
          runId,
          volumeName,
          hasDomains,
          proxyPort,
          extraMounts: config.extraMounts,
          extraEnv: config.extraEnv,
        },
        'Creating container'
      );

      let trimmedId: string;
      try {
        const { stdout: containerId } = await execFileAsync('docker', createArgs, {
          timeout: 30_000,
        });
        trimmedId = containerId.trim();
      } catch (error) {
        // Clean up volume and proxy on docker create failure
        if (proxyPort !== null) {
          await egressProxyManager.release(runId).catch(() => {
            /* best-effort cleanup */
          });
        }
        try {
          await execFileAsync('docker', ['volume', 'rm', volumeName], { timeout: 10_000 });
        } catch {
          // Best-effort cleanup
        }
        throw error;
      }

      // Copy workspace files into container via tar pipe
      // This must happen AFTER container creation but BEFORE starting
      log.debug(
        { containerId: trimmedId.slice(0, 12), workspacePath: config.workspacePath },
        'Copying workspace into container'
      );
      try {
        // Use tar with ownership flags to ensure files are owned by node (1000:1000)
        // COPYFILE_DISABLE=1 prevents macOS ._ metadata artifacts
        await new Promise<void>((resolve, reject) => {
          const tar = spawn(
            'tar',
            ['-C', config.workspacePath, '-cf', '-', '--owner=1000', '--group=1000', '.'],
            {
              env: { ...process.env, COPYFILE_DISABLE: '1' },
            }
          );

          const dockerCp = spawn('docker', ['cp', '-a', '-', `${trimmedId}:/workspace/`]);

          tar.stdout.pipe(dockerCp.stdin);

          let tarExitCode: number | null = null;
          let dockerCpExitCode: number | null = null;
          let dockerCpStderr = '';
          dockerCp.stderr.on('data', (data: Buffer) => {
            dockerCpStderr += data.toString();
          });

          // Wait for BOTH processes to close before resolving/rejecting.
          // tar closes first (producer), then dockerCp closes (consumer),
          // but event delivery order isn't guaranteed.
          const checkDone = () => {
            if (tarExitCode === null || dockerCpExitCode === null) return; // Still waiting
            if (tarExitCode !== 0) {
              reject(
                new Error(`tar failed (exit ${String(tarExitCode)}): workspace may be incomplete`)
              );
            } else if (dockerCpExitCode !== 0) {
              reject(
                new Error(`docker cp failed (exit ${String(dockerCpExitCode)}): ${dockerCpStderr}`)
              );
            } else {
              resolve();
            }
          };

          tar.on('close', (code) => {
            tarExitCode = code;
            checkDone();
          });
          dockerCp.on('close', (code) => {
            dockerCpExitCode = code;
            checkDone();
          });

          tar.on('error', reject);
          dockerCp.on('error', reject);
        });
        log.debug({ containerId: trimmedId.slice(0, 12) }, 'Workspace copied into container');
      } catch (error) {
        // Cleanup on failure
        const message = error instanceof Error ? error.message : String(error);
        log.error(
          { containerId: trimmedId.slice(0, 12), error: message },
          'Failed to copy workspace into container'
        );
        if (proxyPort !== null) {
          await egressProxyManager.release(runId).catch(() => {
            /* best-effort cleanup */
          });
        }
        try {
          await execFileAsync('docker', ['rm', '-f', trimmedId], { timeout: 10_000 });
          await execFileAsync('docker', ['volume', 'rm', volumeName], { timeout: 10_000 });
        } catch {
          // Best-effort cleanup
        }
        throw new Error(`Failed to copy workspace into container: ${message}`);
      }

      if (hasDomains && proxyPort !== null) {
        // Stdin-gated flow for proxy-based network policy application.
        //
        // Previously this used detached start → pause → iptables → unpause → attach,
        // which had a race condition: the container could exit before pause if
        // Docker closed stdin in detached mode, causing "container is not running".
        //
        // New flow (matches runScript()):
        //   1. `docker start -ai` — attach stdin+stdout immediately (no race)
        //   2. Tool-server blocks on WAIT_FOR_READY stdin gate
        //   3. Apply iptables while tool-server is blocked
        //   4. Write "ready\n" → tool-server starts processing IPC frames
        const shortId = trimmedId.slice(0, 12);
        log.debug(
          { containerId: shortId },
          'Starting container with stdin gate (docker start -ai)'
        );

        const proc = spawn('docker', ['start', '-ai', trimmedId], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Listen for early exit (container crash before we finish setup)
        let earlyExit = false;
        let earlyExitCode: number | null = null;
        let earlyExitSignal: string | null = null;
        const earlyExitPromise = new Promise<void>((resolve) => {
          proc.on('exit', (code, signal) => {
            earlyExit = true;
            earlyExitCode = code;
            earlyExitSignal = signal;
            log.warn(
              { containerId: shortId, code, signal },
              'Container exited during network policy setup'
            );
            resolve();
          });
        });

        // Collect stderr for diagnostics
        let stderrOutput = '';
        proc.stderr?.on('data', (chunk: Buffer) => {
          stderrOutput += chunk.toString();
        });

        try {
          // Wait briefly for the container to start (or crash)
          await Promise.race([
            new Promise((resolve) => setTimeout(resolve, 500)),
            earlyExitPromise,
          ]);

          if (earlyExit) {
            throw new Error(
              `Container exited immediately (code: ${String(earlyExitCode)}, signal: ${String(earlyExitSignal)})` +
                (stderrOutput ? `. stderr: ${stderrOutput.slice(0, 500)}` : '')
            );
          }

          // Container is running, tool-server is blocked on WAIT_FOR_READY.
          // Apply network policy while it's gated.
          log.debug({ containerId: shortId }, 'Container started, applying network policy');

          const gatewayIp = await resolveHostGatewayIp(log);
          await applyProxyNetworkPolicy(trimmedId, { gatewayIp, proxyPort }, log);

          if (earlyExit) {
            throw new Error('Container exited during network policy application');
          }

          // Ungate: write "ready\n" so tool-server starts IPC
          log.debug({ containerId: shortId }, 'Network policy applied, sending ready signal');
          proc.stdin?.write('ready\n');
        } catch (error) {
          // Cleanup on failure
          const message = error instanceof Error ? error.message : String(error);
          log.error(
            { containerId: shortId, error: message, stderr: stderrOutput.slice(0, 500) },
            'Network policy setup failed, destroying container'
          );
          // Kill the process if still running
          if (!earlyExit) {
            proc.stdin?.end();
            proc.kill('SIGKILL');
          }
          await egressProxyManager.release(runId).catch(() => {
            /* best-effort cleanup */
          });
          try {
            await execFileAsync('docker', ['rm', '-f', trimmedId], { timeout: 10_000 });
          } catch {
            // Best-effort cleanup
          }
          try {
            await execFileAsync('docker', ['volume', 'rm', volumeName], { timeout: 10_000 });
          } catch {
            // Best-effort cleanup
          }
          throw new Error(`Failed to set up network policy: ${message}`);
        }

        const maxLifetimeMs = config.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
        const handle = new DockerContainerHandle(trimmedId, volumeName, proc, log, maxLifetimeMs);

        activeContainers.set(runId, handle);
        log.info(
          {
            containerId: shortId,
            containerName,
            domains: config.allowedDomains,
            proxyPort,
          },
          'Container created with egress proxy'
        );

        return handle;
      } else {
        // No domains: use original flow (docker start -ai, no network policy needed)
        log.debug(
          { containerId: trimmedId.slice(0, 12) },
          'Starting container (docker start -ai, no network)'
        );
        const proc = spawn('docker', ['start', '-ai', trimmedId], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const maxLifetimeMs = config.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
        const handle = new DockerContainerHandle(trimmedId, volumeName, proc, log, maxLifetimeMs);

        activeContainers.set(runId, handle);
        log.info(
          { containerId: trimmedId.slice(0, 12), containerName },
          'Container created and started (no network)'
        );

        return handle;
      }
    },

    async destroy(runId: string): Promise<void> {
      const handle = activeContainers.get(runId);
      if (handle) {
        activeContainers.delete(runId);
        await handle.destroy();
        log.info({ runId }, 'Container destroyed');
      }
      // Release egress proxy (no-op if not allocated)
      await egressProxyManager.release(runId);
    },

    async prune(maxAgeMs: number): Promise<number> {
      let pruned = 0;

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

        if (stdout.trim()) {
          const lines = stdout.trim().split('\n');

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
        }
      } catch (error) {
        log.warn({ error }, 'Failed to prune containers');
      }

      // Prune stale script containers (label-based)
      try {
        const { stdout: scriptStdout } = await execFileAsync(
          'docker',
          ['ps', '-a', '--filter', `label=${SCRIPT_CONTAINER_LABEL}`, '--format', '{{.ID}}'],
          { timeout: 10_000 }
        );
        if (scriptStdout.trim()) {
          const ids = scriptStdout.trim().split('\n');
          for (const id of ids) {
            try {
              await execFileAsync('docker', ['rm', '-f', id], { timeout: 10_000 });
              pruned++;
              log.info({ containerId: id }, 'Pruned stale script container');
            } catch {
              // Ignore
            }
          }
        }
      } catch (error) {
        log.warn({ error }, 'Failed to prune script containers');
      }

      // Prune stopped detached containers (browser-auth)
      try {
        const { stdout: detachedOut } = await execFileAsync(
          'docker',
          [
            'ps',
            '-a',
            '--filter',
            `label=${DETACHED_CONTAINER_LABEL}`,
            '--filter',
            'status=exited',
            '--format',
            '{{.ID}}',
          ],
          { timeout: 10_000 }
        );
        if (detachedOut.trim()) {
          for (const id of detachedOut.trim().split('\n')) {
            try {
              await execFileAsync('docker', ['rm', '-f', id], { timeout: 10_000 });
              pruned++;
              log.info({ containerId: id }, 'Pruned stopped browser-auth container');
            } catch {
              // Ignore
            }
          }
        }
      } catch (error) {
        log.warn({ error }, 'Failed to prune detached containers');
      }

      // Prune dangling derived apt images (only those not referenced by any container).
      // docker rmi without --force fails if the image is in use — safe to attempt.
      // We don't prune by age here to preserve the cache. Manual cleanup: `docker rmi $(docker images --filter label=com.lifemodel.component=apt-deps -q)`.
      try {
        const { stdout: aptImages } = await execFileAsync(
          'docker',
          [
            'images',
            '--filter',
            `label=${APT_IMAGE_LABEL}`,
            '--filter',
            'dangling=true',
            '--format',
            '{{.ID}}',
          ],
          { timeout: 10_000 }
        );
        if (aptImages.trim()) {
          for (const imgId of aptImages.trim().split('\n')) {
            try {
              await execFileAsync('docker', ['rmi', imgId], { timeout: 10_000 });
              pruned++;
              log.info({ imageId: imgId }, 'Pruned dangling apt image');
            } catch {
              // Image is in use or already gone — skip
            }
          }
        }
      } catch (error) {
        log.warn({ error }, 'Failed to prune apt images');
      }

      // Prune orphaned volumes: motor-ws-* and lifemodel-deps-*
      try {
        const { stdout: volumeList } = await execFileAsync(
          'docker',
          ['volume', 'ls', '--format', '{{.Name}}'],
          { timeout: 10_000 }
        );

        if (volumeList.trim()) {
          const volumes = volumeList.trim().split('\n');
          const orphanCandidates = volumes.filter(
            (v) => v.startsWith('motor-ws-') || v.startsWith('lifemodel-deps-')
          );

          for (const vol of orphanCandidates) {
            try {
              // docker volume rm fails if volume is in use — safe to attempt
              await execFileAsync('docker', ['volume', 'rm', vol], { timeout: 10_000 });
              pruned++;
              log.info({ volumeName: vol }, 'Pruned orphaned volume');
            } catch {
              // Volume is in use or already gone — skip
            }
          }
        }
      } catch (error) {
        log.warn({ error }, 'Failed to prune orphaned volumes');
      }

      return pruned;
    },

    async runScript(
      runId: string,
      config: ScriptContainerConfig,
      timeoutMs: number
    ): Promise<ScriptContainerResult> {
      // Ensure image exists
      if (config.image === CONTAINER_IMAGE) {
        const built = await ensureImage((msg) => {
          log.info(msg);
        });
        if (!built) {
          throw new Error('Failed to build Motor Cortex container image');
        }
      }
      if (config.image === BROWSER_IMAGE) {
        const built = await ensureBrowserImage((msg) => {
          log.info(msg);
        });
        if (!built) {
          throw new Error('Failed to build browser container image');
        }
      }

      let hasDomains = config.allowedDomains && config.allowedDomains.length > 0;
      let proxyPort: number | null = null;

      if (hasDomains) {
        const netpolicyBuilt = await ensureNetpolicyImage((msg) => {
          log.info(msg);
        });
        if (!netpolicyBuilt) {
          log.warn(
            { runId },
            'Network policy helper failed — falling back to --network none for script'
          );
          // Clear domains so buildScriptCreateArgs uses --network none
          config = { ...config, allowedDomains: undefined };
          hasDomains = false;
        } else {
          try {
            const alloc = await egressProxyManager.allocate(runId, config.allowedDomains ?? []);
            proxyPort = alloc.port;
            log.info({ runId, proxyPort }, 'Egress proxy allocated for script');
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to allocate egress proxy for script: ${message}`);
          }
        }
      }

      // Generate container name
      const random = randomBytes(4).toString('hex');
      const containerName = `script-${runId.slice(0, 8)}-${random}`;

      const createArgs = buildScriptCreateArgs(containerName, config, proxyPort);
      log.info(
        { containerName, runId, image: config.image, hasDomains, proxyPort },
        'Creating script container'
      );

      let containerId: string;
      try {
        const { stdout } = await execFileAsync('docker', createArgs, { timeout: 30_000 });
        containerId = stdout.trim();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to create script container: ${message}`);
      }

      const shortId = containerId.slice(0, 12);

      try {
        // Stdin-gate flow for network-policy containers:
        //   1. `docker start -ai` attaches stdin+stdout before the process starts
        //   2. Script blocks reading stdin (WAIT_FOR_READY=1 env var)
        //   3. We apply proxy iptables while the script is blocked
        //   4. Write "ready\n" to stdin → script proceeds with network locked down to proxy
        // For no-network containers: `docker start -a` (no stdin needed).
        const needsStdinGate = hasDomains && proxyPort !== null;
        const attachArgs = needsStdinGate
          ? ['start', '-ai', containerId]
          : ['start', '-a', containerId];

        const { exitCode, stdout } = await new Promise<{ exitCode: number; stdout: string }>(
          (resolve) => {
            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];
            let settled = false;

            const proc = spawn('docker', attachArgs, {
              stdio: [needsStdinGate ? 'pipe' : 'ignore', 'pipe', 'pipe'],
            });

            proc.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
            proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

            // Resolve host-gateway IP (ephemeral container, cached), apply iptables, then ungate.
            // Container is running but blocked on stdin (WAIT_FOR_READY=1).
            if (needsStdinGate && proxyPort !== null) {
              resolveHostGatewayIp(log)
                .then((gatewayIp) =>
                  applyProxyNetworkPolicy(containerId, { gatewayIp, proxyPort }, log)
                )
                .then(() => {
                  proc.stdin?.write('ready\n');
                  proc.stdin?.end();
                })
                .catch((err: unknown) => {
                  if (settled) return;
                  settled = true;
                  const message = err instanceof Error ? err.message : String(err);
                  log.error({ containerId: shortId, error: message }, 'Network policy failed');
                  proc.kill('SIGTERM');
                  resolve({ exitCode: -1, stdout: '' });
                });
            }

            const timer = setTimeout(() => {
              if (settled) return;
              settled = true;
              log.warn({ containerId: shortId, timeoutMs }, 'Script timed out');
              proc.kill('SIGTERM');
              execFileAsync('docker', ['rm', '-f', containerId], { timeout: 10_000 }).catch(
                (_e: unknown) => {
                  /* best effort */
                }
              );
              resolve({ exitCode: -1, stdout: '' });
            }, timeoutMs);

            proc.on('close', (code) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              const rawStderr = Buffer.concat(stderrChunks).toString('utf8').trim();
              if (rawStderr) {
                // Log at warn if script failed, debug if succeeded — crash diagnostics need visibility
                const level = (code ?? 0) !== 0 || rawStderr.includes('[CRASH]') ? 'warn' : 'debug';
                log[level](
                  { containerId: shortId, stderr: rawStderr.slice(0, 2000) },
                  'Script stderr'
                );
              }
              resolve({
                exitCode: code ?? 0,
                stdout: Buffer.concat(stdoutChunks).toString('utf8'),
              });
            });

            proc.on('error', (err) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              log.warn({ containerId: shortId, error: err.message }, 'Script attach failed');
              resolve({ exitCode: -1, stdout: '' });
            });
          }
        );

        log.info(
          {
            containerId: shortId,
            exitCode,
            stdoutLength: stdout.length,
            stdout: stdout.slice(0, 2000),
          },
          'Script container finished'
        );

        return { exitCode, stdout };
      } finally {
        // Always clean up the container and proxy
        try {
          await execFileAsync('docker', ['rm', '-f', containerId], { timeout: 10_000 });
        } catch {
          // Container may already be gone (timeout path)
        }
        await egressProxyManager.release(runId);
      }
    },

    async startDetached(config: DetachedContainerConfig): Promise<DetachedContainerHandle> {
      // Fast check — don't build the image inline (it downloads ~1.5GB and blocks cognition).
      // The browser image must be pre-built via `npm run browser:auth`.
      if (config.image === BROWSER_IMAGE) {
        const exists = await browserImageExists();
        if (!exists) {
          throw new Error(
            'Browser container image not found. Build it first by running: npm run browser:auth <profile> <url>'
          );
        }
      }

      // Ensure volumes exist
      if (config.volumes) {
        for (const vol of config.volumes) {
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(vol.name)) {
            throw new Error(`Invalid volume name: ${vol.name}`);
          }
          await execFileAsync('docker', ['volume', 'create', vol.name], { timeout: 10_000 });
        }
      }

      const args: string[] = ['run', '-d', '--label', DETACHED_CONTAINER_LABEL];

      // Volume mounts
      if (config.volumes) {
        for (const vol of config.volumes) {
          args.push('-v', `${vol.name}:${vol.containerPath}:${vol.mode}`);
        }
      }

      // Port mappings (bind to localhost only)
      // hostPort=0 means dynamic allocation — Docker picks a free port
      const containerPorts: number[] = [];
      if (config.ports) {
        for (const [hostPort, containerPort] of Object.entries(config.ports)) {
          args.push('-p', `127.0.0.1:${hostPort}:${String(containerPort)}`);
          containerPorts.push(containerPort);
        }
      }

      // Tmpfs mounts
      if (config.tmpfs) {
        for (const mount of config.tmpfs) {
          args.push('--tmpfs', mount);
        }
      }

      // Environment variables
      if (config.env) {
        for (const [key, value] of Object.entries(config.env)) {
          args.push('-e', `${key}=${value}`);
        }
      }

      // Entrypoint
      const [entryBinary, ...entryArgs] = config.entrypoint;
      if (entryBinary) {
        args.push('--entrypoint', entryBinary);
      }

      // Image
      args.push(config.image);

      // Command args
      args.push(...entryArgs);

      log.info({ image: config.image, ports: config.ports }, 'Starting detached container');

      const { stdout } = await execFileAsync('docker', args, { timeout: 30_000 });
      const containerId = stdout.trim();

      // Resolve actual port mappings (needed for dynamic allocation)
      const portMap: Record<number, number> = {};
      for (const containerPort of containerPorts) {
        try {
          const { stdout: portOut } = await execFileAsync(
            'docker',
            ['port', containerId, String(containerPort)],
            { timeout: 5_000 }
          );
          // Output format: "0.0.0.0:XXXXX" or "127.0.0.1:XXXXX"
          const match = /:(\d+)$/.exec(portOut.trim());
          if (match) {
            portMap[containerPort] = Number(match[1]);
          }
        } catch {
          log.warn(
            { containerId: containerId.slice(0, 12), containerPort },
            'Failed to resolve mapped port'
          );
        }
      }

      log.info(
        { containerId: containerId.slice(0, 12), ports: portMap },
        'Detached container started'
      );

      return { containerId, ports: portMap };
    },

    async stopDetached(containerId: string): Promise<void> {
      log.info({ containerId: containerId.slice(0, 12) }, 'Stopping detached container');
      try {
        await execFileAsync('docker', ['stop', containerId], { timeout: 30_000 });
      } catch {
        // Container may already be stopped
      }
      try {
        await execFileAsync('docker', ['rm', '-f', containerId], { timeout: 10_000 });
      } catch {
        // Container may already be gone
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

      // Release all egress proxies
      await egressProxyManager.releaseAll();

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

      // Also clean up detached containers (browser auth)
      try {
        const { stdout: detachedStdout } = await execFileAsync(
          'docker',
          ['ps', '-aq', '--filter', `label=${DETACHED_CONTAINER_LABEL}`],
          { timeout: 10_000 }
        );

        if (detachedStdout.trim()) {
          const ids = detachedStdout.trim().split('\n');
          for (const id of ids) {
            try {
              await execFileAsync('docker', ['rm', '-f', id], { timeout: 10_000 });
            } catch {
              // Ignore
            }
          }
          log.info({ count: ids.length }, 'Destroyed all detached containers');
        }
      } catch {
        log.warn('Failed to list detached containers for cleanup');
      }
    },
  };
}
