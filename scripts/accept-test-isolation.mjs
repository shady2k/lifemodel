#!/usr/bin/env node
// Real seam check: the actual test code runs only through the disposable runner.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { stageSnapshot, command } from './test-isolated.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lifemodel-isolation-acceptance-'));
const snapshot = stageSnapshot(root, path.join(temp, 'source'));
const fixture = path.join(snapshot, 'tests', 'isolation-acceptance.test.ts');
const originalEnv = 'HOST_ISOLATION_SENTINEL=not-a-real-secret\n';
fs.writeFileSync(path.join(snapshot, '.env'), originalEnv);
fs.mkdirSync(path.join(snapshot, 'data')); fs.writeFileSync(path.join(snapshot, 'data', 'owner-sentinel'), 'private');
fs.writeFileSync(path.join(snapshot, '.git'), 'owner git sentinel must not be copied');
const base = `import { it, expect } from 'vitest';\nimport { existsSync, readFileSync, mkdirSync } from 'node:fs';\nimport { execFileSync, spawn } from 'node:child_process';\n`;
function execute({ timeoutMs = 25_000, cancel = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(snapshot, 'scripts/test-isolated.mjs'), 'test', '--timeout-ms', String(timeoutMs), '--', 'tests/isolation-acceptance.test.ts'], {
      env: { ...process.env, HOST_ISOLATION_SENTINEL: 'not-a-real-secret', GIT_DIR: path.join(snapshot, '.git') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', signalled = false;
    const receive = (chunk) => {
      output += chunk;
      if (cancel && !signalled && output.includes('ISOLATION_READY')) { signalled = true; child.kill('SIGTERM'); }
    };
    child.stdout.on('data', receive); child.stderr.on('data', receive);
    const watchdog = setTimeout(() => { child.kill('SIGTERM'); }, 40_000);
    child.once('error', (error) => { clearTimeout(watchdog); reject(error); });
    child.once('close', (code) => { clearTimeout(watchdog); resolve({ code, output, signalled }); });
  });
}
async function noLeftovers() {
  const result = await command('docker', ['ps', '-aq', '--filter', `label=com.lifemodel.test-boundary=${process.getuid()}`]);
  assert.equal(result.code, 0); assert.equal(result.stdout.trim(), '', 'owned container left after runner exit');
  const images = await command('docker', ['image', 'ls', '-q', '--filter', `label=com.lifemodel.test-source=${process.getuid()}`]);
  assert.equal(images.code, 0); assert.equal(images.stdout.trim(), '', 'snapshot image left after runner exit');
  assert.equal(fs.readFileSync(path.join(snapshot, '.env'), 'utf8'), originalEnv);
  assert.equal(fs.readFileSync(path.join(snapshot, '.git'), 'utf8'), 'owner git sentinel must not be copied');
}
try {
  fs.writeFileSync(fixture, base + `it('cannot see the owner environment or files', () => {
    expect(process.getuid()).toBe(1000);
    expect(process.env.HOST_ISOLATION_SENTINEL).toBeUndefined();
    expect(process.env.GIT_DIR).toBeUndefined();
    expect(existsSync('.env')).toBe(false);
    expect(existsSync('data/owner-sentinel')).toBe(false);
    expect(existsSync('/var/run/docker.sock')).toBe(false);
    expect(execFileSync('git', ['log', '-1', '--format=%s'], { encoding: 'utf8' }).trim()).toBe('snapshot');
    expect(readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim()).toBe('3221225472');
    expect(readFileSync('/sys/fs/cgroup/pids.max', 'utf8').trim()).toBe('256');
    expect(() => mkdirSync('/opt/deps/acceptance-write')).toThrow();
    expect(readFileSync('/proc/mounts', 'utf8')).toMatch(/tmpfs \\/tmp tmpfs[^\\n]*size=786432k/);

  });\n`);
  let result = await execute(); assert.equal(result.code, 0, result.output); await noLeftovers(); console.log('PASS isolated sentinel and enforced caps');
  fs.writeFileSync(fixture, base + `it('intentional failure', () => { expect(true).toBe(false); });\n`);
  result = await execute(); assert.equal(result.code, 1, result.output); await noLeftovers(); console.log('PASS failing test exit status and cleanup');
  fs.writeFileSync(fixture, base + `it('waits while an orphan stand-in runs', async () => {
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }).unref();
    console.log('ISOLATION_READY'); await new Promise(() => {});
  }, 120000);\n`);
  result = await execute({ timeoutMs: 5_000 }); assert.equal(result.code, 124, result.output); await noLeftovers(); console.log('PASS hard timeout and orphan containment');
  result = await execute({ cancel: true }); assert.equal(result.signalled, true, result.output); assert.equal(result.code, 143, result.output); await noLeftovers(); console.log('PASS interruption and orphan containment');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
