/**
 * Tests for dependency-manager.ts
 *
 * Covers: hash computation, validation (via skill-loader).
 * Docker/fs-heavy tests for install flow use targeted mocking.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// ─── Verification helpers ─────────────────────────────────────────

describe('verifyNpmInstall', () => {
  let verifyNpmInstall: typeof import('../../../../src/runtime/dependencies/dependency-manager.js').verifyNpmInstall;
  let tmpDir: string;

  beforeEach(async () => {
    const mod = await import('../../../../src/runtime/dependencies/dependency-manager.js');
    verifyNpmInstall = mod.verifyNpmInstall;
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    tmpDir = await mkdtemp(join(tmpdir(), 'verify-npm-'));
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when node_modules directory is missing', () => {
    expect(() =>
      verifyNpmInstall(tmpDir, [{ name: 'agentmail', version: '0.2.13' }])
    ).toThrow('npm install did not produce node_modules directory');
  });

  it('throws when a declared package is missing from node_modules', async () => {
    const { mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    // Create node_modules but not the package subdir
    await mkdir(join(tmpDir, 'node_modules'), { recursive: true });

    expect(() =>
      verifyNpmInstall(tmpDir, [{ name: 'agentmail', version: '0.2.13' }])
    ).toThrow('npm install completed but missing packages: agentmail@0.2.13');
  });

  it('lists all missing packages in error message', async () => {
    const { mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await mkdir(join(tmpDir, 'node_modules'), { recursive: true });

    expect(() =>
      verifyNpmInstall(tmpDir, [
        { name: 'foo', version: '1.0.0' },
        { name: 'bar', version: '2.0.0' },
      ])
    ).toThrow('npm install completed but missing packages: foo@1.0.0, bar@2.0.0');
  });

  it('passes when all packages are present', async () => {
    const { mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await mkdir(join(tmpDir, 'node_modules', 'agentmail'), { recursive: true });

    expect(() =>
      verifyNpmInstall(tmpDir, [{ name: 'agentmail', version: '0.2.13' }])
    ).not.toThrow();
  });

  it('handles scoped packages (@scope/name)', async () => {
    const { mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await mkdir(join(tmpDir, 'node_modules', '@anthropic', 'sdk'), { recursive: true });

    expect(() =>
      verifyNpmInstall(tmpDir, [{ name: '@anthropic/sdk', version: '1.0.0' }])
    ).not.toThrow();
  });
});

describe('verifyPipInstall', () => {
  let verifyPipInstall: typeof import('../../../../src/runtime/dependencies/dependency-manager.js').verifyPipInstall;
  let tmpDir: string;

  beforeEach(async () => {
    const mod = await import('../../../../src/runtime/dependencies/dependency-manager.js');
    verifyPipInstall = mod.verifyPipInstall;
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    tmpDir = await mkdtemp(join(tmpdir(), 'verify-pip-'));
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when site-packages directory is missing', async () => {
    await expect(verifyPipInstall(tmpDir)).rejects.toThrow(
      'pip install did not produce site-packages directory'
    );
  });

  it('throws when site-packages is empty', async () => {
    const { mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await mkdir(join(tmpDir, 'site-packages'), { recursive: true });

    await expect(verifyPipInstall(tmpDir)).rejects.toThrow(
      'pip install produced empty site-packages directory'
    );
  });

  it('passes when site-packages has content', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await mkdir(join(tmpDir, 'site-packages', 'requests'), { recursive: true });
    await writeFile(join(tmpDir, 'site-packages', 'requests', '__init__.py'), '');

    await expect(verifyPipInstall(tmpDir)).resolves.toBeUndefined();
  });
});

// ─── Docker command construction (mocked execFile) ───────────────

/** Shared mock setup for install-flow tests */
function setupInstallMocks(execCalls: Array<{ cmd: string; args: string[] }>) {
  vi.doMock('node:child_process', () => ({
    execFile: vi.fn(
      (
        cmd: string,
        args: string[],
        opts: unknown,
        cb?: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        execCalls.push({ cmd, args: [...args] });
        // Make "docker volume inspect" fail (cache miss) to trigger install flow
        const isVolumeInspect =
          cmd === 'docker' && args[0] === 'volume' && args[1] === 'inspect';
        const err = isVolumeInspect ? new Error('No such volume') : null;
        if (typeof cb === 'function') {
          cb(err, '', '');
        } else if (typeof opts === 'function') {
          (opts as (err: Error | null, stdout: string, stderr: string) => void)(err, '', '');
        }
      }
    ),
  }));

  vi.doMock('node:fs', async (importOriginal) => {
    const orig = (await importOriginal()) as typeof import('node:fs');
    return {
      ...orig,
      existsSync: vi.fn((p: string) => {
        if (String(p).includes('.lock')) return false;
        return false;
      }),
    };
  });

  vi.doMock('node:fs/promises', async (importOriginal) => {
    const orig = (await importOriginal()) as typeof import('node:fs/promises');
    return {
      ...orig,
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ mtimeMs: 0 }),
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

describe('npm prep container commands', () => {
  let execCalls: Array<{ cmd: string; args: string[] }>;
  let installSkillDependencies: typeof import('../../../../src/runtime/dependencies/dependency-manager.js').installSkillDependencies;
  let logger: any;

  beforeEach(async () => {
    vi.resetModules();
    execCalls = [];
    setupInstallMocks(execCalls);
    const mod = await import('../../../../src/runtime/dependencies/dependency-manager.js');
    installSkillDependencies = mod.installSkillDependencies;
    logger = createMockLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses --name instead of --rm for prep container', async () => {
    await installSkillDependencies(
      { npm: { packages: [{ name: 'agentmail', version: '0.2.13' }] } },
      '/tmp/cache',
      'test-skill',
      logger
    );

    const runCall = execCalls.find(
      (c) => c.cmd === 'docker' && c.args[0] === 'run'
    );
    expect(runCall).toBeDefined();
    expect(runCall!.args).toContain('--name');
    expect(runCall!.args).not.toContain('--rm');
  });

  it('mounts a named Docker volume (not a host path bind mount)', async () => {
    await installSkillDependencies(
      { npm: { packages: [{ name: 'agentmail', version: '0.2.13' }] } },
      '/tmp/cache',
      'test-skill',
      logger
    );

    const runCall = execCalls.find(
      (c) => c.cmd === 'docker' && c.args[0] === 'run'
    );
    expect(runCall).toBeDefined();
    const vIdx = runCall!.args.indexOf('-v');
    expect(vIdx).toBeGreaterThan(-1);
    const mountArg = runCall!.args[vIdx + 1];
    // Named volume: starts with "lifemodel-deps-", NOT with "/"
    expect(mountArg).toMatch(/^lifemodel-deps-npm-[0-9a-f]+:\/workspace\/deps$/);
  });

  it('uses /workspace/deps inside container (not /deps)', async () => {
    await installSkillDependencies(
      { npm: { packages: [{ name: 'agentmail', version: '0.2.13' }] } },
      '/tmp/cache',
      'test-skill',
      logger
    );

    const runCall = execCalls.find(
      (c) => c.cmd === 'docker' && c.args[0] === 'run'
    );
    const shellCmd = runCall!.args[runCall!.args.length - 1];
    expect(shellCmd).toContain('/workspace/deps');
    expect(shellCmd).not.toMatch(/(^|\s)\/deps\//);
  });

  it('does not use docker cp (no host filesystem involvement)', async () => {
    await installSkillDependencies(
      { npm: { packages: [{ name: 'agentmail', version: '0.2.13' }] } },
      '/tmp/cache',
      'test-skill',
      logger
    );

    const cpCall = execCalls.find(
      (c) => c.cmd === 'docker' && c.args[0] === 'cp'
    );
    expect(cpCall).toBeUndefined();
  });

  it('checks cache via docker volume inspect', async () => {
    await installSkillDependencies(
      { npm: { packages: [{ name: 'agentmail', version: '0.2.13' }] } },
      '/tmp/cache',
      'test-skill',
      logger
    );

    const volumeInspect = execCalls.find(
      (c) => c.cmd === 'docker' && c.args[0] === 'volume' && c.args[1] === 'inspect'
    );
    expect(volumeInspect).toBeDefined();
    expect(volumeInspect!.args[2]).toMatch(/^lifemodel-deps-npm-/);
  });

  it('bakes package verification into shell command', async () => {
    await installSkillDependencies(
      { npm: { packages: [{ name: 'agentmail', version: '0.2.13' }] } },
      '/tmp/cache',
      'test-skill',
      logger
    );

    const runCall = execCalls.find(
      (c) => c.cmd === 'docker' && c.args[0] === 'run'
    );
    const shellCmd = runCall!.args[runCall!.args.length - 1];
    expect(shellCmd).toContain('test -d /workspace/deps/node_modules/agentmail');
  });

  it('removes named container in finally block', async () => {
    await installSkillDependencies(
      { npm: { packages: [{ name: 'agentmail', version: '0.2.13' }] } },
      '/tmp/cache',
      'test-skill',
      logger
    );

    const rmCall = execCalls.find(
      (c) => c.cmd === 'docker' && c.args[0] === 'rm'
    );
    expect(rmCall).toBeDefined();
    expect(rmCall!.args).toContain('-f');
  });

  it('includes package.json content inline in shell command', async () => {
    await installSkillDependencies(
      { npm: { packages: [{ name: 'agentmail', version: '0.2.13' }] } },
      '/tmp/cache',
      'test-skill',
      logger
    );

    const runCall = execCalls.find(
      (c) => c.cmd === 'docker' && c.args[0] === 'run'
    );
    const shellCmd = runCall!.args[runCall!.args.length - 1];
    expect(shellCmd).toContain('agentmail');
    expect(shellCmd).toContain('0.2.13');
    expect(shellCmd).toContain("printf '%s'");
  });

  it('returns a volume name (not a host path)', async () => {
    const result = await installSkillDependencies(
      { npm: { packages: [{ name: 'agentmail', version: '0.2.13' }] } },
      '/tmp/cache',
      'test-skill',
      logger
    );

    expect(result).toBeDefined();
    expect(result!.npmDir).toMatch(/^lifemodel-deps-npm-[0-9a-f]{16}$/);
  });
});

describe('pip prep container commands', () => {
  let execCalls: Array<{ cmd: string; args: string[] }>;
  let installSkillDependencies: typeof import('../../../../src/runtime/dependencies/dependency-manager.js').installSkillDependencies;
  let logger: any;

  beforeEach(async () => {
    vi.resetModules();
    execCalls = [];
    setupInstallMocks(execCalls);
    const mod = await import('../../../../src/runtime/dependencies/dependency-manager.js');
    installSkillDependencies = mod.installSkillDependencies;
    logger = createMockLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mounts a named Docker volume for pip', async () => {
    await installSkillDependencies(
      { pip: { packages: [{ name: 'requests', version: '2.32.3' }] } },
      '/tmp/cache',
      'test-skill',
      logger
    );

    const runCall = execCalls.find(
      (c) => c.cmd === 'docker' && c.args[0] === 'run'
    );
    expect(runCall).toBeDefined();
    const vIdx = runCall!.args.indexOf('-v');
    expect(vIdx).toBeGreaterThan(-1);
    const mountArg = runCall!.args[vIdx + 1];
    expect(mountArg).toMatch(/^lifemodel-deps-pip-[0-9a-f]+:\/workspace\/deps$/);
  });

  it('uses /workspace/deps inside container for pip', async () => {
    await installSkillDependencies(
      { pip: { packages: [{ name: 'requests', version: '2.32.3' }] } },
      '/tmp/cache',
      'test-skill',
      logger
    );

    const runCall = execCalls.find(
      (c) => c.cmd === 'docker' && c.args[0] === 'run'
    );
    const shellCmd = runCall!.args[runCall!.args.length - 1];
    expect(shellCmd).toContain('/workspace/deps');
    expect(shellCmd).not.toMatch(/(^|\s)\/deps\//);
  });

  it('does not use docker cp for pip', async () => {
    await installSkillDependencies(
      { pip: { packages: [{ name: 'requests', version: '2.32.3' }] } },
      '/tmp/cache',
      'test-skill',
      logger
    );

    const cpCall = execCalls.find(
      (c) => c.cmd === 'docker' && c.args[0] === 'cp'
    );
    expect(cpCall).toBeUndefined();
  });

  it('returns a volume name for pip', async () => {
    const result = await installSkillDependencies(
      { pip: { packages: [{ name: 'requests', version: '2.32.3' }] } },
      '/tmp/cache',
      'test-skill',
      logger
    );

    expect(result).toBeDefined();
    expect(result!.pipDir).toMatch(/^lifemodel-deps-pip-[0-9a-f]{16}$/);
    expect(result!.pipPythonPath).toContain('/opt/skill-deps/pip/site-packages');
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
