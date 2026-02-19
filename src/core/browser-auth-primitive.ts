/**
 * Browser Auth Primitive Implementation
 *
 * Bridges the ContainerManager.startDetached/stopDetached API to the
 * BrowserAuthPrimitive interface used by plugins.
 *
 * Manages the lifecycle of interactive browser containers for auth flows:
 * start → user authenticates via noVNC → stop → profile saved in volume.
 */

import type { BrowserAuthPrimitive, BrowserAuthSession } from '../types/plugin.js';
import type { ContainerManager, DetachedContainerConfig } from '../runtime/container/types.js';
import { BROWSER_IMAGE } from '../runtime/container/types.js';
import { browserImageExists, ensureBrowserImage } from '../runtime/container/browser-image.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const VOLUME_PREFIX = 'lifemodel-browser-profile';
const NOVNC_CONTAINER_PORT = 6080;

/**
 * Validate a profile name (alphanumeric + hyphens).
 */
function validateProfile(profile: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(profile);
}

/**
 * Check if a Docker volume exists (fast inspect).
 */
async function dockerVolumeExists(volumeName: string): Promise<boolean> {
  try {
    await execFileAsync('docker', ['volume', 'inspect', volumeName], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a BrowserAuthPrimitive backed by a ContainerManager.
 */
export function createBrowserAuthPrimitive(
  containerManager: ContainerManager
): BrowserAuthPrimitive {
  // Track in-flight background build to avoid duplicate builds
  let backgroundBuildPromise: Promise<boolean> | null = null;

  return {
    async startAuth(profile: string, url: string): Promise<BrowserAuthSession> {
      if (!validateProfile(profile)) {
        throw new Error(
          `Invalid profile name "${profile}". Use alphanumeric characters and hyphens.`
        );
      }

      // Validate URL
      try {
        new URL(url);
      } catch {
        throw new Error(`Invalid URL: ${url}`);
      }

      const volumeName = `${VOLUME_PREFIX}-${profile}`;

      const config: DetachedContainerConfig = {
        image: BROWSER_IMAGE,
        entrypoint: ['/scripts/entrypoint-auth.sh'],
        env: { AUTH_URL: url },
        // Use dynamic port allocation to avoid conflicts
        ports: { 0: NOVNC_CONTAINER_PORT },
        volumes: [{ name: volumeName, containerPath: '/profile', mode: 'rw' }],
        tmpfs: ['/tmp:rw,noexec,nosuid,size=256m'],
      };

      const handle = await containerManager.startDetached(config);

      // Determine actual host port (from dynamic allocation or fallback)
      const hostPort =
        handle.ports[NOVNC_CONTAINER_PORT] ??
        Object.values(handle.ports)[0] ??
        NOVNC_CONTAINER_PORT;

      return {
        containerId: handle.containerId,
        authUrl: `http://localhost:${String(hostPort)}/vnc.html`,
      };
    },

    async stopAuth(containerId: string): Promise<void> {
      await containerManager.stopDetached(containerId);
    },

    async volumeExists(profile: string): Promise<boolean> {
      if (!validateProfile(profile)) return false;
      return dockerVolumeExists(`${VOLUME_PREFIX}-${profile}`);
    },

    async isImageReady(): Promise<boolean> {
      return browserImageExists();
    },

    ensureImageInBackground(onReady?: (success: boolean) => void): void {
      if (backgroundBuildPromise) {
        // Build already in progress — attach callback
        if (onReady) {
          backgroundBuildPromise.then(onReady).catch(() => {
            onReady(false);
          });
        }
        return;
      }

      backgroundBuildPromise = ensureBrowserImage();
      backgroundBuildPromise
        .then((success) => {
          backgroundBuildPromise = null;
          onReady?.(success);
        })
        .catch(() => {
          backgroundBuildPromise = null;
          onReady?.(false);
        });
    },
  };
}
