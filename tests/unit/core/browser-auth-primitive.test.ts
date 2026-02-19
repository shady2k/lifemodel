/**
 * Tests for browser-auth-primitive.ts
 *
 * Validates the BrowserAuthPrimitive bridges correctly to ContainerManager.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBrowserAuthPrimitive } from '../../../src/core/browser-auth-primitive.js';
import type { ContainerManager } from '../../../src/runtime/container/types.js';

// Mock browser-image module
vi.mock('../../../src/runtime/container/browser-image.js', () => ({
  browserImageExists: vi.fn().mockResolvedValue(true),
  ensureBrowserImage: vi.fn().mockResolvedValue(true),
}));

// Mock child_process for volume existence checks
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('node:util', async () => {
  const actual = await vi.importActual<typeof import('node:util')>('node:util');
  return {
    ...actual,
    promisify: () => vi.fn().mockRejectedValue(new Error('volume not found')),
  };
});

function createMockContainerManager(): ContainerManager {
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    create: vi.fn(),
    destroy: vi.fn(),
    prune: vi.fn(),
    destroyAll: vi.fn(),
    runScript: vi.fn(),
    startDetached: vi.fn().mockResolvedValue({
      containerId: 'abc123def456',
      ports: { 6080: 49152 },
    }),
    stopDetached: vi.fn().mockResolvedValue(undefined),
  };
}

describe('createBrowserAuthPrimitive', () => {
  describe('startAuth', () => {
    it('should start a detached container and return session info', async () => {
      const mgr = createMockContainerManager();
      const auth = createBrowserAuthPrimitive(mgr);

      const session = await auth.startAuth('telegram', 'https://web.telegram.org');

      expect(session.containerId).toBe('abc123def456');
      expect(session.authUrl).toContain('127.0.0.1');
      expect(session.authUrl).toContain('49152');
      expect(mgr.startDetached).toHaveBeenCalledWith(
        expect.objectContaining({
          image: 'lifemodel-browser:latest',
          entrypoint: ['/scripts/entrypoint-auth.sh'],
          env: { AUTH_URL: 'https://web.telegram.org' },
        })
      );
    });

    it('should use dynamic port allocation (hostPort=0)', async () => {
      const mgr = createMockContainerManager();
      const auth = createBrowserAuthPrimitive(mgr);

      await auth.startAuth('telegram', 'https://web.telegram.org');

      expect(mgr.startDetached).toHaveBeenCalledWith(
        expect.objectContaining({
          ports: { 0: 6080 },
        })
      );
    });

    it('should create a named volume for the profile', async () => {
      const mgr = createMockContainerManager();
      const auth = createBrowserAuthPrimitive(mgr);

      await auth.startAuth('my-profile', 'https://example.com');

      expect(mgr.startDetached).toHaveBeenCalledWith(
        expect.objectContaining({
          volumes: [
            expect.objectContaining({
              name: 'lifemodel-browser-profile-my-profile',
              containerPath: '/profile',
              mode: 'rw',
            }),
          ],
        })
      );
    });

    it('should reject invalid profile names', async () => {
      const mgr = createMockContainerManager();
      const auth = createBrowserAuthPrimitive(mgr);

      await expect(auth.startAuth('bad name!', 'https://example.com')).rejects.toThrow(
        'Invalid profile name'
      );
      expect(mgr.startDetached).not.toHaveBeenCalled();
    });

    it('should reject invalid URLs', async () => {
      const mgr = createMockContainerManager();
      const auth = createBrowserAuthPrimitive(mgr);

      await expect(auth.startAuth('test', 'not-a-url')).rejects.toThrow('Invalid URL');
      expect(mgr.startDetached).not.toHaveBeenCalled();
    });
  });

  describe('stopAuth', () => {
    it('should stop the container by profile', async () => {
      const mgr = createMockContainerManager();
      const auth = createBrowserAuthPrimitive(mgr);

      // Must startAuth first to register the container
      await auth.startAuth('telegram', 'https://web.telegram.org');
      await auth.stopAuth('telegram');

      expect(mgr.stopDetached).toHaveBeenCalledWith('abc123def456');
    });

    it('should throw if no active auth session', async () => {
      const mgr = createMockContainerManager();
      const auth = createBrowserAuthPrimitive(mgr);

      await expect(auth.stopAuth('nonexistent')).rejects.toThrow('No active auth session');
    });
  });

  describe('isImageReady', () => {
    it('should delegate to browserImageExists', async () => {
      const mgr = createMockContainerManager();
      const auth = createBrowserAuthPrimitive(mgr);

      const ready = await auth.isImageReady();
      expect(typeof ready).toBe('boolean');
    });
  });

  describe('ensureImageInBackground', () => {
    it('should not throw and should accept a callback', () => {
      const mgr = createMockContainerManager();
      const auth = createBrowserAuthPrimitive(mgr);

      // Should not throw
      expect(() => auth.ensureImageInBackground(() => {})).not.toThrow();
    });
  });

  describe('volumeExists', () => {
    it('should reject invalid profile names', async () => {
      const mgr = createMockContainerManager();
      const auth = createBrowserAuthPrimitive(mgr);

      const exists = await auth.volumeExists('bad name!');
      expect(exists).toBe(false);
    });
  });
});
