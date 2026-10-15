import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, rmSync, truncateSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, stageSnapshot, acquireLock, innerSteps, containerArgs, command, STORE_IMAGES, networkCreateArgs, storeContainerArgs, testStoreEnv, run } from '../../scripts/test-isolated.mjs';

function controlledDocker({ stale = false, complete = false } = {}) {
  const calls: string[][] = [];
  return {
    calls,
    command: async (_program: string, args: string[], options: { signal?: AbortSignal } = {}) => {
      calls.push(args);
      if (options.signal?.aborted) throw options.signal.reason;
      if (args[0] === 'ps' && args.includes('-aq')) return { code: 0, stdout: stale ? 'stale-container\n' : '', stderr: '' };
      if (args[0] === 'network' && args[1] === 'ls') return { code: 0, stdout: stale ? 'stale-network\n' : '', stderr: '' };
      if (args[0] === 'image' && args[1] === 'ls') return { code: 0, stdout: stale ? 'stale-image\n' : '', stderr: '' };
      if (args[0] === 'image' && args[1] === 'inspect') {
        return args[2]?.startsWith('lifemodel-test-deps:')
          ? { code: 0, stdout: '', stderr: '' }
          : { code: 0, stdout: 'base-image/amd64', stderr: '' };
      }
      if (args[0] === 'start' && args.includes('-a')) {
        if (complete) return { code: 0, stdout: '', stderr: '' };
        return await new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        });
      }
      if (args[0] === 'inspect' && args[1] === '--format') return { code: 0, stdout: '0\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

function launcherFixture(root: string) {
  const source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'package.json'), '{}');
  writeFileSync(join(source, 'package-lock.json'), '{}');
  return source;
}

