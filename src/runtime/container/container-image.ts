/**
 * Container Image Builder
 *
 * Builds the Motor Cortex Docker image lazily on first use.
 * Image contains Alpine + Node 24 + shell tools + tool-server.
 *
 * ~50MB image with non-root user 'motor' (UID 1000).
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { copyFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { CONTAINER_IMAGE } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Dockerfile as string literal — no external file needed.
 *
 * Security-hardened:
 * - Non-root user 'motor' (UID 1000)
 * - Minimal package set
 * - No package cache retained
 */
/**
 * Build a Dockerfile string with an embedded source hash label.
 * The label allows `ensureImage()` to detect stale images when source changes.
 */
export function buildDockerfile(sourceHash: string): string {
  return `
FROM node:24-alpine

# Install shell tools needed by motor skills
RUN apk add --no-cache \\
    curl \\
    jq \\
    grep \\
    coreutils \\
    git \\
    unzip \\
    zip \\
    tar \\
    python3 \\
    py3-pip \\
    && rm -rf /var/cache/apk/*

# Create tool-server directory
# Use the built-in 'node' user (uid 1000) from node:24-alpine
RUN mkdir -p /opt/motor && chown node:node /opt/motor

# Copy all runtime files (tool-server + sandbox-worker)
COPY . /opt/motor/

# Create workspace dir (will be bind-mounted)
RUN mkdir -p /workspace && chown node:node /workspace

# Redirect npm/pip to writable workspace (root fs is read-only)
ENV NPM_CONFIG_CACHE=/workspace/.cache/npm
ENV PIP_USER=1
ENV PYTHONUSERBASE=/workspace/.local
ENV PIP_CACHE_DIR=/workspace/.cache/pip
ENV PIP_BREAK_SYSTEM_PACKAGES=1
ENV PATH="/workspace/.local/bin:$PATH"

LABEL com.lifemodel.source-hash="${sourceHash}"

USER node
WORKDIR /workspace

# Entrypoint runs the tool-server (compiled JS)
ENTRYPOINT ["node", "/opt/motor/tool-server.js"]
`.trim();
}

const SOURCE_HASH_LABEL = 'com.lifemodel.source-hash';

let imageBuilt = false;

/**
 * Check if the Motor Cortex Docker image exists.
 */
export async function imageExists(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['image', 'inspect', CONTAINER_IMAGE], {
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the directory containing compiled files for a runtime sub-package.
 *
 * In dev: src/runtime/<subdir>/ (TypeScript, run via tsx)
 * In prod: dist/runtime/<subdir>/ (compiled JS)
 */
function getRuntimeDir(subdir: string): string {
  const currentFile = fileURLToPath(import.meta.url);
  const containerDir = dirname(currentFile);
  // containerDir is .../runtime/container/ — go up to runtime/ then down to subdir
  return join(dirname(containerDir), subdir);
}

/**
 * Assemble a temporary build context directory containing all files
 * needed inside the container: tool-server.js + sandbox-worker.js.
 *
 * The container always runs compiled JS (the Dockerfile entrypoint is
 * `node /opt/motor/tool-server.js`). In dev mode, we look for a compiled
 * dist/ directory. If dist/ doesn't exist, the build fails with a clear error.
 *
 * Returns the path to the temporary directory and a content hash (caller must clean up).
 */
async function assembleBuildContext(
  log: (msg: string) => void
): Promise<{ contextDir: string; sourceHash: string } | null> {
  const currentFile = fileURLToPath(import.meta.url);
  const isDev = currentFile.endsWith('.ts');

  // Container always needs .js files — resolve the correct source directory
  let containerDir: string;
  let sandboxDir: string;

  // Source .ts files — used for hash computation in dev mode
  let srcToolServerFile: string | undefined;
  let srcToolServerUtilsFile: string | undefined;
  let srcSandboxWorkerFile: string | undefined;

  if (isDev) {
    // In dev mode: compile dist/ first, then use compiled output for the image.
    // Hash the SOURCE .ts files (not dist/) so any src change triggers a rebuild.
    const srcContainerDir = getRuntimeDir('container');
    const srcSandboxDir = getRuntimeDir('sandbox');
    srcToolServerFile = join(srcContainerDir, 'tool-server.ts');
    srcToolServerUtilsFile = join(srcContainerDir, 'tool-server-utils.ts');
    srcSandboxWorkerFile = join(srcSandboxDir, 'sandbox-worker.ts');

    const distBase = srcContainerDir.replace('/src/runtime/', '/dist/runtime/');
    containerDir = distBase;
    sandboxDir = distBase.replace('/container', '/sandbox');

    log('Dev mode: using dist/ for container image build context');
  } else {
    // In prod mode: we ARE the compiled output
    containerDir = getRuntimeDir('container');
    sandboxDir = getRuntimeDir('sandbox');
  }

  const toolServerFile = join(containerDir, 'tool-server.js');
  const toolServerUtilsFile = join(containerDir, 'tool-server-utils.js');
  const sandboxWorkerFile = join(sandboxDir, 'sandbox-worker.js');

  // Create temp build context
  const contextDir = await mkdtemp(join(tmpdir(), 'motor-image-'));

  try {
    // Copy tool-server.js and its local dependencies
    await copyFile(toolServerFile, join(contextDir, 'tool-server.js'));
    await copyFile(toolServerUtilsFile, join(contextDir, 'tool-server-utils.js'));

    // Copy sandbox-worker.js (needed by tool-server for code execution)
    await copyFile(sandboxWorkerFile, join(contextDir, 'sandbox-worker.js'));

    // Compute content hash for staleness detection.
    // In dev mode: hash the SOURCE .ts files so any src change triggers a rebuild.
    // In prod mode: hash the compiled .js files (they ARE the source of truth).
    const hash = createHash('sha256');
    if (isDev && srcToolServerFile && srcToolServerUtilsFile && srcSandboxWorkerFile) {
      hash.update(await readFile(srcToolServerFile));
      hash.update(await readFile(srcToolServerUtilsFile));
      hash.update(await readFile(srcSandboxWorkerFile));
    } else {
      hash.update(await readFile(toolServerFile));
      hash.update(await readFile(toolServerUtilsFile));
      hash.update(await readFile(sandboxWorkerFile));
    }
    // Include Dockerfile template so package/env-var changes trigger a rebuild
    hash.update(buildDockerfile(''));
    const sourceHash = hash.digest('hex').slice(0, 16);

    return { contextDir, sourceHash };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (isDev) {
      log(`Failed to assemble build context: ${msg}. Run 'npx tsc' to compile dist/ first.`);
    } else {
      log(`Failed to assemble build context: ${msg}`);
    }
    await rm(contextDir, { recursive: true, force: true }).catch(() => {
      /* ignore */
    });
    return null;
  }
}

/**
 * Get the source hash label from the existing Docker image.
 * Returns null if image doesn't exist or has no label.
 */
async function getImageSourceHash(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['inspect', '--format', `{{index .Config.Labels "${SOURCE_HASH_LABEL}"}}`, CONTAINER_IMAGE],
      { timeout: 10_000 }
    );
    const hash = stdout.trim();
    return hash && hash !== '<no value>' ? hash : null;
  } catch {
    return null;
  }
}

