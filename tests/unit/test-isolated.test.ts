import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, rmSync, truncateSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, stageSnapshot, acquireLock, innerSteps, containerArgs, command } from '../../scripts/test-isolated.mjs';

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
    for (const directory of ['loader/src', 'loader/dist', 'loader/data', 'loader/.git', 'loader/node_modules', 'tests']) mkdirSync(join(source, directory), { recursive: true });
    writeFileSync(join(source, 'package.json'), '{}');
    writeFileSync(join(source, 'package-lock.json'), '{}');
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
      for (const file of ['loader/tsconfig.json', 'loader/package.json', 'loader/package-lock.json', 'loader/src/main.ts']) {
        expect(existsSync(join(snapshot, file))).toBe(true);
      }
      for (const file of ['loader/.env', 'loader/.env.local', 'loader/dist', 'loader/data', 'loader/.git', 'loader/node_modules']) {
        expect(existsSync(join(snapshot, file))).toBe(false);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('copies the root .dockerignore the build-image tests read, while forbidden entries stay absent', () => {
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
  it('executes static checks before the suite without recursive npm scripts', () => {
    expect(innerSteps('check', []).map(([name]) => name)).toEqual(['tsc', 'tsc', 'eslint', 'prettier', 'vitest']);
    expect(innerSteps('check', [])[0]).toEqual(['tsc', '--noEmit']);
    expect(innerSteps('check', [])[1]).toEqual(['tsc', '-p', 'loader/tsconfig.json', '--noEmit']);
    expect(innerSteps('check', [])[2]).toEqual(['eslint', 'src/', 'loader/']);
    expect(innerSteps('check', [])[3]).toEqual(['prettier', '--check', 'src/**/*.ts', 'loader/**/*.ts']);
    expect(innerSteps('test', ['test-file.ts'])[0].at(-1)).toBe('--maxWorkers=2');
  });
  it('preserves a child failure and times out a child that never settles', async () => {
    expect((await command(process.execPath, ['-e', 'process.exit(7)'])).code).toBe(7);
    await expect(command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 })).rejects.toMatchObject({ exitCode: 124 });
  });
});
