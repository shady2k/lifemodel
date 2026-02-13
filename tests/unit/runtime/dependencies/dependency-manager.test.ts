/**
 * Tests for dependency-manager.ts
 *
 * Covers: hash computation, validation (via skill-loader).
 * Docker/fs-heavy tests for install flow use targeted mocking.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── computeDepsHash tests (no mocking needed) ──────────────────

describe('computeDepsHash', () => {
  // Dynamic import to avoid mock interference
  let computeDepsHash: typeof import('../../../../src/runtime/dependencies/dependency-manager.js').computeDepsHash;

  beforeEach(async () => {
    const mod = await import('../../../../src/runtime/dependencies/dependency-manager.js');
    computeDepsHash = mod.computeDepsHash;
  });

  it('returns deterministic hash for same inputs', () => {
    const pkgs = [
      { name: 'foo', version: '1.0.0' },
      { name: 'bar', version: '2.0.0' },
    ];
    const h1 = computeDepsHash('npm', pkgs, 'sha256:abc123');
    const h2 = computeDepsHash('npm', pkgs, 'sha256:abc123');
    expect(h1).toBe(h2);
  });

  it('is order-independent (sorted internally)', () => {
    const pkgs1 = [
      { name: 'bar', version: '2.0.0' },
      { name: 'foo', version: '1.0.0' },
    ];
    const pkgs2 = [
      { name: 'foo', version: '1.0.0' },
      { name: 'bar', version: '2.0.0' },
    ];
    expect(computeDepsHash('npm', pkgs1, 'sha256:abc')).toBe(
      computeDepsHash('npm', pkgs2, 'sha256:abc')
    );
  });

  it('differs for different ecosystems', () => {
    const pkgs = [{ name: 'foo', version: '1.0.0' }];
    const npmHash = computeDepsHash('npm', pkgs, 'sha256:abc');
    const pipHash = computeDepsHash('pip', pkgs, 'sha256:abc');
    expect(npmHash).not.toBe(pipHash);
  });

  it('differs for different image IDs', () => {
    const pkgs = [{ name: 'foo', version: '1.0.0' }];
    const h1 = computeDepsHash('npm', pkgs, 'sha256:aaa');
    const h2 = computeDepsHash('npm', pkgs, 'sha256:bbb');
    expect(h1).not.toBe(h2);
  });

  it('differs when versions change', () => {
    const pkgs1 = [{ name: 'foo', version: '1.0.0' }];
    const pkgs2 = [{ name: 'foo', version: '2.0.0' }];
    expect(computeDepsHash('npm', pkgs1, 'sha256:abc')).not.toBe(
      computeDepsHash('npm', pkgs2, 'sha256:abc')
    );
  });

  it('returns 16-char hex string', () => {
    const hash = computeDepsHash('npm', [{ name: 'x', version: '1' }], 'img');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ─── validateDependencies tests (pure function, no mocking) ─────

describe('validateDependencies', () => {
  let validateDependencies: (deps: Record<string, unknown>) => string[];

  beforeEach(async () => {
    const mod = await import('../../../../src/runtime/skills/skill-loader.js');
    validateDependencies = mod.validateDependencies;
  });

  it('accepts valid npm packages', () => {
    const errors = validateDependencies({
      npm: { packages: [{ name: 'agentmail', version: '0.2.13' }] },
    });
    expect(errors).toHaveLength(0);
  });

  it('accepts scoped npm packages', () => {
    const errors = validateDependencies({
      npm: { packages: [{ name: '@anthropic/sdk', version: '1.0.0' }] },
    });
    expect(errors).toHaveLength(0);
  });

  it('accepts valid pip packages', () => {
    const errors = validateDependencies({
      pip: { packages: [{ name: 'requests', version: '2.32.3' }] },
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects unknown ecosystems', () => {
    const errors = validateDependencies({
      conda: { packages: [{ name: 'numpy', version: '1.0' }] },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Unknown dependency ecosystem');
  });

  it('rejects caret ranges', () => {
    const errors = validateDependencies({
      npm: { packages: [{ name: 'foo', version: '^1.0.0' }] },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('exact pin');
  });

  it('rejects tilde ranges', () => {
    const errors = validateDependencies({
      npm: { packages: [{ name: 'foo', version: '~2.0.0' }] },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('exact pin');
  });

  it('rejects star versions', () => {
    const errors = validateDependencies({
      npm: { packages: [{ name: 'foo', version: '*' }] },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects >= ranges', () => {
    const errors = validateDependencies({
      npm: { packages: [{ name: 'foo', version: '>=1.0.0' }] },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects URL dependencies', () => {
    const errors = validateDependencies({
      npm: {
        packages: [{ name: 'foo', version: 'https://example.com/foo.tgz' }],
      },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects git ref dependencies', () => {
    const errors = validateDependencies({
      npm: {
        packages: [{ name: 'foo', version: 'github:user/repo#main' }],
      },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects "latest" version', () => {
    const errors = validateDependencies({
      npm: { packages: [{ name: 'foo', version: 'latest' }] },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects invalid package names (URLs)', () => {
    const errors = validateDependencies({
      npm: {
        packages: [{ name: 'https://evil.com/exploit', version: '1.0.0' }],
      },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('invalid package name');
  });

  it('rejects packages with local paths', () => {
    const errors = validateDependencies({
      npm: {
        packages: [{ name: '../../../etc/passwd', version: '1.0.0' }],
      },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts multiple valid packages across ecosystems', () => {
    const errors = validateDependencies({
      npm: {
        packages: [
          { name: 'agentmail', version: '0.2.13' },
          { name: 'stripe', version: '14.21.0' },
        ],
      },
      pip: {
        packages: [{ name: 'requests', version: '2.32.3' }],
      },
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects missing packages array', () => {
    const errors = validateDependencies({
      npm: { notPackages: [] },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('packages');
  });

  it('rejects non-array packages', () => {
    const errors = validateDependencies({
      npm: { packages: 'not-an-array' },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects missing name in package', () => {
    const errors = validateDependencies({
      npm: { packages: [{ version: '1.0.0' }] },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('name');
  });

  it('rejects missing version in package', () => {
    const errors = validateDependencies({
      npm: { packages: [{ name: 'foo' }] },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('version');
  });
});

// ─── installSkillDependencies (null-return paths) ────────────────

describe('installSkillDependencies — null paths', () => {
  let installSkillDependencies: typeof import('../../../../src/runtime/dependencies/dependency-manager.js').installSkillDependencies;
  let logger: any;

  beforeEach(async () => {
    const mod = await import('../../../../src/runtime/dependencies/dependency-manager.js');
    installSkillDependencies = mod.installSkillDependencies;
    logger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    };
  });

  it('returns null when no dependencies declared', async () => {
    const result = await installSkillDependencies({}, '/tmp/cache', 'test', logger);
    expect(result).toBeNull();
  });

  it('returns null for empty package arrays', async () => {
    const result = await installSkillDependencies(
      { npm: { packages: [] }, pip: { packages: [] } },
      '/tmp/cache',
      'test',
      logger
    );
    expect(result).toBeNull();
  });
});

// ─── Container config integration (types) ────────────────────────

describe('ContainerConfig extraMounts/extraEnv types', () => {
  it('accepts extraMounts and extraEnv fields', async () => {
    const { CONTAINER_IMAGE } = await import('../../../../src/runtime/container/types.js');
    // Type check — verify the fields compile correctly
    const config: import('../../../../src/runtime/container/types.js').ContainerConfig = {
      workspacePath: '/tmp/workspace',
      extraMounts: [
        { hostPath: '/cache/npm/abc/node_modules', containerPath: '/workspace/node_modules', mode: 'ro' },
      ],
      extraEnv: {
        NODE_PATH: '/workspace/node_modules',
      },
    };
    expect(config.extraMounts).toHaveLength(1);
    expect(config.extraEnv?.['NODE_PATH']).toBe('/workspace/node_modules');
  });
});
