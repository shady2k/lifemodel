import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, rmSync, truncateSync } from 'node:fs';
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
    expect(innerSteps('check', []).map(([name]) => name)).toEqual(['tsc', 'eslint', 'prettier', 'vitest']);
    expect(innerSteps('test', ['test-file.ts'])[0].at(-1)).toBe('--maxWorkers=2');
  });
  it('preserves a child failure and times out a child that never settles', async () => {
    expect((await command(process.execPath, ['-e', 'process.exit(7)'])).code).toBe(7);
    await expect(command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 })).rejects.toMatchObject({ exitCode: 124 });
  });
});
