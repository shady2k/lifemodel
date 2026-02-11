/**
 * Network Policy Helper Container Image Builder
 *
 * Builds the `lifemodel-netpolicy:latest` helper image used to apply
 * iptables rules to Motor Cortex containers. Tiny Alpine + iptables (nft backend).
 *
 * Lazy build on first use, same pattern as container-image.ts.
 */

import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Docker image name for the network policy helper */
export const NETPOLICY_IMAGE = 'lifemodel-netpolicy:latest';

let imageBuilt = false;

/**
 * Check if the network policy helper image exists.
 */
export async function netpolicyImageExists(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['image', 'inspect', NETPOLICY_IMAGE], {
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Dockerfile for the network policy helper container.
 *
 * Tiny Alpine base + iptables-legacy (more stable than nftables in containers).
 * Entrypoint is sh (runs commands passed via docker run).
 */
const DOCKERFILE = `
FROM alpine:3.21

# Install iptables (nftables backend — works in modern container runtimes)
RUN apk add --no-cache iptables && \\
    rm -rf /var/cache/apk/*

# Use sh as entrypoint (commands passed via docker run)
ENTRYPOINT ["sh"]
`.trim();

/**
 * Build the network policy helper container image.
 *
 * Pipes the Dockerfile via stdin to `docker build`.
 * Idempotent — checks if image exists first.
 *
 * @param logger - Optional logging function
 * @returns true if build succeeded (or image already exists)
 */
export async function ensureNetpolicyImage(logger?: (msg: string) => void): Promise<boolean> {
  if (imageBuilt) return true;

  // Check if image already exists
  if (await netpolicyImageExists()) {
    imageBuilt = true;
    return true;
  }

  const log =
    logger ??
    (() => {
      /* No-op logger */
    });
  log('Building network policy helper container image...');

  try {
    // Pipe Dockerfile via stdin to docker build
    // Use '.' context with a temp dir to avoid /dev/null which fails on macOS
    const buildProcess = execFile('docker', ['build', '-t', NETPOLICY_IMAGE, '-f', '-', '.'], {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      cwd: tmpdir(),
    });

    buildProcess.stdin?.write(DOCKERFILE);
    buildProcess.stdin?.end();

    // Capture stderr for diagnostic logging
    let stderr = '';
    buildProcess.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    await new Promise<void>((resolve, reject) => {
      buildProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `Docker build failed with code ${String(code)}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}`
            )
          );
        }
      });
      buildProcess.on('error', reject);
    });

    imageBuilt = true;
    log('Network policy helper container image built successfully');
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`Failed to build network policy helper image: ${msg}`);
    return false;
  }
}

/**
 * Remove the network policy helper container image.
 */
export async function removeNetpolicyImage(): Promise<void> {
  try {
    await execFileAsync('docker', ['rmi', NETPOLICY_IMAGE], { timeout: 30_000 });
    imageBuilt = false;
  } catch {
    // Image may not exist
  }
}
