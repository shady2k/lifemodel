/**
 * Tests for browser-image.ts
 *
 * Validates the Dockerfile generation and source hash labeling.
 * Does NOT build actual Docker images (that requires Docker daemon).
 */

import { describe, it, expect } from 'vitest';
import { buildBrowserDockerfile } from '../../../src/runtime/container/browser-image.js';
import { BROWSER_IMAGE } from '../../../src/runtime/container/types.js';

describe('buildBrowserDockerfile', () => {
  it('should include the Playwright base image', () => {
    const dockerfile = buildBrowserDockerfile('abc123');
    expect(dockerfile).toContain('mcr.microsoft.com/playwright:v1.58.2-noble');
  });

  it('should include the source hash label', () => {
    const hash = 'deadbeef12345678';
    const dockerfile = buildBrowserDockerfile(hash);
    expect(dockerfile).toContain(`com.lifemodel.source-hash="${hash}"`);
  });

  it('should install xvfb and x11vnc', () => {
    const dockerfile = buildBrowserDockerfile('test');
    expect(dockerfile).toContain('xvfb');
    expect(dockerfile).toContain('x11vnc');
  });

  it('should install noVNC from git', () => {
    const dockerfile = buildBrowserDockerfile('test');
    expect(dockerfile).toContain('noVNC');
    expect(dockerfile).toContain('/opt/novnc');
  });

  it('should copy scripts', () => {
    const dockerfile = buildBrowserDockerfile('test');
    expect(dockerfile).toContain('COPY scripts/ /scripts/');
  });

  it('should create profile directory', () => {
    const dockerfile = buildBrowserDockerfile('test');
    expect(dockerfile).toContain('/profile');
    expect(dockerfile).toContain('pwuser');
  });

  it('should use pwuser (Playwright default non-root user)', () => {
    const dockerfile = buildBrowserDockerfile('test');
    expect(dockerfile).toContain('USER pwuser');
  });

  it('should have node as default entrypoint', () => {
    const dockerfile = buildBrowserDockerfile('test');
    expect(dockerfile).toContain('ENTRYPOINT ["node"]');
  });
});

describe('BROWSER_IMAGE constant', () => {
  it('should be defined', () => {
    expect(BROWSER_IMAGE).toBe('lifemodel-browser:latest');
  });
});
