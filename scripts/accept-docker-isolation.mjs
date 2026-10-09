#!/usr/bin/env node
// Actual Docker seam runs inside the disposable machine, never the owner daemon.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireLock, stageSnapshot, command } from './test-isolated.mjs';
import { defaultStateDir, findOrbctl } from './test-docker-isolated.mjs';
const scenario = process.argv[2] ?? 'success';
assert.ok(['success', 'failure', 'timeout', 'interrupt'].includes(scenario));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = acquireLock();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lifemodel-docker-acceptance-'));
try {
  const snapshot = stageSnapshot(root, path.join(temp, 'source'));
  const fixture = path.join(snapshot, 'tests', 'private-daemon-acceptance.test.ts');
  const header = `import { it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';\n`;
  const success = `it('uses a private rootless daemon without Mac mounts and supports NET_ADMIN inside its container', () => {
  expect(existsSync('/mnt/mac')).toBe(false);
  expect(process.env.HOST_ISOLATION_SENTINEL).toBeUndefined();
  expect(process.env.DOCKER_HOST).toBe('unix:///run/user/' + execFileSync('id', ['-u'], { encoding: 'utf8' }).trim() + '/docker.sock');
  expect(spawnSync('macctl', ['run', '/usr/bin/true'], { timeout: 10000 }).status).not.toBe(0);
  const security = execFileSync('docker', ['info', '--format', '{{json .SecurityOptions}}'], { encoding: 'utf8', timeout: 30000 });
  expect(security).toContain('rootless');
  const answer = execFileSync('docker', ['run', '--rm', '--cap-add', 'NET_ADMIN', 'alpine:3.23', 'sh', '-ec',
    'apk add --no-cache iptables >/dev/null; iptables -N LIFEMODEL_TEST; iptables -F LIFEMODEL_TEST; iptables -X LIFEMODEL_TEST; echo private-daemon-ok'], { encoding: 'utf8', timeout: 180000 });
  expect(answer).toContain('private-daemon-ok');
}, 240000);\n`;
  const hang = `it('holds a turn with an orphan stand-in', async () => {
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }).unref();
  console.log('PRIVATE_READY'); await new Promise(() => {});
}, 240000);\n`;
  fs.writeFileSync(fixture, header + (scenario === 'success' ? success : scenario === 'failure' ? `it('intentional failure', () => { expect(true).toBe(false); });\n` : hang));
  const budget = scenario === 'timeout' ? 150000 : 1440000;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts/test-docker-isolated.mjs'), '--snapshot', snapshot, '--timeout', String(budget), '--', 'tests/private-daemon-acceptance.test.ts'], { env: { ...process.env, HOST_ISOLATION_SENTINEL: 'not-a-real-secret' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', sent = false;
    const receive = (chunk) => {
      output += chunk; process.stdout.write(chunk);
      if (scenario === 'interrupt' && !sent && output.includes('PRIVATE_READY')) { sent = true; child.kill('SIGTERM'); }
    };
    child.stdout.on('data', receive); child.stderr.on('data', receive);
    const timer = setTimeout(() => child.kill('SIGTERM'), budget + 75000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, output, sent }); });
  });
  const expected = { success: 0, failure: 1, timeout: 124, interrupt: 143 }[scenario];
  assert.equal(result.code, expected, 'Private-daemon acceptance exit code');
  if (scenario === 'timeout' || scenario === 'interrupt') assert.ok(result.output.includes('PRIVATE_READY'), 'The fixture must reach live work, not only fail during bootstrap');
  for (const match of result.output.matchAll(/killing .*\(pid (\d+)\)/g)) {
    assert.throws(() => process.kill(Number(match[1]), 0), 'a killed host control process survived');
  }
  const machines = await command(findOrbctl(), ['list'], { timeoutMs: 20000 });
  assert.equal(machines.code, 0);
  assert.equal((machines.stdout.match(/\blifemodel-test-[0-9a-f]{16}\b/g) ?? []).length, 0, 'owned machine left after helper exit');
  const claims = path.join(defaultStateDir(), 'claims');
  assert.equal(fs.existsSync(claims) ? fs.readdirSync(claims).filter((name) => /^lifemodel-test-.*\.json$/.test(name)).length : 0, 0, 'unconfirmed cleanup claim remained');
  console.log(`PASS private-daemon ${scenario}: expected status, no machine/claim/control-process leftovers`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); release(); }
