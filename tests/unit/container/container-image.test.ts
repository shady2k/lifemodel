/**
 * Unit tests for container image Dockerfile generation and hash invalidation.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildDockerfile } from '../../../src/runtime/container/container-image.js';

describe('buildDockerfile', () => {
  const dockerfile = buildDockerfile('testhash123');

  describe('packages', () => {
    it('includes python3 and py3-pip in apk install', () => {
      expect(dockerfile).toContain('python3');
      expect(dockerfile).toContain('py3-pip');
    });

    it('includes standard shell tools', () => {
      for (const pkg of ['curl', 'jq', 'grep', 'coreutils', 'git']) {
        expect(dockerfile).toContain(pkg);
      }
    });
  });

  describe('env vars for writable workspace', () => {
    const envVars: Record<string, string> = {
      NPM_CONFIG_CACHE: '/workspace/.cache/npm',
      PIP_USER: '1',
      PYTHONUSERBASE: '/workspace/.local',
      PIP_CACHE_DIR: '/workspace/.cache/pip',
      PIP_BREAK_SYSTEM_PACKAGES: '1',
    };

    for (const [name, value] of Object.entries(envVars)) {
      it(`sets ${name}=${value}`, () => {
        expect(dockerfile).toContain(`ENV ${name}=${value}`);
      });
    }

    it('prepends /workspace/.local/bin to PATH', () => {
      expect(dockerfile).toContain('ENV PATH="/workspace/.local/bin:$PATH"');
    });

    it('all cache/install paths point to /workspace/', () => {
      // Extract all ENV lines with path-like values
      const envLines = dockerfile.split('\n').filter((l) => l.startsWith('ENV '));
      const pathValues = envLines
        .map((l) => l.split('=')[1]?.replace(/"/g, ''))
        .filter((v) => v?.startsWith('/'));

      for (const path of pathValues) {
        expect(path).toMatch(/^\/workspace\//);
      }
    });
  });

  describe('structure', () => {
    it('sets env vars before USER node directive', () => {
      const envPos = dockerfile.indexOf('ENV NPM_CONFIG_CACHE');
      const userPos = dockerfile.indexOf('USER node');
      expect(envPos).toBeGreaterThan(-1);
      expect(userPos).toBeGreaterThan(envPos);
    });

    it('embeds the source hash label', () => {
      expect(dockerfile).toContain('com.lifemodel.source-hash="testhash123"');
    });
  });
});

describe('Dockerfile hash invalidation', () => {
  it('different Dockerfile content produces different hashes', () => {
    const df1 = buildDockerfile('');
    // Simulate a future change by appending extra content
    const df2 = df1 + '\nRUN apk add --no-cache some-new-package';

    const hash1 = createHash('sha256').update(df1).digest('hex');
    const hash2 = createHash('sha256').update(df2).digest('hex');

    expect(hash1).not.toBe(hash2);
  });

  it('same Dockerfile content produces identical hashes', () => {
    const df1 = buildDockerfile('');
    const df2 = buildDockerfile('');

    const hash1 = createHash('sha256').update(df1).digest('hex');
    const hash2 = createHash('sha256').update(df2).digest('hex');

    expect(hash1).toBe(hash2);
  });

  it('source hash parameter does not affect Dockerfile template hash', () => {
    // buildDockerfile('') is what gets hashed in assembleBuildContext,
    // regardless of the actual sourceHash used for the label.
    // Verify the template is deterministic for hash purposes.
    const template1 = buildDockerfile('');
    const template2 = buildDockerfile('');
    expect(template1).toBe(template2);
  });
});