describe('the disposable launch boundary', () => {
  it('refuses interactive and resource-policy overrides', () => {
    for (const option of ['--watch', '--watch=true', '--watchAll', '-w', '--ui', '--maxWorkers=99', '--config=outside.ts']) {
      expect(() => parseArgs(['test', '--', option])).toThrow(/Refused/);
    }
    expect(parseArgs(['test', '--', 'tests/unit/energy-management.test.ts']).mode).toBe('test');
  });
  it('copies source and safe npm policy, not data, secrets, git or dependency trees', () => {
    const root = mkdtempSync(join(tmpdir(), 'snapshot-policy-'));
    const snapshot = join(root, 'snapshot');
    const source = join(root, 'source');
    mkdirSync(join(source, 'tests', '.git'), { recursive: true });
    mkdirSync(join(source, 'tests', 'node_modules'), { recursive: true });
    for (const file of ['package.json', 'package-lock.json', '.env', '.env.local', 'data', '.git']) writeFileSync(join(source, file), '{}');
    writeFileSync(join(source, '.npmrc'), 'legacy-peer-deps=true\n');
    writeFileSync(join(source, 'tests', 'test.ts'), 'source');
    writeFileSync(join(source, 'tests', '.env'), 'synthetic-only');
    writeFileSync(join(source, 'tests', '.env.local'), 'synthetic-only');
    try {
      stageSnapshot(source, snapshot);
      expect(existsSync(join(snapshot, 'tests', 'test.ts'))).toBe(true);
      expect(existsSync(join(snapshot, '.npmrc'))).toBe(true);
      for (const file of ['.env', '.env.local', 'data', '.git', 'tests/.git', 'tests/node_modules', 'tests/.env', 'tests/.env.local']) expect(existsSync(join(snapshot, file))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects links and unknown npm options rather than importing owner files', () => {
    const root = mkdtempSync(join(tmpdir(), 'snapshot-links-'));
    try {
      writeFileSync(join(root, 'package.json'), '{}'); writeFileSync(join(root, 'package-lock.json'), '{}');
      mkdirSync(join(root, 'tests')); symlinkSync('/etc/passwd', join(root, 'tests', 'external'));
      expect(() => stageSnapshot(root, join(root, 'snapshot'))).toThrow(/symlink/);
      rmSync(join(root, 'tests'), { recursive: true });
      writeFileSync(join(root, '.npmrc'), '_authToken=never-copy-this\n');
      expect(() => stageSnapshot(root, join(root, 'snapshot2'))).toThrow(/Unsupported .npmrc/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects symlinks in direct-entry parents and in npm policy', () => {
    const root = mkdtempSync(join(tmpdir(), 'snapshot-parent-links-'));
    try {
      writeFileSync(join(root, 'package.json'), '{}'); writeFileSync(join(root, 'package-lock.json'), '{}');
      mkdirSync(join(root, 'outside')); writeFileSync(join(root, 'outside', 'issues.jsonl'), '{}');
      symlinkSync(join(root, 'outside'), join(root, '.beads'));
      expect(() => stageSnapshot(root, join(root, 'snapshot'))).toThrow(/symlink/);
      rmSync(join(root, '.beads')); writeFileSync(join(root, 'outside', 'policy'), 'legacy-peer-deps=true');
      symlinkSync(join(root, 'outside', 'policy'), join(root, '.npmrc'));
      expect(() => stageSnapshot(root, join(root, 'snapshot2'))).toThrow(/symlink/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects oversized source files before copying their payload', () => {
    const root = mkdtempSync(join(tmpdir(), 'snapshot-bytes-'));
    try {
      writeFileSync(join(root, 'package.json'), '{}'); writeFileSync(join(root, 'package-lock.json'), '{}');
      mkdirSync(join(root, 'tests')); writeFileSync(join(root, 'tests', 'large'), '');
      truncateSync(join(root, 'tests', 'large'), 11 * 1024 * 1024);
      expect(() => stageSnapshot(root, join(root, 'snapshot'))).toThrow(/byte limit/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('copies the loader tree, its manifests and tsconfig, without nested dotenv, git, data, node_modules or dist', () => {
    const root = mkdtempSync(join(tmpdir(), 'snapshot-loader-'));
    const snapshot = join(root, 'snapshot');
    const source = join(root, 'source');
    for (const directory of ['web/app/src', 'loader/src', 'loader/dist', 'loader/data', 'loader/.git', 'loader/node_modules', 'tests']) mkdirSync(join(source, directory), { recursive: true });
    writeFileSync(join(source, 'package.json'), '{}');
    writeFileSync(join(source, 'package-lock.json'), '{}');
    writeFileSync(join(source, 'web', 'app', 'src', 'main.tsx'), 'export {};');
    writeFileSync(join(source, 'loader', 'package.json'), '{}');
    writeFileSync(join(source, 'loader', 'package-lock.json'), '{}');
    writeFileSync(join(source, 'loader', 'tsconfig.json'), '{}');
    writeFileSync(join(source, 'loader', 'src', 'main.ts'), 'export {};');
    writeFileSync(join(source, 'loader', 'dist', 'main.js'), 'built');
    writeFileSync(join(source, 'loader', 'data', 'state.json'), 'synthetic-only');
    writeFileSync(join(source, 'loader', '.git', 'HEAD'), 'ref: refs/heads/main');
    writeFileSync(join(source, 'loader', 'node_modules', 'dep.js'), 'dependency');
    for (const nested of ['.env', '.env.local']) writeFileSync(join(source, 'loader', nested), 'synthetic-only');
    try {
      stageSnapshot(source, snapshot);
      for (const file of ['loader/tsconfig.json', 'loader/package.json', 'loader/package-lock.json', 'loader/src/main.ts', 'web/app/src/main.tsx']) {
        expect(existsSync(join(snapshot, file))).toBe(true);
      }
      for (const file of ['loader/.env', 'loader/.env.local', 'loader/dist', 'loader/data', 'loader/.git', 'loader/node_modules']) {
        expect(existsSync(join(snapshot, file))).toBe(false);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('copies the root .dockerignore used by the loader image build, while forbidden entries stay absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'snapshot-dockerignore-'));
    const snapshot = join(root, 'snapshot');
    const source = join(root, 'source');
    mkdirSync(join(source, 'src', 'node_modules'), { recursive: true });
    mkdirSync(join(source, 'src', 'dist'), { recursive: true });
    mkdirSync(join(source, 'src', 'data'), { recursive: true });
    for (const name of ['package.json', 'package-lock.json', '.dockerignore', 'src/index.ts', 'src/.env', 'src/.env.local',
      'src/node_modules/dep.js', 'src/dist/out.js', 'src/data/state.json']) writeFileSync(join(source, name), 'synthetic-only');
    try {
      stageSnapshot(source, snapshot);
      expect(existsSync(join(snapshot, '.dockerignore'))).toBe(true);
      expect(existsSync(join(snapshot, 'src', 'index.ts'))).toBe(true);
      for (const entry of ['src/.env', 'src/.env.local', 'src/node_modules', 'src/dist', 'src/data']) expect(existsSync(join(snapshot, entry))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('normalizes snapshot-only permissions for the non-root Docker copy', () => {
    const root = mkdtempSync(join(tmpdir(), 'snapshot-modes-'));
    try {
      writeFileSync(join(root, 'package.json'), '{}'); writeFileSync(join(root, 'package-lock.json'), '{}');
      mkdirSync(join(root, '.beads')); writeFileSync(join(root, '.beads', 'issues.jsonl'), '{}', { mode: 0o600 });
      mkdirSync(join(root, 'scripts')); writeFileSync(join(root, 'scripts', 'tool.sh'), '#!/bin/sh', { mode: 0o700 });
      const destination = stageSnapshot(root, join(root, 'snapshot'));
      expect(statSync(join(destination, '.beads', 'issues.jsonl')).mode & 0o777).toBe(0o644);
      expect(statSync(join(destination, 'scripts', 'tool.sh')).mode & 0o777).toBe(0o755);
      expect(statSync(join(root, '.beads', 'issues.jsonl')).mode & 0o777).toBe(0o600);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('allows only one live run and releases only its own lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'launch-lock-'));
    try {
      const release = acquireLock(join(root, 'lock'));
      expect(() => acquireLock(join(root, 'lock'))).toThrow(/active/);
      release();
      const releaseNext = acquireLock(join(root, 'lock')); releaseNext();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('uses private network, non-root user and kernel resource caps without mounts', () => {
    const args = containerArgs('owned-test', 'image', true).join(' ');
    expect(args).toContain('--network none'); expect(args).toContain('--user node');
    expect(args).toContain('--cap-drop ALL'); expect(args).toContain('--pids-limit 256');
    expect(args).not.toMatch(/--privileged|--mount|--volume/);
    expect(args).toContain('--read-only'); expect(args).toContain('/tmp:rw,exec,nosuid,nodev,size=768m');
    expect(args).toContain('--memory-swap 3g');
  });
  it('pins store images and creates bounded service containers on the internal test network', () => {
    expect(STORE_IMAGES.valkey).toBe('valkey/valkey:8.1-bookworm@sha256:fea8b3e67b15729d4bb70589eb03367bab9ad1ee89c876f54327fc7c6e618571');
    expect(STORE_IMAGES.postgres).toBe('ghcr.io/cloudnative-pg/postgresql:17-standard-bookworm@sha256:fe22b9fcd038dcd08c2019b17d95f517f137801e5f39d857a895d65e8c63033b');
    expect(networkCreateArgs('owned-net')).toEqual(['network', 'create', '--internal', '--label', expect.stringMatching(/^com\.lifemodel\.test-boundary=/), 'owned-net']);
    const args = storeContainerArgs('owned-pg', STORE_IMAGES.postgres, 'owned-net', 'postgres');
    expect(args.join(' ')).toContain('--network owned-net');
    expect(args.join(' ')).toContain('--network-alias postgres');
    expect(args.join(' ')).toContain('--tmpfs');
    expect(args.join(' ')).toContain('--cpus 1');
    expect(args.join(' ')).not.toMatch(/--network-alias (?:localhost|host)(?:\s|$)/);
  });
  it('passes explicit store URLs only to the test container on its isolated network', () => {
    const args = testStoreEnv('run-net', 'postgres-secret');
    expect(args).toEqual(['-e', 'LIFEMODEL_TEST_VALKEY_URL=redis://valkey:6379', '-e', 'LIFEMODEL_TEST_DATABASE_URL=postgres://postgres:postgres-secret@postgres:5432/postgres']);
    const testArgs = containerArgs('run', 'image', true, { network: 'run-net', storeEnv: args });
    expect(testArgs.join(' ')).toContain('--network run-net');
    expect(testArgs.join(' ')).toContain('LIFEMODEL_TEST_DATABASE_URL=');
    expect(testArgs.join(' ')).not.toContain('--network none');
  });
  it('executes static checks before the suite without recursive npm scripts', () => {
    expect(innerSteps('check', []).map(([name]) => name)).toEqual(['tsc', 'tsc', 'tsc', 'eslint', 'prettier', 'vitest']);
    expect(innerSteps('check', [])[0]).toEqual(['tsc', '--noEmit']);
    expect(innerSteps('check', [])[1]).toEqual(['tsc', '-p', 'loader/tsconfig.json', '--noEmit']);
    expect(innerSteps('check', [])[2]).toEqual(['tsc', '-p', 'web/app/tsconfig.json', '--noEmit']);
    expect(innerSteps('check', [])[3]).toEqual(['eslint', 'src/', 'loader/', 'web/app/']);
    expect(innerSteps('check', [])[4]).toEqual(['prettier', '--check', 'src/**/*.ts', 'loader/**/*.ts', 'web/app/**/*.{ts,tsx,css,json,html}']);
    expect(innerSteps('test', ['test-file.ts'])[0].at(-1)).toBe('--maxWorkers=2');
  });
  it('preserves a child failure and times out a child that never settles', async () => {
    expect((await command(process.execPath, ['-e', 'process.exit(7)'])).code).toBe(7);
    await expect(command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 })).rejects.toMatchObject({ exitCode: 124 });
  });

  it.each([
    ['overall deadline', 124, undefined],
    ['SIGINT', 130, ({ onInt }: { onInt: () => void }) => onInt()],
    ['SIGTERM', 143, ({ onTerm }: { onTerm: () => void }) => onTerm()],
  ])('cleans every owned resource and releases the lock after %s', async (label, expected, interrupt) => {
    const root = mkdtempSync(join(tmpdir(), 'launcher-cleanup-'));
    const lock = join(root, 'lock');
    launcherFixture(root);
    const docker = controlledDocker();
    try {
      const result = await run(['test', '--timeout-ms', '100'], {
        root: join(root, 'source'), tempRoot: root, lockDirectory: lock, command: docker.command,
        beforeTestStart: interrupt,
      });
      expect(result, label).toBe(expected);
      const created = docker.calls.filter((args) => args[0] === 'create').map((args) => args[2]);
      expect(created).toHaveLength(4); // source container, Valkey, Postgres, test container
      for (const name of created) expect(docker.calls).toContainEqual(['rm', '-f', name]);
      const networkCreate = docker.calls.find((args) => args[0] === 'network' && args[1] === 'create');
      expect(networkCreate).toBeDefined();
      expect(docker.calls).toContainEqual(['network', 'rm', networkCreate?.at(-1)]);
      const sourceCommit = docker.calls.find((args) => args[0] === 'commit' && args.includes('--change'));
      expect(sourceCommit).toBeDefined();
      const sourceImage = sourceCommit?.at(-1);
      expect(docker.calls).toContainEqual(['image', 'rm', sourceImage]);
      const release = acquireLock(lock);
      release();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('prunes labeled leftovers at the start of the next run after a hard crash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'launcher-prune-'));
    launcherFixture(root);
    const docker = controlledDocker({ stale: true, complete: true });
    try {
      const result = await run(['test', '--timeout-ms', '5000'], {
        root: join(root, 'source'), tempRoot: root, lockDirectory: join(root, 'lock'), command: docker.command,
      });
      expect(result).toBe(0);
      expect(docker.calls).toContainEqual(['rm', '-f', 'stale-container']);
      expect(docker.calls).toContainEqual(['network', 'rm', 'stale-network']);
      expect(docker.calls).toContainEqual(['image', 'rm', 'stale-image']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

});
