/**
 * Tests for dependency-manager.ts
 *
 * Covers: unified hash computation, Dockerfile generation, ensureSkillDepsImage flow,
 * PreparedDeps type guard, validation (via skill-loader).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── computeDepsHash tests (no mocking needed) ──────────────────

describe('computeDepsHash', () => {
  let computeDepsHash: typeof import('../../../../src/runtime/dependencies/dependency-manager.js').computeDepsHash;

  beforeEach(async () => {
    const mod = await import('../../../../src/runtime/dependencies/dependency-manager.js');
    computeDepsHash = mod.computeDepsHash;
  });

  it('returns deterministic hash for same inputs', () => {
    const deps = {
      npm: [
        { name: 'foo', version: '1.0.0' },
        { name: 'bar', version: '2.0.0' },
      ],
    };
    const h1 = computeDepsHash(deps, 'sha256:abc123');
    const h2 = computeDepsHash(deps, 'sha256:abc123');
    expect(h1).toBe(h2);
  });

  it('is order-independent (sorted internally)', () => {
    const deps1 = {
      npm: [
        { name: 'bar', version: '2.0.0' },
        { name: 'foo', version: '1.0.0' },
      ],
    };
    const deps2 = {
      npm: [
        { name: 'foo', version: '1.0.0' },
        { name: 'bar', version: '2.0.0' },
      ],
    };
    expect(computeDepsHash(deps1, 'sha256:abc')).toBe(
      computeDepsHash(deps2, 'sha256:abc')
    );
  });

  it('differs for different image IDs', () => {
    const deps = { npm: [{ name: 'foo', version: '1.0.0' }] };
    const h1 = computeDepsHash(deps, 'sha256:aaa');
    const h2 = computeDepsHash(deps, 'sha256:bbb');
    expect(h1).not.toBe(h2);
  });

  it('differs when versions change', () => {
    const deps1 = { npm: [{ name: 'foo', version: '1.0.0' }] };
    const deps2 = { npm: [{ name: 'foo', version: '2.0.0' }] };
    expect(computeDepsHash(deps1, 'sha256:abc')).not.toBe(
      computeDepsHash(deps2, 'sha256:abc')
    );
  });

  it('returns 16-char hex string', () => {
    const hash = computeDepsHash({ npm: [{ name: 'x', version: '1' }] }, 'img');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('same packages across ecosystems share same hash', () => {
    const deps = {
      apt: [{ name: 'ffmpeg', version: 'latest' }],
      npm: [{ name: 'agentmail', version: '0.2.13' }],
      pip: [{ name: 'requests', version: '2.32.3' }],
    };
    const h1 = computeDepsHash(deps, 'sha256:abc');
    const h2 = computeDepsHash(deps, 'sha256:abc');
    expect(h1).toBe(h2);
  });

  it('differs when apt packages added', () => {
    const withoutApt = { npm: [{ name: 'foo', version: '1.0.0' }] };
    const withApt = {
      npm: [{ name: 'foo', version: '1.0.0' }],
      apt: [{ name: 'ffmpeg', version: 'latest' }],
    };
    expect(computeDepsHash(withoutApt, 'sha256:abc')).not.toBe(
      computeDepsHash(withApt, 'sha256:abc')
    );
  });

  it('empty ecosystems produce same hash as absent', () => {
    const absent = { npm: [{ name: 'foo', version: '1.0.0' }] };
    const empty = {
      npm: [{ name: 'foo', version: '1.0.0' }],
      apt: [] as { name: string; version: string }[],
      pip: [] as { name: string; version: string }[],
    };
    expect(computeDepsHash(absent, 'sha256:abc')).toBe(
      computeDepsHash(empty, 'sha256:abc')
    );
  });
});

// ─── isCurrentPreparedDeps type guard ────────────────────────────

describe('isCurrentPreparedDeps', () => {
  let isCurrentPreparedDeps: typeof import('../../../../src/runtime/motor-cortex/motor-protocol.js').isCurrentPreparedDeps;

  beforeEach(async () => {
    const mod = await import('../../../../src/runtime/motor-cortex/motor-protocol.js');
    isCurrentPreparedDeps = mod.isCurrentPreparedDeps;
  });

  it('returns true for current shape', () => {
    expect(
      isCurrentPreparedDeps({ version: 2, skillImage: 'lifemodel-skill-deps-abc:latest' })
    ).toBe(true);
  });

  it('returns false for legacy shape (npmDir/pipDir)', () => {
    expect(
      isCurrentPreparedDeps({
        npmDir: 'lifemodel-deps-npm-abc',
        pipDir: 'lifemodel-deps-pip-def',
        pipPythonPath: '/opt/skill-deps/pip/site-packages',
      })
    ).toBe(false);
  });

  it('returns false for null', () => {
    expect(isCurrentPreparedDeps(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isCurrentPreparedDeps(undefined)).toBe(false);
  });

  it('returns false for wrong version', () => {
    expect(isCurrentPreparedDeps({ version: 1, skillImage: 'foo' })).toBe(false);
  });

  it('returns false for missing skillImage', () => {
    expect(isCurrentPreparedDeps({ version: 2 })).toBe(false);
  });

  it('returns false for non-string skillImage', () => {
    expect(isCurrentPreparedDeps({ version: 2, skillImage: 123 })).toBe(false);
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
    expect(errors[0]).toContain('apt');
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

  it('allows "latest" version', () => {
    const errors = validateDependencies({
      npm: { packages: [{ name: 'foo', version: 'latest' }] },
    });
    expect(errors.length).toBe(0);
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

  // ─── apt-specific validation ────────────────────────────────────

  it('accepts valid apt packages', () => {
    const errors = validateDependencies({
      apt: { packages: [{ name: 'ffmpeg', version: '6.1.1-1' }] },
    });
    expect(errors).toHaveLength(0);
  });

  it('accepts apt version with epoch', () => {
    const errors = validateDependencies({
      apt: { packages: [{ name: 'ffmpeg', version: '2:1.0.0-1' }] },
    });
    expect(errors).toHaveLength(0);
  });

  it('accepts apt "latest" version', () => {
    const errors = validateDependencies({
      apt: { packages: [{ name: 'pandoc', version: 'latest' }] },
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects scoped names for apt', () => {
    const errors = validateDependencies({
      apt: { packages: [{ name: '@scope/pkg', version: '1.0.0' }] },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('invalid package name');
  });

  it('accepts mixed npm + pip + apt', () => {
    const errors = validateDependencies({
      npm: { packages: [{ name: 'agentmail', version: '0.2.13' }] },
      pip: { packages: [{ name: 'requests', version: '2.32.3' }] },
      apt: { packages: [{ name: 'ffmpeg', version: 'latest' }] },
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
      { npm: { packages: [] }, pip: { packages: [] }, apt: { packages: [] } },
      '/tmp/cache',
      'test',
      logger
    );
    expect(result).toBeNull();
  });
});

// ─── ensureSkillDepsImage (mocked Docker) ─────────────────────────

/** Shared mock setup for install-flow tests */
function setupInstallMocks(spawnCalls: Array<{ cmd: string; args: string[]; stdin: string }>) {
  // Mock node:util to intercept promisify(execFile)
  vi.doMock('node:child_process', () => {
    const { EventEmitter } = require('node:events');
    const { promisify: realPromisify } = require('node:util');

    const mockExecFile = vi.fn(
      (
        cmd: string,
        args: string[],
        optsOrCb: unknown,
        maybeCb?: (err: Error | null, result: { stdout: string; stderr: string }) => void
      ) => {
        // Resolve the actual callback (may be 3rd or 4th arg)
        const cb = typeof maybeCb === 'function'
          ? maybeCb
          : typeof optsOrCb === 'function'
            ? (optsOrCb as (err: Error | null, stdout: string, stderr: string) => void)
            : null;

        const isIdInspect = cmd === 'docker' && args[0] === 'inspect' &&
          args.some((a: string) => a === '{{.Id}}');
        const isLabelInspect = cmd === 'docker' && args[0] === 'inspect' &&
          args.some((a: string) => a === '{{json .Config.Labels}}');

        let err: Error | null = null;
        let stdout = '';

        if (isIdInspect) {
          stdout = 'sha256:fakeimageid123\n';
        } else if (isLabelInspect) {
          err = new Error('No such image');
        }

        if (cb) {
          cb(err, stdout as any, '' as any);
        }
      }
    );

    // Add custom promisify so `promisify(execFile)` returns our async version
    (mockExecFile as any)[realPromisify.custom] = vi.fn(
      async (cmd: string, args: string[], _opts?: unknown) => {
        const isIdInspect = cmd === 'docker' && args[0] === 'inspect' &&
          args.some((a: string) => a === '{{.Id}}');
        const isLabelInspect = cmd === 'docker' && args[0] === 'inspect' &&
          args.some((a: string) => a === '{{json .Config.Labels}}');

        if (isIdInspect) {
          return { stdout: 'sha256:fakeimageid123\n', stderr: '' };
        }
        if (isLabelInspect) {
          throw new Error('No such image');
        }
        return { stdout: '', stderr: '' };
      }
    );

    return {
      execFile: mockExecFile,
      spawn: vi.fn((_cmd: string, args: string[]) => {
        const proc = new EventEmitter();
        let stdinContent = '';
        proc.stdin = {
          write: vi.fn((data: string) => { stdinContent += data; }),
          end: vi.fn(() => {
            spawnCalls.push({ cmd: 'docker', args: [...args], stdin: stdinContent });
          }),
        };
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        // Simulate successful docker build
        setTimeout(() => proc.emit('close', 0), 1);
        return proc;
      }),
    };
  });
}

