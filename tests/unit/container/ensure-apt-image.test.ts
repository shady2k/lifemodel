/**
 * Tests for ensureAptImage() in container-manager.ts
 *
 * Tests the derived Docker image build flow for apt packages.
 * Uses targeted mocking of Docker CLI commands.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '../../../src/types/index.js';

// ─── Mock setup ──────────────────────────────────────────────────

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: 'info',
  } as unknown as Logger;
}

interface ExecCall {
  cmd: string;
  args: string[];
}

interface SpawnCall {
  cmd: string;
  args: string[];
  stdin: string;
}

function setupMocks(opts: {
  imageInspectResult?: 'hit' | 'miss' | 'mismatch';
  baseImageId?: string;
  buildExitCode?: number;
  buildStderr?: string;
}) {
  const execCalls: ExecCall[] = [];
  const spawnCalls: SpawnCall[] = [];

  const {
    imageInspectResult = 'miss',
    baseImageId = 'sha256:abc123',
    buildExitCode = 0,
    buildStderr = '',
  } = opts;

  vi.doMock('node:child_process', () => ({
    execFile: vi.fn(
      (
        cmd: string,
        args: string[],
        optsOrCb: unknown,
        cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void
      ) => {
        execCalls.push({ cmd, args: [...args] });
        const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;

        // docker inspect --format {{.Config.Labels}} <image>
        if (cmd === 'docker' && args[0] === 'inspect' && args[1] === '--format' && args[2]?.includes('Labels')) {
          if (imageInspectResult === 'hit') {
            const labels = {
              'com.lifemodel.component': 'apt-deps',
              'com.lifemodel.apt-hash': 'will-be-checked',
              'com.lifemodel.base-image-id': baseImageId,
              'com.lifemodel.schema-version': '1',
            };
            (callback as any)(null, { stdout: JSON.stringify(labels), stderr: '' });
          } else if (imageInspectResult === 'mismatch') {
            const labels = {
              'com.lifemodel.component': 'apt-deps',
              'com.lifemodel.apt-hash': 'wrong-hash',
              'com.lifemodel.base-image-id': 'wrong-id',
              'com.lifemodel.schema-version': '0',
            };
            (callback as any)(null, { stdout: JSON.stringify(labels), stderr: '' });
          } else {
            (callback as any)(new Error('No such image'), { stdout: '', stderr: '' });
          }
          return;
        }

        // docker inspect --format {{.Id}} <baseImage>
        if (cmd === 'docker' && args[0] === 'inspect' && args[1] === '--format' && args[2] === '{{.Id}}') {
          (callback as any)(null, { stdout: baseImageId, stderr: '' });
          return;
        }

        // Default: succeed
        (callback as any)(null, { stdout: '', stderr: '' });
      }
    ),
    spawn: vi.fn((cmd: string, args: string[], _opts: unknown) => {
      const stdinData: string[] = [];
      const proc = {
        stdin: {
          write: vi.fn((data: string) => { stdinData.push(data); }),
          end: vi.fn(() => {
            spawnCalls.push({ cmd, args: [...args], stdin: stdinData.join('') });
          }),
        },
        stdout: { on: vi.fn() },
        stderr: {
          on: vi.fn((_event: string, handler: (chunk: Buffer) => void) => {
            if (buildStderr) {
              handler(Buffer.from(buildStderr));
            }
          }),
        },
        on: vi.fn((event: string, handler: (code: number) => void) => {
          if (event === 'close') {
            // Simulate async build completion
            setTimeout(() => handler(buildExitCode), 10);
          }
        }),
        kill: vi.fn(),
      };
      return proc;
    }),
  }));

  // Mock fs
  vi.doMock('node:fs', () => ({
    existsSync: vi.fn(() => false),
  }));

  vi.doMock('node:fs/promises', () => ({
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ mtimeMs: 0 }),
  }));

  return { execCalls, spawnCalls };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('ensureAptImage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('skips build on cache hit (labels match)', async () => {
    vi.resetModules();
    // For cache hit, we need the inspect to return labels that match.
    // We use a custom mock that returns the expected labels dynamically.
    const execCalls: ExecCall[] = [];
    const spawnCalls: SpawnCall[] = [];
    const baseImageId = 'sha256:abc123';

    vi.doMock('node:child_process', () => ({
      execFile: vi.fn(
        (
          cmd: string,
          args: string[],
          optsOrCb: unknown,
          cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          execCalls.push({ cmd, args: [...args] });
          const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;

          // docker inspect --format {{.Config.Labels}} <image>
          if (cmd === 'docker' && args[0] === 'inspect' && args[2]?.includes('Labels')) {
            // Return labels that will match any hash (we dynamically extract from image name)
            const imageName = args[3] ?? '';
            const match = /apt-([0-9a-f]{16})/.exec(imageName);
            const hash = match ? match[1] : 'unknown';
            const labels = {
              'com.lifemodel.component': 'apt-deps',
              'com.lifemodel.apt-hash': hash,
              'com.lifemodel.base-image-id': baseImageId,
              'com.lifemodel.schema-version': '1',
            };
            (callback as any)(null, { stdout: JSON.stringify(labels), stderr: '' });
            return;
          }

          // docker inspect --format {{.Id}} <baseImage>
          if (cmd === 'docker' && args[0] === 'inspect' && args[2] === '{{.Id}}') {
            (callback as any)(null, { stdout: baseImageId, stderr: '' });
            return;
          }

          (callback as any)(null, { stdout: '', stderr: '' });
        }
      ),
      spawn: vi.fn(() => {
        throw new Error('spawn should not be called on cache hit');
      }),
    }));

    vi.doMock('node:fs', () => ({ existsSync: vi.fn(() => false) }));
    vi.doMock('node:fs/promises', () => ({
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ mtimeMs: 0 }),
    }));

    const { ensureAptImage } = await import('../../../src/runtime/container/container-manager.js');
    const logger = createMockLogger();

    const result = await ensureAptImage(
      [{ name: 'ffmpeg', version: '6.1.1-1' }],
      'lifemodel-motor:latest',
      '/tmp/apt-cache',
      logger
    );

    expect(result).toMatch(/^lifemodel-motor-apt-[0-9a-f]{16}:latest$/);
    // No build should be triggered — cache hit
    expect(spawnCalls.length).toBe(0);
  });

  it('triggers build on cache miss', async () => {
    vi.resetModules();
    const { spawnCalls } = setupMocks({ imageInspectResult: 'miss' });
    const { ensureAptImage } = await import('../../../src/runtime/container/container-manager.js');
    const logger = createMockLogger();

    const result = await ensureAptImage(
      [{ name: 'ffmpeg', version: '6.1.1-1' }],
      'lifemodel-motor:latest',
      '/tmp/apt-cache',
      logger
    );

    expect(result).toMatch(/^lifemodel-motor-apt-[0-9a-f]{16}:latest$/);
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].args).toContain('build');
  });

  it('generates deterministic hash for same packages + base image', async () => {
    vi.resetModules();
    setupMocks({ imageInspectResult: 'miss' });
    const { ensureAptImage } = await import('../../../src/runtime/container/container-manager.js');
    const logger = createMockLogger();

    const result1 = await ensureAptImage(
      [{ name: 'ffmpeg', version: '6.1.1-1' }],
      'lifemodel-motor:latest',
      '/tmp/apt-cache',
      logger
    );

    vi.resetModules();
    setupMocks({ imageInspectResult: 'miss' });
    const mod2 = await import('../../../src/runtime/container/container-manager.js');
    const logger2 = createMockLogger();

    const result2 = await mod2.ensureAptImage(
      [{ name: 'ffmpeg', version: '6.1.1-1' }],
      'lifemodel-motor:latest',
      '/tmp/apt-cache',
      logger2
    );

    expect(result1).toBe(result2);
  });

  it('hash changes when base image changes', async () => {
    vi.resetModules();
    setupMocks({ imageInspectResult: 'miss', baseImageId: 'sha256:aaa' });
    const mod1 = await import('../../../src/runtime/container/container-manager.js');
    const logger1 = createMockLogger();

    const result1 = await mod1.ensureAptImage(
      [{ name: 'ffmpeg', version: 'latest' }],
      'lifemodel-motor:latest',
      '/tmp/apt-cache',
      logger1
    );

    vi.resetModules();
    setupMocks({ imageInspectResult: 'miss', baseImageId: 'sha256:bbb' });
    const mod2 = await import('../../../src/runtime/container/container-manager.js');
    const logger2 = createMockLogger();

    const result2 = await mod2.ensureAptImage(
      [{ name: 'ffmpeg', version: 'latest' }],
      'lifemodel-motor:latest',
      '/tmp/apt-cache',
      logger2
    );

    expect(result1).not.toBe(result2);
  });

  it('builds Dockerfile with version pinning', async () => {
    vi.resetModules();
    const { spawnCalls } = setupMocks({ imageInspectResult: 'miss' });
    const { ensureAptImage } = await import('../../../src/runtime/container/container-manager.js');
    const logger = createMockLogger();

    await ensureAptImage(
      [{ name: 'ffmpeg', version: '6.1.1-1' }],
      'lifemodel-motor:latest',
      '/tmp/apt-cache',
      logger
    );

    expect(spawnCalls.length).toBe(1);
    const dockerfile = spawnCalls[0].stdin;
    expect(dockerfile).toContain('ffmpeg=6.1.1-1');
    expect(dockerfile).toContain('apt-get install -y --no-install-recommends -t unstable');
    expect(dockerfile).toContain('Pin: release a=unstable');
    expect(dockerfile).toContain('Pin-Priority: 100');
  });

  it('handles "latest" version without pinning', async () => {
    vi.resetModules();
    const { spawnCalls } = setupMocks({ imageInspectResult: 'miss' });
    const { ensureAptImage } = await import('../../../src/runtime/container/container-manager.js');
    const logger = createMockLogger();

    await ensureAptImage(
      [{ name: 'yt-dlp', version: 'latest' }],
      'lifemodel-motor:latest',
      '/tmp/apt-cache',
      logger
    );

    const dockerfile = spawnCalls[0].stdin;
    expect(dockerfile).toContain('yt-dlp');
    expect(dockerfile).not.toContain('yt-dlp=');
  });

  it('rejects duplicate package names', async () => {
    vi.resetModules();
    setupMocks({ imageInspectResult: 'miss' });
    const { ensureAptImage } = await import('../../../src/runtime/container/container-manager.js');
    const logger = createMockLogger();

    await expect(
      ensureAptImage(
        [
          { name: 'ffmpeg', version: '6.1.1-1' },
          { name: 'ffmpeg', version: '6.1.1-2' },
        ],
        'lifemodel-motor:latest',
        '/tmp/apt-cache',
        logger
      )
    ).rejects.toThrow('Duplicate apt package: ffmpeg');
  });

  it('rejects invalid package names', async () => {
    vi.resetModules();
    setupMocks({ imageInspectResult: 'miss' });
    const { ensureAptImage } = await import('../../../src/runtime/container/container-manager.js');
    const logger = createMockLogger();

    await expect(
      ensureAptImage(
        [{ name: '../../../etc/passwd', version: '1.0' }],
        'lifemodel-motor:latest',
        '/tmp/apt-cache',
        logger
      )
    ).rejects.toThrow('Invalid apt package name');
  });

  it('surfaces apt error on build failure', async () => {
    vi.resetModules();
    setupMocks({
      imageInspectResult: 'miss',
      buildExitCode: 1,
      buildStderr: 'E: Unable to locate package nonexistent-pkg',
    });
    const { ensureAptImage } = await import('../../../src/runtime/container/container-manager.js');
    const logger = createMockLogger();

    await expect(
      ensureAptImage(
        [{ name: 'nonexistent-pkg', version: 'latest' }],
        'lifemodel-motor:latest',
        '/tmp/apt-cache',
        logger
      )
    ).rejects.toThrow('Unable to locate package');
  });

  it('rebuilds when labels mismatch', async () => {
    vi.resetModules();
    const { spawnCalls } = setupMocks({ imageInspectResult: 'mismatch' });
    const { ensureAptImage } = await import('../../../src/runtime/container/container-manager.js');
    const logger = createMockLogger();

    const result = await ensureAptImage(
      [{ name: 'ffmpeg', version: 'latest' }],
      'lifemodel-motor:latest',
      '/tmp/apt-cache',
      logger
    );

    expect(result).toMatch(/^lifemodel-motor-apt-/);
    // Should have triggered a build despite inspect succeeding
    expect(spawnCalls.length).toBe(1);
  });

  it('uses labels for image identification', async () => {
    vi.resetModules();
    const { spawnCalls } = setupMocks({ imageInspectResult: 'miss' });
    const { ensureAptImage } = await import('../../../src/runtime/container/container-manager.js');
    const logger = createMockLogger();

    await ensureAptImage(
      [{ name: 'ffmpeg', version: 'latest' }],
      'lifemodel-motor:latest',
      '/tmp/apt-cache',
      logger
    );

    const buildArgs = spawnCalls[0].args;
    expect(buildArgs).toContain('--label');
    expect(buildArgs).toContain('com.lifemodel.component=apt-deps');
    // Check hash label is present
    const hashLabelIdx = buildArgs.findIndex(
      (a) => typeof a === 'string' && a.startsWith('com.lifemodel.apt-hash=')
    );
    expect(hashLabelIdx).toBeGreaterThan(-1);
  });
});
