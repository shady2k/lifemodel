/**
 * Browser Container Image Builder
 *
 * Builds the browser Docker image for authenticated web automation.
 * Image contains Playwright + Chromium + Xvfb + x11vnc + noVNC.
 *
 * ~1.5GB image (Playwright base) — first build is slow.
 * Source-hash pattern mirrors container-image.ts for staleness detection.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, readdir, cp } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { BROWSER_IMAGE } from './types.js';

const execFileAsync = promisify(execFile);

const SOURCE_HASH_LABEL = 'com.lifemodel.source-hash';

/**
 * Build the browser Dockerfile string with embedded source hash.
 *
 * Base: mcr.microsoft.com/playwright:v1.52.0-noble
 * Adds: Xvfb, x11vnc, noVNC/websockify, scripts
 */
export function buildBrowserDockerfile(sourceHash: string): string {
  return `
FROM mcr.microsoft.com/playwright:v1.52.0-noble

# Install display and VNC tools
RUN apt-get update && apt-get install -y --no-install-recommends \\
    xvfb \\
    x11vnc \\
    python3-websockify \\
    git \\
    && rm -rf /var/lib/apt/lists/*

# Install noVNC (lightweight HTML5 VNC client)
RUN git clone --depth 1 https://github.com/novnc/noVNC.git /opt/novnc \\
    && rm -rf /opt/novnc/.git

# Copy browser scripts
COPY scripts/ /scripts/
RUN chmod +x /scripts/*.sh 2>/dev/null || true

# Create profile directory for persistent browser data
RUN mkdir -p /profile && chown pwuser:pwuser /profile

LABEL com.lifemodel.source-hash="${sourceHash}"

USER pwuser
WORKDIR /home/pwuser

# Default entrypoint (overridden per use case)
ENTRYPOINT ["node"]
`.trim();
}

let browserImageBuilt = false;

/**
 * Resolve the browser scripts directory from project root.
 * Scripts live in docker/browser/scripts/ relative to the project root.
 */
function getBrowserScriptsDir(): string {
  const currentFile = fileURLToPath(import.meta.url);
  // currentFile is .../src/runtime/container/browser-image.ts (or .js in dist)
  // Project root is 3 levels up from src/runtime/container/
  const containerDir = dirname(currentFile);
  const runtimeDir = dirname(containerDir);
  const srcOrDistDir = dirname(runtimeDir);
  const projectRoot = dirname(srcOrDistDir);
  return resolve(projectRoot, 'docker', 'browser', 'scripts');
}

/**
 * Assemble a temporary build context with scripts and compute content hash.
 * Returns { contextDir, sourceHash } or null on failure.
 * Caller must clean up contextDir.
 */
export async function assembleBrowserBuildContext(
  log: (msg: string) => void
): Promise<{ contextDir: string; sourceHash: string } | null> {
  const scriptsDir = getBrowserScriptsDir();

  const contextDir = await mkdtemp(resolve(tmpdir(), 'browser-image-'));

  try {
    // Copy scripts into build context
    const scriptsDestDir = resolve(contextDir, 'scripts');
    await cp(scriptsDir, scriptsDestDir, { recursive: true });

    // Compute content hash from scripts + Dockerfile template
    const hash = createHash('sha256');

    const scriptFiles = await readdir(scriptsDestDir);
    for (const sf of scriptFiles.sort()) {
      hash.update(await readFile(resolve(scriptsDestDir, sf)));
    }
    // Include Dockerfile template so base image changes trigger rebuild
    hash.update(buildBrowserDockerfile(''));

    const sourceHash = hash.digest('hex').slice(0, 16);

    return { contextDir, sourceHash };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`Failed to assemble browser build context: ${msg}`);
    await rm(contextDir, { recursive: true, force: true }).catch(() => {
      /* ignore */
    });
    return null;
  }
}

/**
 * Check if the browser Docker image exists (fast — no build).
 */
export async function browserImageExists(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['image', 'inspect', BROWSER_IMAGE], {
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the source hash label from the existing browser image.
 */
async function getBrowserImageSourceHash(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['inspect', '--format', `{{index .Config.Labels "${SOURCE_HASH_LABEL}"}}`, BROWSER_IMAGE],
      { timeout: 10_000 }
    );
    const hash = stdout.trim();
    return hash && hash !== '<no value>' ? hash : null;
  } catch {
    return null;
  }
}

/**
 * Ensure the browser Docker image exists and is up-to-date.
 *
 * Uses source-hash label to detect stale images when scripts change.
 * First build downloads ~1.5GB Playwright base — subsequent builds use cache.
 *
 * @param logger - Optional logging function
 * @returns true if image is ready
 */
export async function ensureBrowserImage(logger?: (msg: string) => void): Promise<boolean> {
  if (browserImageBuilt) return true;

  const log =
    logger ??
    (() => {
      /* No-op logger */
    });

  const buildResult = await assembleBrowserBuildContext(log);
  if (!buildResult) return false;

  const { contextDir, sourceHash } = buildResult;

  try {
    // Check if image exists and is up-to-date
    if (await browserImageExists()) {
      const existingHash = await getBrowserImageSourceHash();
      if (existingHash === sourceHash) {
        browserImageBuilt = true;
        return true;
      }
      log(
        `Browser image is stale (source changed: ${existingHash ?? 'none'} → ${sourceHash}), rebuilding...`
      );
    } else {
      log('Building browser container image (this may take a few minutes on first run)...');
    }

    // Build the image
    const dockerfile = buildBrowserDockerfile(sourceHash);
    const buildProcess = execFile(
      'docker',
      ['build', '-t', BROWSER_IMAGE, '-f', '-', contextDir],
      { timeout: 600_000, maxBuffer: 10 * 1024 * 1024 } // 10 min timeout for large base image
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

    browserImageBuilt = true;
    log('Browser container image built successfully');
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`Failed to build browser container image: ${msg}`);
    return false;
  } finally {
    await rm(contextDir, { recursive: true, force: true }).catch(() => {
      /* ignore */
    });
  }
}

/**
 * Remove the browser Docker image and reset cache.
 */
export async function removeBrowserImage(): Promise<void> {
  try {
    await execFileAsync('docker', ['rmi', BROWSER_IMAGE], { timeout: 30_000 });
    browserImageBuilt = false;
  } catch {
    // Image may not exist
  }
}

/**
 * Reset the module-level build cache (for testing).
 */
export function resetBrowserImageCache(): void {
  browserImageBuilt = false;
}