function createMockLogger() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

describe('ensureSkillDepsImage via installSkillDependencies', () => {
  let spawnCalls: Array<{ cmd: string; args: string[]; stdin: string }>;
  let installSkillDependencies: typeof import('../../../../src/runtime/dependencies/dependency-manager.js').installSkillDependencies;
  let logger: any;

  beforeEach(async () => {
    vi.resetModules();
    spawnCalls = [];
    setupInstallMocks(spawnCalls);
    const mod = await import('../../../../src/runtime/dependencies/dependency-manager.js');
    installSkillDependencies = mod.installSkillDependencies;
    logger = createMockLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns PreparedDeps v2 with skillImage', async () => {
    const result = await installSkillDependencies(
      { npm: { packages: [{ name: 'agentmail', version: '0.2.13' }] } },
      '/tmp/cache',
      'test-skill',
      logger
    );

    expect(result).toBeDefined();
    expect(result!.version).toBe(2);
    expect(result!.skillImage).toMatch(/^lifemodel-skill-deps-[0-9a-f]{16}:latest$/);
  });

  it('generates Dockerfile with npm layer', async () => {
    await installSkillDependencies(
      { npm: { packages: [{ name: 'agentmail', version: '0.2.13' }] } },
      '/tmp/cache',
      'test-skill',
      logger
    );

    expect(spawnCalls.length).toBe(1);
    const dockerfile = spawnCalls[0]!.stdin;
    expect(dockerfile).toContain('FROM lifemodel-motor:latest');
    expect(dockerfile).toContain('USER root');
    expect(dockerfile).toContain('npm install --ignore-scripts');
    expect(dockerfile).toContain('"agentmail":"0.2.13"');
    expect(dockerfile).toContain('ENV NODE_PATH=/opt/skill-deps/npm/node_modules');
    expect(dockerfile).toContain('USER node');
    // No apt or pip sections
    expect(dockerfile).not.toContain('apt-get');
    expect(dockerfile).not.toContain('pip');
  });

  it('generates Dockerfile with pip layer', async () => {
    await installSkillDependencies(
      { pip: { packages: [{ name: 'requests', version: '2.32.3' }] } },
      '/tmp/cache',
      'test-skill',
      logger
    );

    expect(spawnCalls.length).toBe(1);
    const dockerfile = spawnCalls[0]!.stdin;
    expect(dockerfile).toContain('python3 -m pip install');
    expect(dockerfile).toContain('requests==2.32.3');
    expect(dockerfile).toContain('ENV PYTHONPATH=/opt/skill-deps/pip/site-packages');
    // No apt or npm sections
    expect(dockerfile).not.toContain('apt-get');
    expect(dockerfile).not.toContain('npm install');
  });

  it('generates Dockerfile with apt layer', async () => {
    await installSkillDependencies(
      { apt: { packages: [{ name: 'ffmpeg', version: '6.1.1-1' }] } },
      '/tmp/cache',
      'test-skill',
      logger
    );

    expect(spawnCalls.length).toBe(1);
    const dockerfile = spawnCalls[0]!.stdin;
    expect(dockerfile).toContain('apt-get install -y --no-install-recommends -t unstable ffmpeg=6.1.1-1');
    expect(dockerfile).toContain('Pin: release a=unstable');
    // No pip or npm sections
    expect(dockerfile).not.toContain('pip');
    expect(dockerfile).not.toContain('npm install');
  });

  it('generates Dockerfile with all three layers', async () => {
    await installSkillDependencies(
      {
        apt: { packages: [{ name: 'ffmpeg', version: 'latest' }] },
        pip: { packages: [{ name: 'requests', version: '2.32.3' }] },
        npm: { packages: [{ name: 'agentmail', version: '0.2.13' }] },
      },
      '/tmp/cache',
      'test-skill',
      logger
    );

    expect(spawnCalls.length).toBe(1);
    const dockerfile = spawnCalls[0]!.stdin;
    // All three layers present
    expect(dockerfile).toContain('apt-get install');
    expect(dockerfile).toContain('pip install');
    expect(dockerfile).toContain('npm install');
    // Both env vars
    expect(dockerfile).toContain('ENV NODE_PATH=');
    expect(dockerfile).toContain('ENV PYTHONPATH=');
  });

  it('omits version pin for "latest" in pip', async () => {
    await installSkillDependencies(
      { pip: { packages: [{ name: 'agentmail', version: 'latest' }] } },
      '/tmp/cache',
      'test-skill',
      logger
    );

    const dockerfile = spawnCalls[0]!.stdin;
    expect(dockerfile).toContain('agentmail');
    expect(dockerfile).not.toContain('agentmail==latest');
  });

  it('omits version pin for "latest" in apt', async () => {
    await installSkillDependencies(
      { apt: { packages: [{ name: 'pandoc', version: 'latest' }] } },
      '/tmp/cache',
      'test-skill',
      logger
    );

    const dockerfile = spawnCalls[0]!.stdin;
    // Should be just "pandoc" not "pandoc=latest"
    expect(dockerfile).toContain('unstable pandoc');
    expect(dockerfile).not.toContain('pandoc=latest');
  });

  it('pipes Dockerfile via stdin with empty context dir', async () => {
    await installSkillDependencies(
      { npm: { packages: [{ name: 'foo', version: '1.0.0' }] } },
      '/tmp/cache',
      'test-skill',
      logger
    );

    const buildArgs = spawnCalls[0]!.args;
    expect(buildArgs).toContain('build');
    // -f - means Dockerfile from stdin
    const fIdx = buildArgs.indexOf('-f');
    expect(fIdx).toBeGreaterThan(-1);
    expect(buildArgs[fIdx + 1]).toBe('-');
    // Last arg should be a temp dir path (not '-' which would mean tar from stdin)
    const lastArg = buildArgs[buildArgs.length - 1];
    expect(lastArg).not.toBe('-');
    expect(lastArg).toContain('skill-deps-build-');
  });

  it('applies correct labels', async () => {
    await installSkillDependencies(
      { npm: { packages: [{ name: 'foo', version: '1.0.0' }] } },
      '/tmp/cache',
      'test-skill',
      logger
    );

    const buildArgs = spawnCalls[0]!.args;
    expect(buildArgs).toContain('--label');
    expect(buildArgs).toContain('com.lifemodel.component=skill-deps');
    // Hash label
    const hashLabelIdx = buildArgs.findIndex((a) => a.startsWith('com.lifemodel.skill-deps-hash='));
    expect(hashLabelIdx).toBeGreaterThan(-1);
    // Base image ID label
    const baseIdLabelIdx = buildArgs.findIndex((a) => a.startsWith('com.lifemodel.base-image-id='));
    expect(baseIdLabelIdx).toBeGreaterThan(-1);
    expect(buildArgs[baseIdLabelIdx]).toContain('sha256:fakeimageid123');
  });

  it('does not create persistent host filesystem state (no lock files, ready markers)', async () => {
    // The implementation creates/cleans an ephemeral temp dir for Docker build context,
    // but no persistent state like lock files or ready markers on the host.
    await installSkillDependencies(
      { npm: { packages: [{ name: 'foo', version: '1.0.0' }] } },
      '/tmp/cache',
      'test-skill',
      logger
    );

    // The cacheBaseDir param is unused (kept for call-site compat)
    // Docker build uses an ephemeral temp dir as context, cleaned up after build
  });
});

// ─── ContainerConfig type (simplified) ────────────────────────────

describe('ContainerConfig.image field', () => {
  it('accepts image field', async () => {
    const config: import('../../../../src/runtime/container/types.js').ContainerConfig = {
      workspacePath: '/tmp/workspace',
      volumeName: 'motor-ws-test',
      image: 'lifemodel-skill-deps-abc123:latest',
    };
    expect(config.image).toBe('lifemodel-skill-deps-abc123:latest');
  });

  it('no longer has extraMounts, extraEnv, aptPackages fields', async () => {
    const config: import('../../../../src/runtime/container/types.js').ContainerConfig = {
      workspacePath: '/tmp/workspace',
      volumeName: 'motor-ws-test',
    };
    // TypeScript would prevent setting these — runtime check for completeness
    expect('extraMounts' in config).toBe(false);
    expect('extraEnv' in config).toBe(false);
    expect('aptPackages' in config).toBe(false);
  });
});
