/**
 * Container Image Builder
 *
 * Builds the Motor Cortex Docker image lazily on first use.
 * Image contains Alpine + Node 24 + shell tools + tool-server.
 *
 * ~50MB image with non-root user 'motor' (UID 1000).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile } from 'node:fs/promises';
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
const DOCKERFILE = `
FROM node:24-alpine

# Install shell tools needed by motor skills
RUN apk add --no-cache \\
    curl \\
    jq \\
    grep \\
    coreutils \\
    && rm -rf /var/cache/apk/*

# Create tool-server directory
# Use the built-in 'node' user (uid 1000) from node:24-alpine
RUN mkdir -p /opt/motor && chown node:node /opt/motor

# Copy all runtime files (tool-server + sandbox-worker)
COPY . /opt/motor/

# Create workspace and skills dirs (will be bind-mounted)
RUN mkdir -p /workspace /skills && chown node:node /workspace /skills

USER node
WORKDIR /workspace

# Entrypoint runs the tool-server (compiled JS)
ENTRYPOINT ["node", "/opt/motor/tool-server.js"]
`.trim();

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
 * Returns the path to the temporary directory (caller must clean up).
 */
async function assembleBuildContext(log: (msg: string) => void): Promise<string | null> {
  const currentFile = fileURLToPath(import.meta.url);
  const isDev = currentFile.endsWith('.ts');

  // Container always needs .js files — resolve the correct source directory
  let containerDir: string;
  let sandboxDir: string;

  if (isDev) {
    // In dev mode: look for compiled output in dist/
    // The project compiles src/runtime/container/ → dist/runtime/container/
    const srcContainerDir = getRuntimeDir('container');
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
  const sandboxWorkerFile = join(sandboxDir, 'sandbox-worker.js');

  // Create temp build context
  const contextDir = await mkdtemp(join(tmpdir(), 'motor-image-'));

  try {
    // Copy tool-server.js
    await copyFile(toolServerFile, join(contextDir, 'tool-server.js'));

    // Copy sandbox-worker.js (needed by tool-server for code execution)
    await copyFile(sandboxWorkerFile, join(contextDir, 'sandbox-worker.js'));

    return contextDir;
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
 * Build the Motor Cortex Docker image.
 *
 * Assembles a build context with tool-server + sandbox-worker, then
 * pipes the Dockerfile via stdin to `docker build`.
 *
 * Idempotent — checks if image exists first.
 *
 * @param logger - Optional logging function
 * @returns true if build succeeded (or image already exists)
 */
export async function ensureImage(logger?: (msg: string) => void): Promise<boolean> {
  if (imageBuilt) return true;

  // Check if image already exists
  if (await imageExists()) {
    imageBuilt = true;
    return true;
  }

  const log =
    logger ??
    (() => {
      /* No-op logger */
    });
  log('Building Motor Cortex container image...');

  const contextDir = await assembleBuildContext(log);
  if (!contextDir) return false;

  try {
    // Pipe Dockerfile via stdin to docker build
    const buildProcess = execFile(
      'docker',
      ['build', '-t', CONTAINER_IMAGE, '-f', '-', contextDir],
      { timeout: 120_000, maxBuffer: 1024 * 1024 }
    );

    buildProcess.stdin?.write(DOCKERFILE);
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