/**
 * Build the Motor Cortex Docker image.
 *
 * Assembles a build context with tool-server + sandbox-worker, then
 * pipes the Dockerfile via stdin to `docker build`.
 *
 * Detects stale images via source hash label — rebuilds automatically
 * when tool-server or sandbox-worker source changes.
 *
 * @param logger - Optional logging function
 * @returns true if build succeeded (or image already exists and is up-to-date)
 */
export async function ensureImage(logger?: (msg: string) => void): Promise<boolean> {
  if (imageBuilt) return true;

  const log =
    logger ??
    (() => {
      /* No-op logger */
    });

  // Assemble build context first — we need the source hash to check staleness
  const buildResult = await assembleBuildContext(log);
  if (!buildResult) return false;

  let { contextDir } = buildResult;
  const { sourceHash } = buildResult;

  try {
    // Check if image exists and is up-to-date
    if (await imageExists()) {
      const existingHash = await getImageSourceHash();
      if (existingHash === sourceHash) {
        imageBuilt = true;
        return true;
      }
      log(
        `Motor Cortex image is stale (source changed: ${existingHash ?? 'none'} → ${sourceHash}), rebuilding...`
      );
    } else {
      log('Building Motor Cortex container image...');
    }

    // In dev mode, recompile dist/ before building the image.
    // Source hash changed → dist/ is stale → compile first.
    const currentFile = fileURLToPath(import.meta.url);
    if (currentFile.endsWith('.ts')) {
      log('Compiling TypeScript before building container image...');
      try {
        await execFileAsync('npx', ['tsc'], { timeout: 60_000 });
      } catch (compileError) {
        const errMsg = compileError instanceof Error ? compileError.message : String(compileError);
        log(`TypeScript compilation failed: ${errMsg}`);
        return false;
      }

      // Reassemble build context with freshly compiled files
      await rm(contextDir, { recursive: true, force: true }).catch(() => {
        /* ignore cleanup errors */
      });
      const freshBuild = await assembleBuildContext(log);
      if (!freshBuild) return false;
      contextDir = freshBuild.contextDir;
    }

    // Build the image
    const dockerfile = buildDockerfile(sourceHash);
    const buildProcess = execFile(
      'docker',
      ['build', '-t', CONTAINER_IMAGE, '-f', '-', contextDir],
      { timeout: 120_000, maxBuffer: 1024 * 1024 }
    );

    buildProcess.stdin?.write(dockerfile);
    buildProcess.stdin?.end();

    await new Promise<void>((resolve, reject) => {
      buildProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Docker build failed with code ${String(code)}`));
        }
      });
      buildProcess.on('error', reject);
    });

    imageBuilt = true;
    log('Motor Cortex container image built successfully');
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`Failed to build container image: ${msg}`);
    return false;
  } finally {
    // Clean up temporary build context
    await rm(contextDir, { recursive: true, force: true }).catch(() => {
      /* ignore */
    });
  }
}

/**
 * Remove the Motor Cortex Docker image.
 */
export async function removeImage(): Promise<void> {
  try {
    await execFileAsync('docker', ['rmi', CONTAINER_IMAGE], { timeout: 30_000 });
    imageBuilt = false;
  } catch {
    // Image may not exist
  }
}
