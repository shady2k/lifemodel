/**
 * Unit tests for scripts/test-docker-isolated.mjs (lifemodel-q4x.5.3).
 *
 * These tests exercise the helper's public orchestration seams only: CLI
 * parsing, snapshot validation, the pure plan (machine create/teardown argv,
 * stdin-only source transfer, credential-free test environment) and the
 * runner driven by a fake orb invoker. No machine is created and no orbctl,
 * network or owner Docker socket is touched here; the real machine walk is
 * the isolated acceptance run.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ActiveRunError,
  EXIT_FAILURE,
  EXIT_SIGINT,
  EXIT_SIGTERM,
  EXIT_TIMEOUT,
  EXIT_USAGE,
  IsolationError,
  MACHINE_CPUS,
  MACHINE_DISK,
  MACHINE_IMAGE,
  MACHINE_MEMORY,
  MACHINE_NAME_PATTERN,
  MACHINE_PREFIX,
  MACHINE_USER,
  PHASE_TIMEOUTS_MS,
  PINNED,
  acquireLock,
  buildPlan,
  createRunner,
  createOrbInvoker,
  ensureArtifacts,
  findOrbctl,
  isProcessAlive,
  machineArch,
  machineCreateArgv,
  makeMachineName,
  parseArgs,
  recoverStale,
  releaseLock,
  requireSupportedHost,
  rootlessSocketPath,
  scrubEnv,
  teardownStep,
  usageText,
  UsageError,
  validateSnapshot,
  vitestEnv,
  vitestSteps,
} from '../../scripts/test-docker-isolated.mjs';

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// fake invoker: records every step, answers per-step exit codes
function fakeInvoker(responses: Record<string, number> = {}, hanging: string[] = []) {
  const calls: Array<{ id: string; argv: string[]; kind: string; step: any }> = [];
  const invoker = {
    calls,
    killCount: 0,
    async runStep(step: any) {
      calls.push({ id: step.id, argv: step.argv ?? [], kind: step.kind, step });
      if (hanging.includes(step.id)) return new Promise(() => undefined);
      return { code: responses[step.id] ?? 0, stdout: step.capture ? '1000\n' : '' };
    },
    killActive() {
      invoker.killCount += 1;
    },
  };
  return invoker;
}

const tmpDirs: string[] = [];

function trackTmp(dir: string): string {
  tmpDirs.push(dir);
  return dir;
}

const FIXTURE_FILES = { 'docker.tgz': 'a', 'rootless.tgz': 'b', 'node.tar.xz': 'c' };
const ARTIFACTS = Object.keys(FIXTURE_FILES).map((file) => ({
  key: file,
  file,
  hostPath: `/cache/${file}`,
}));

function testRunner(overrides: Record<string, unknown> = {}, invoker: any = fakeInvoker()) {
  const defaults = {
    invoker,
    machineName: makeMachineName('0123456789abcdef'),
    snapshotPath: '/private-snapshot/source',
    vitestArgs: ['tests/integration/docker.test.ts'],
    artifacts: ARTIFACTS,
    artifactsHostDir: '/cache',
    bootstrapScriptDir: '/repo/docker/test',
    bootstrapScriptName: 'bootstrap-orb.sh',
    stateDir: trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'test-docker-isolated-state-'))),
    deadlineMs: 60_000,
    log: () => {},
  };
  return createRunner({ ...defaults, ...overrides } as any);
}

describe('parseArgs', () => {
  it('parses the launcher contract', () => {
    const parsed = parseArgs([
      '--snapshot',
      '/private/snapshot',
      '--timeout',
      '3600000',
      '--',
      'tests/integration/docker.test.ts',
      '--silent',
    ]);
    expect(parsed.snapshot).toBe('/private/snapshot');
    expect(parsed.timeoutMs).toBe(3_600_000);
    expect(parsed.vitestArgs).toEqual(['tests/integration/docker.test.ts', '--silent']);
  });

  it('accepts no vitest arguments after --', () => {
    const parsed = parseArgs(['--snapshot', '/s', '--timeout', '1000', '--']);
    expect(parsed.vitestArgs).toEqual([]);
  });

  it('rejects a missing snapshot', () => {
    expect(() => parseArgs(['--timeout', '1000', '--'])).toThrow(UsageError);
    expect(() => parseArgs(['--timeout', '1000', '--'])).toThrow(/missing required --snapshot/);
  });

  it('rejects a missing timeout', () => {
    expect(() => parseArgs(['--snapshot', '/s', '--'])).toThrow(/missing required --timeout/);
  });

  it('rejects a non-numeric or non-positive timeout', () => {
    expect(() => parseArgs(['--snapshot', '/s', '--timeout', 'abc', '--'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--snapshot', '/s', '--timeout', '0', '--'])).toThrow(/positive integer/);
  });

  it('rejects missing values and unknown options', () => {
    expect(() => parseArgs(['--snapshot', '--timeout', '1000', '--'])).toThrow(/missing value/);
    expect(() => parseArgs(['--snapshot', '/s', '--timeout', '1000', '--wat', '--'])).toThrow(/unknown option/);
  });

  it('rejects positionals before --', () => {
    expect(() => parseArgs(['--snapshot', '/s', 'stray', '--timeout', '1000'])).toThrow(/unexpected positional/);
  });

  it('prints usage with --help and reserves exit codes 124/130/143/2', () => {
    expect(usageText()).toContain('--snapshot');
    expect(usageText()).toContain('vitest run');
    expect(EXIT_USAGE).toBe(2);
    expect(EXIT_TIMEOUT).toBe(124);
    expect(EXIT_SIGINT).toBe(130);
    expect(EXIT_SIGTERM).toBe(143);
  });
});

describe('validateSnapshot', () => {
  let root: string;
  let outside: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-valid-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};\n');
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('accepts a clean regular-file snapshot', async () => {
    const r = await validateSnapshot(root);
    expect(r.path).toBe(await fsp.realpath(root));
    expect(r.entries).toBeGreaterThan(0);
  });

  it('rejects a missing directory', async () => {
    await expect(validateSnapshot(path.join(os.tmpdir(), 'definitely-missing-dir-x9'))).rejects.toThrow(
      /not readable/,
    );
  });

  it('rejects a missing package manifest', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-nopkg-'));
    try {
      fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
      await expect(validateSnapshot(dir)).rejects.toThrow(/missing package\.json/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a .git directory at the root and nested', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-git-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}');
      fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
      fs.mkdirSync(path.join(dir, '.git'));
      fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      fs.mkdirSync(path.join(dir, 'vendor'));
      fs.mkdirSync(path.join(dir, 'vendor', '.git'));
      await expect(validateSnapshot(dir)).rejects.toThrow(/\.git/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects absolute and escaping symlinks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-links-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}');
      fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
      fs.symlinkSync('/etc/passwd', path.join(dir, 'abs-link'));
      fs.symlinkSync(path.join(outside, 'leaked.txt'), path.join(dir, 'escape-link'));
      await expect(validateSnapshot(dir)).rejects.toThrow(/unsafe symlink/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects relative links and owner credentials on direct helper calls', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-direct-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}'); fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
      fs.symlinkSync('package.json', path.join(dir, 'inside-link'));
      await expect(validateSnapshot(dir)).rejects.toThrow(/symlink/);
      fs.rmSync(path.join(dir, 'inside-link')); fs.writeFileSync(path.join(dir, '.env'), 'KEY=synthetic');
      await expect(validateSnapshot(dir)).rejects.toThrow(/forbidden/);
      fs.rmSync(path.join(dir, '.env')); fs.writeFileSync(path.join(dir, '.npmrc'), '_authToken=synthetic');
      await expect(validateSnapshot(dir)).rejects.toThrow(/npmrc policy/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects a snapshot that is a file, not a directory', async () => {
    const file = path.join(os.tmpdir(), `snapshot-file-${Date.now()}.json`);
    fs.writeFileSync(file, '{}');
    try {
      await expect(validateSnapshot(file)).rejects.toThrow(/not a directory/);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

describe('machine identity', () => {
  it('machine names carry the owned prefix', () => {
    const name = makeMachineName('abcdef0123456789');
    expect(name.startsWith(MACHINE_PREFIX)).toBe(true);
    expect(MACHINE_NAME_PATTERN.test(name)).toBe(true);
    expect(() => makeMachineName('not-hex')).toThrow(IsolationError);
    expect(() => makeMachineName('short')).toThrow(IsolationError);
  });

  it('machine create argv is the verified isolated OrbStack machine shape', () => {
    const argv = machineCreateArgv('lifemodel-test-abcdef0123456789');
    expect(argv).toEqual([
      'create',
      '--isolated',
      '--isolate-network',
      '--cpus', MACHINE_CPUS,
      '--memory', MACHINE_MEMORY,
      '--disk', MACHINE_DISK,
      '-u', MACHINE_USER,
      MACHINE_IMAGE,
      'lifemodel-test-abcdef0123456789',
    ]);
    expect(argv).not.toContain('--privileged');
    expect(argv).not.toContain('--mount');
    expect(argv).not.toContain('--forward-ssh-agent');
  });

  it('teardown deletes exactly the owned machine, never --all', () => {
    const step = teardownStep('lifemodel-test-abcdef0123456789');
    expect(step.argv).toEqual(['delete', '--force', 'lifemodel-test-abcdef0123456789']);
  });

  it('scrubs the host environment to an allowlist', () => {
    const scrubbed = scrubEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/owner',
      TMPDIR: '/tmp',
      TERM: 'xterm-256color',
      ORBENV: 'machine=evil',
      DOCKER_HOST: 'unix:///var/run/docker.sock',
      SSH_AUTH_SOCK: '/private/tmp/agent.sock',
      GIT_AUTHOR_NAME: 'owner',
      NPM_CONFIG_REGISTRY: 'https://evil.example',
      AWS_SECRET_ACCESS_KEY: 'x',
    });
    expect(scrubbed).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/owner',
      TMPDIR: '/tmp',
      TERM: 'xterm-256color',
    });
  });
});

describe('buildPlan', () => {
  const machine = makeMachineName('0123456789abcdef');

  it('rejects machine names outside the owned prefix', () => {
    expect(() =>
      buildPlan({
        machineName: 'my-ubuntu-box',
        snapshotPath: '/s',
        artifacts: ARTIFACTS,
        artifactsHostDir: '/cache',
        bootstrapScriptDir: '/repo/docker/test',
      } as any),
    ).toThrow(/owned prefix/);
  });

  it('rejects missing inputs instead of guessing', () => {
    expect(() =>
      buildPlan({ machineName: machine, snapshotPath: '/s', artifacts: [], artifactsHostDir: '/c', bootstrapScriptDir: '/d' } as any),
    ).toThrow(/artifacts/);
    expect(() =>
      buildPlan({
        machineName: machine,
        snapshotPath: '',
        artifacts: ARTIFACTS,
        artifactsHostDir: '/cache',
        bootstrapScriptDir: '/d',
      } as any),
    ).toThrow(/snapshot/);
  });

  it('streams the sanitized snapshot in over stdin, never a host mount', () => {
    const steps = buildPlan({
      machineName: machine,
      snapshotPath: '/Users/owner/private-snapshot',
      artifacts: ARTIFACTS,
      artifactsHostDir: '/cache',
      bootstrapScriptDir: '/repo/docker/test',
    } as any);
    const transfer = steps.find((s) => s.id === 'transfer-source') as any;
    expect(transfer.kind).toBe('tar-stdin');
    // host side: tar of the snapshot only
    expect(transfer.hostTarArgs).toContain('/Users/owner/private-snapshot');
    // machine side: reads the tar stream from stdin
    expect(transfer.argv).toEqual([
      'run', '-m', machine, '--user', MACHINE_USER, '--workdir', '/home/lifemodel/src',
      'tar', '-xf', '-',
    ]);
  });

  it('never exposes a host path in any machine-side argv', () => {
    const steps = buildPlan({
      machineName: machine,
      snapshotPath: '/Users/owner/private-snapshot',
      artifacts: ARTIFACTS,
      artifactsHostDir: '/Users/owner/cache',
      bootstrapScriptDir: '/Users/owner/repo/docker/test',
    } as any);
    for (const step of steps) {
      const joined = step.argv.join(' ');
      expect(joined).not.toContain('/Users/owner');
      expect(joined).not.toContain('--privileged');
      expect(joined).not.toContain('--mount');
      expect(joined).not.toContain('-all');
      expect(joined).not.toContain('ssh');
    }
  });

  it('includes the isolation flag pair, uid discovery and the bootstrap stages', () => {
    const steps = buildPlan({
      machineName: machine,
      snapshotPath: '/s',
      artifacts: ARTIFACTS,
      artifactsHostDir: '/cache',
      bootstrapScriptDir: '/repo/docker/test',
    } as any);
    const ids = steps.map((s) => s.id);
    expect(ids).toEqual([
      'create',
      'boot',
      'stage-dirs',
      'stage-chown-src',
      'stage-artifacts',
      'transfer-source',
      'provision-root',
      'provision-repo',
      'provision-daemon',
      'discover-uid',
    ]);
    expect((steps[0] as any).argv).toEqual(machineCreateArgv(machine));
    const discover = steps.find((s) => s.id === 'discover-uid') as any;
    expect(discover.capture).toBe(true);
    const daemonStage = steps.find((s) => s.id === 'provision-daemon') as any;
    expect(daemonStage.argv).toContain('./bootstrap-orb.sh');
    expect(daemonStage.argv).toContain('daemon');
  });
});

describe('test environment inside the machine', () => {
  it('vitest steps run npm ci with HUSKY=0 and vitest with the private rootless socket', () => {
    const [npmCi, vitest] = vitestSteps({
      machineName: makeMachineName('0123456789abcdef'),
      uid: 1000,
      vitestArgs: ['tests/integration/docker.test.ts'],
    }) as any[];
    const argv = npmCi.argv as string[];
    expect(argv).toContain('npm');
    expect(argv).toContain('ci');
    expect(argv).toContain('HUSKY=0');
    expect(argv).toContain('env');
    expect(argv).toContain('-i');

    const v = vitest.argv as string[];
    const envKvs = v.filter((x) => x.includes('='));
    expect(envKvs).toContain('HUSKY=0');
    expect(envKvs).toContain(`DOCKER_HOST=${rootlessSocketPath(1000)}`);
    expect(envKvs).toContain('HOME=/home/lifemodel');
    expect(envKvs).toContain('XDG_RUNTIME_DIR=/run/user/1000');
    expect(v).toContain('tests/integration/docker.test.ts');
    expect(v.at(-1)).toBe('--maxWorkers=2');
    expect(envKvs).toContain('LIFEMODEL_DOCKER_TESTS=1');
    expect(v).toContain('./node_modules/.bin/vitest');
    expect(v).toContain('run');
  });

  it('DOCKER_HOST is always the machine-private rootless socket, never the owner socket', () => {
    for (const uid of [1000, 1001, 65534]) {
      const env = vitestEnv(uid);
      expect(env.DOCKER_HOST).toBe(`unix:///run/user/${uid}/docker.sock`);
      expect(env.DOCKER_HOST).not.toContain('/var/run/docker.sock');
      expect(env.HOME).toBe('/home/lifemodel');
      expect(env.HUSKY).toBe('0');
      expect(Object.keys(env).some((k) => k.startsWith('GIT_'))).toBe(false);
      expect(Object.keys(env).some((k) => k.startsWith('NPM_'))).toBe(false);
    }
  });

  it('rejects a bogus machine uid', () => {
    expect(() =>
      vitestSteps({ machineName: makeMachineName('0123456789abcdef'), uid: NaN, vitestArgs: [] } as any),
    ).toThrow(/user id/);
    expect(() =>
      vitestSteps({ machineName: makeMachineName('0123456789abcdef'), uid: 0, vitestArgs: [] } as any),
    ).toThrow(/user id/);
  });
});

describe('phase bounds', () => {
  it('every phase is bounded; teardown always has its own window', () => {
    for (const value of Object.values(PHASE_TIMEOUTS_MS)) {
      expect(value).toBeGreaterThan(0);
    }
    expect(PHASE_TIMEOUTS_MS.teardown).toBeLessThanOrEqual(120_000);
  });
});

describe('host guard', () => {
  it('fails closed on non-macOS hosts with a clear message', () => {
    expect(() => requireSupportedHost('darwin')).not.toThrow();
    expect(() => requireSupportedHost('linux')).toThrow(/OrbStack/);
    expect(() => requireSupportedHost('linux')).toThrow(/refuses to run|no fallback/);
    expect(() => requireSupportedHost('win32')).toThrow(/unsupported host platform/i);
  });

  it('finds orbctl and fails closed without it', () => {
    expect(
      findOrbctl({ existsSync: (p: string) => p === '/opt/homebrew/bin/orbctl' }),
    ).toBe('/opt/homebrew/bin/orbctl');
    expect(() => findOrbctl({ existsSync: () => false })).toThrow(/orbctl not found/);
  });

  it('maps the host arch to pinned linux artifacts', () => {
    expect(machineArch('arm64')).toBe('aarch64');
    expect(machineArch('x64')).toBe('x86_64');
    expect(() => machineArch('s390x' as any)).toThrow(IsolationError);
  });

  it('pins official artifact versions and digests', () => {
    expect(PINNED.dockerVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PINNED.nodeVersion).toMatch(/^v24\./);
    for (const key of Object.keys(PINNED.artifacts)) {
      for (const arch of ['aarch64', 'x86_64']) {
        const spec = (PINNED.artifacts as any)[key][arch];
        expect(spec.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(spec.url.startsWith('https://')).toBe(true);
      }
    }
    expect((PINNED.artifacts as any).docker.aarch64.url).toContain('download.docker.com');
    expect((PINNED.artifacts as any).node.aarch64.url).toContain('nodejs.org/dist');
  });
});

describe('ensureArtifacts', () => {
  it('caches verified downloads and refuses digest mismatches', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-cache-'));
    try {
      const downloaded: string[] = [];
      const digest = (s: string) => {
        // stable sha256 of a tiny string via node crypto through the helper's own verification
        return s;
      };
      // pin the helper's expectations by faking the pinned digest to the content hash
      const crypto = await import('node:crypto');
      const content = Buffer.from('artifact-bytes');
      const real = crypto.createHash('sha256').update(content).digest('hex');
      const saved = (PINNED.artifacts as any);
      const originals = Object.fromEntries(
        Object.entries(saved).map(([k, v]: any) => [k, { ...v }]),
      );
      for (const key of Object.keys(saved)) {
        saved[key].aarch64 = { file: `${key}.bin`, url: `https://example/${key}.bin`, sha256: real };
      }
      try {
        const artifacts = await ensureArtifacts({
          arch: 'aarch64',
          cacheDir,
          download: async (url: string) => {
            downloaded.push(url);
            return content;
          },
        });
        expect(artifacts).toHaveLength(3);
        expect(downloaded).toHaveLength(3);
        for (const a of artifacts) {
          expect(fs.existsSync(a.hostPath)).toBe(true);
        }
        // second call uses the cache, no downloads
        const again = await ensureArtifacts({
          arch: 'aarch64',
          cacheDir,
          download: async () => {
            throw new Error('must not download');
          },
        });
        expect(again).toHaveLength(3);

        // tampered cache file is re-verified and replaced
        fs.writeFileSync(artifacts[0].hostPath, 'tampered');
        let refused = false;
        try {
          await ensureArtifacts({
            arch: 'aarch64',
            cacheDir,
            download: async (url: string) => {
              downloaded.push(`retry:${url}`);
              return content;
            },
          });
        } catch {
          refused = true;
        }
        // a mismatched download refuses; the tampered file triggers re-download then verifies
        expect(refused).toBe(false);
      } finally {
        Object.keys(saved).forEach((k) => {
          saved[k] = originals[k];
        });
      }
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('fails closed when a download does not match the pinned digest', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-bad-'));
    try {
      const saved = (PINNED.artifacts as any);
      const originals = Object.fromEntries(Object.entries(saved).map(([k, v]: any) => [k, { ...v }]));
      for (const key of Object.keys(saved)) {
        saved[key].aarch64 = {
          file: `${key}.bin`,
          url: `https://example/${key}.bin`,
          sha256: 'f'.repeat(64),
        };
      }
      try {
        await expect(
          ensureArtifacts({
            arch: 'aarch64',
            cacheDir,
            download: async () => Buffer.from('not-the-pinned-bytes'),
          }),
        ).rejects.toThrow(/does not match the pinned digest/);
      } finally {
        Object.keys(saved).forEach((k) => {
          saved[k] = originals[k];
        });
      }
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

describe('ownership: lock and claims', () => {
  let deadPid: number;

  beforeAll(async () => {
    // a pid that is definitely gone
    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, ['--version'], { stdio: 'ignore' });
      child.on('exit', () => {
        deadPid = child.pid as number;
        resolve();
      });
    });
  });

  it('isProcessAlive distinguishes live and dead pids', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(deadPid)).toBe(false);
    expect(isProcessAlive(1)).toBe(false); // conservative: pid 1 can never be ours
    expect(isProcessAlive(NaN)).toBe(false);
  });

  it('acquireLock is exclusive and fails closed against a live holder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-live-'));
    try {
      const lockPath = acquireLock(dir);
      expect(fs.existsSync(lockPath.path)).toBe(true);
      expect(() => acquireLock(dir)).toThrow(ActiveRunError);
      releaseLock(dir, lockPath);
      const again = acquireLock(dir); // released -> reacquire works
      expect(fs.existsSync(again.path)).toBe(true);
      releaseLock(dir, again);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a stale lock from a dead run is cleared, not obeyed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-stale-'));
    try {
      fs.writeFileSync(path.join(dir, 'run.lock'), JSON.stringify({ pid: deadPid }));
      const lockPath = acquireLock(dir, { isAlive: (pid: number) => pid === -1 });
      expect(JSON.parse(fs.readFileSync(lockPath.path, 'utf8')).pid).toBe(process.pid);
      releaseLock(dir, lockPath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an old owner cannot release a fresh claim, even from the same pid', () => {
    const dir = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-token-')));
    const old = acquireLock(dir); releaseLock(dir, old);
    const current = acquireLock(dir); releaseLock(dir, old);
    expect(fs.existsSync(current.path)).toBe(true);
    releaseLock(dir, current);
  });
  it('a partially written lock fails closed instead of being stolen', () => {
    const dir = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-partial-')));
    fs.writeFileSync(path.join(dir, 'run.lock'), '');
    expect(() => acquireLock(dir)).toThrow(/no valid owner/);
    expect(fs.readFileSync(path.join(dir, 'run.lock'), 'utf8')).toBe('');
  });

  it('stale recovery deletes only machines its own dead claims name', async () => {
    const invoker = fakeInvoker();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-stale-'));
    try {
      const claims = path.join(dir, 'claims');
      fs.mkdirSync(claims, { recursive: true });
      await fsp.writeFile(
        path.join(claims, 'lifemodel-test-aaaaaaaaaaaaaaaa.json'),
        JSON.stringify({ machine: 'lifemodel-test-aaaaaaaaaaaaaaaa', pid: deadPid }),
      );
      await fsp.writeFile(
        path.join(claims, 'lifemodel-test-bbbbbbbbbbbbbbbb.json'),
        JSON.stringify({ machine: 'lifemodel-test-bbbbbbbbbbbbbbbb', pid: process.pid }), // active run
      );
      await fsp.writeFile(
        path.join(claims, 'someone-elses-machine.json'),
        JSON.stringify({ machine: 'someone-elses-machine', pid: deadPid }), // not our prefix
      );
      const r = await recoverStale({ stateDir: dir, invoker, log: () => {} });
      expect(r.deleted).toEqual(['lifemodel-test-aaaaaaaaaaaaaaaa']);
      expect(r.skipped).toEqual(['lifemodel-test-bbbbbbbbbbbbbbbb']);
      const deletedArgv = invoker.calls.map((c) => c.argv.join(' '));
      expect(deletedArgv).toEqual(['delete --force lifemodel-test-aaaaaaaaaaaaaaaa']);
      // no concurrent or unowned machine was touched; no --all anywhere
      expect(deletedArgv.some((a) => a.includes('--all'))).toBe(false);
      expect(deletedArgv.some((a) => a.includes('bbbbbbbbbbbbbbbb'))).toBe(false);
      expect(deletedArgv.some((a) => a.includes('someone-elses-machine'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('real local invoker mechanics (inside the ordinary test container)', () => {
  it('captures a short stdout response before the child closes', async () => {
    const invoker = createOrbInvoker({ orbctlPath: process.execPath });
    const result = await invoker.runStep({ kind: 'orb', id: 'capture', capture: true, argv: ['-e', 'console.log(501)'] });
    expect(result).toEqual({ code: 0, stdout: '501\n' });
  });
  it('awaits termination of a hanging control child', async () => {
    const invoker = createOrbInvoker({ orbctlPath: process.execPath });
    const running = invoker.runStep({ kind: 'orb', id: 'hang', capture: true, argv: ['-e', 'setInterval(() => {}, 1000)'] });
    await invoker.killActive();
    expect((await running).code).not.toBe(0);
  });
  it('bootstrap extracts the exact versioned Node archive naming convention', () => {
    const bootstrap = fs.readFileSync(new URL('../../docker/test/bootstrap-orb.sh', import.meta.url), 'utf8');
    expect(bootstrap).toContain('node-v"${NODE_VERSION}"-linux-*.tar.xz');
    expect(bootstrap).toContain('node_src=$(echo /opt/node-v"${NODE_VERSION}"-linux-*)');
  });
});

describe('runner with a fake orb', () => {
  it('runs the whole plan, preserves the vitest exit code, deletes the machine, releases the claim and lock', async () => {
    const invoker = fakeInvoker({ vitest: 3 });
    const runner = testRunner({}, invoker);
    const code = await runner.run();
    expect(code).toBe(3); // the test's own exit status, not a launcher code
    const ids = invoker.calls.map((c) => c.id);
    expect(ids[0]).toBe('create');
    expect(ids).toContain('transfer-source');
    expect(ids).toContain('provision-daemon');
    expect(ids[ids.length - 1]).toBe('teardown');
    const teardown = invoker.calls[invoker.calls.length - 1].step;
    expect(teardown.argv).toEqual(['delete', '--force', teardown.argv[2]]);
    // claim removed, lock released
    expect(fs.existsSync(path.join(fs.realpathSync(runner.stateDirPath), 'claims', `${teardown.argv[2]}.json`))).toBe(false);
    expect(fs.existsSync(path.join(fs.realpathSync(runner.stateDirPath), 'run.lock'))).toBe(false);
  });

  it('a failed deletion keeps its recovery claim and cannot report success', async () => {
    const invoker = fakeInvoker({ teardown: 1 });
    const runner = testRunner({}, invoker);
    expect(await runner.run()).toBe(EXIT_FAILURE);
    expect(fs.existsSync(path.join(runner.stateDirPath, 'claims', `${makeMachineName('0123456789abcdef')}.json`))).toBe(true);
  });

  it('a failed provisioning step still deletes the machine and exits nonzero', async () => {
    const invoker = fakeInvoker({ 'provision-daemon': 1 });
    const runner = testRunner({}, invoker);
    const code = await runner.run();
    expect(code).toBe(EXIT_FAILURE);
    const last = invoker.calls[invoker.calls.length - 1].step;
    expect(last.argv[0]).toBe('delete');
    expect(last.argv[1]).toBe('--force');
    expect(last.argv[2]).toBe(makeMachineName('0123456789abcdef'));
  });

  it('a failed vitest run preserves its exit code and still deletes the machine', async () => {
    const invoker = fakeInvoker({ vitest: 7 });
    const runner = testRunner({}, invoker);
    expect(await runner.run()).toBe(7);
    expect(invoker.calls[invoker.calls.length - 1].step.argv).toContain('--force');
  });

  it('the hard deadline aborts the run and deletes the machine (exit 124)', async () => {
    vi.useFakeTimers();
    try {
      const invoker = fakeInvoker({}, ['create']);
      const runner = testRunner({ deadlineMs: 5_000 }, invoker);
      const running = runner.run();
      await vi.advanceTimersByTimeAsync(5_001);
      const code = await running;
      expect(code).toBe(EXIT_TIMEOUT);
      const last = invoker.calls[invoker.calls.length - 1].step;
      expect(last.argv).toEqual(['delete', '--force', makeMachineName('0123456789abcdef')]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('SIGINT aborts the run, deletes the machine, exits 130; SIGTERM exits 143', async () => {
    const invoker = fakeInvoker({}, ['create']);
    const runner = testRunner({ deadlineMs: 600_000 }, invoker);
    const running = runner.run();
    await Promise.resolve();
    runner.cancel('SIGINT');
    expect(await running).toBe(EXIT_SIGINT);
    expect(invoker.calls[invoker.calls.length - 1].step.argv).toContain('--force');

    const invoker2 = fakeInvoker({}, ['create']);
    const runner2 = testRunner({ deadlineMs: 600_000 }, invoker2);
    const running2 = runner2.run();
    await Promise.resolve();
    runner2.cancel('SIGTERM');
    expect(await running2).toBe(EXIT_SIGTERM);
    expect(invoker2.calls[invoker2.calls.length - 1].step.argv).toContain('--force');
  });

  it('an active concurrent run fails closed instead of touching its machine', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-concurrent-'));
    try {
      fs.mkdirSync(path.join(dir, 'claims'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'claims', 'lifemodel-test-cccccccccccccccc.json'),
        JSON.stringify({ machine: 'lifemodel-test-cccccccccccccccc', pid: process.pid }),
      );
      fs.writeFileSync(path.join(dir, 'run.lock'), JSON.stringify({ pid: process.pid }));
      const invoker = fakeInvoker();
      const runner = testRunner(
        { stateDir: dir, machineName: makeMachineName('dddddddddddddddd') },
        invoker,
      );
      const code = await runner.run();
      expect(code).toBe(EXIT_FAILURE);
      // nothing was created or deleted: the active run's machine is untouched
      expect(invoker.calls).toHaveLength(0); // no claim means no machine to delete
      // the other run's claim and lock survived
      expect(fs.existsSync(path.join(dir, 'claims', 'lifemodel-test-cccccccccccccccc.json'))).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'run.lock'), 'utf8')).pid).toBe(process.pid);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the vitest environment in the executed plan never carries host credentials', async () => {
    const invoker = fakeInvoker();
    const runner = testRunner(
      { vitestArgs: ['tests/integration/docker.test.ts'] },
      invoker,
    );
    await runner.run();
    const vitestCall = invoker.calls.find((c) => c.id === 'vitest');
    expect(vitestCall).toBeDefined();
    const joined = vitestCall.step.argv.join('\n');
    expect(joined).toContain(`DOCKER_HOST=${rootlessSocketPath(1000)}`);
    expect(joined).not.toContain('/var/run/docker.sock');
    expect(joined).not.toContain('SSH_AUTH_SOCK');
    expect(joined).not.toContain('ORBENV');
    expect(vitestCall.step.argv.filter((x: string) => x.startsWith('DOCKER_HOST=')).length).toBe(1);
  });

  it('recovers a stale owned machine before claiming its own', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recover-in-run-'));
    try {
      fs.mkdirSync(path.join(dir, 'claims'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'claims', 'lifemodel-test-eeeeeeeeeeeeeeee.json'),
        JSON.stringify({ machine: 'lifemodel-test-eeeeeeeeeeeeeeee', pid: -2 }),
      );
      const invoker = fakeInvoker();
      const runner = testRunner({ stateDir: dir }, invoker);
      await runner.run();
      const deleted = invoker.calls
        .filter((c) => c.argv.includes('delete'))
        .map((c) => c.argv.join(' '));
      expect(deleted).toContain('delete --force lifemodel-test-eeeeeeeeeeeeeeee');
      expect(deleted.every((a) => !a.includes('--all'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
