#!/usr/bin/env node
// Local test boundary (lifemodel-q4x.5.1). No host dependencies or bind mounts.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE_IMAGE = 'node:24.21.0-bookworm-slim';
const LABEL = 'com.lifemodel.test-boundary';
const LIMITS = ['--cpus', '2', '--memory', '3g', '--memory-swap', '3g', '--pids-limit', '256', '--init'];
const SOURCE_LABEL = 'com.lifemodel.test-source';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT = 25 * 60_000;
const FILES = ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts',
  'eslint.config.js', '.prettierrc', '.prettierignore', '.gitignore', '.dockerignore', 'AGENTS.md', 'README.md', 'LICENSE'];
const DIRS = ['src', 'loader', 'tests', 'scripts', 'cli', 'docker', 'docs', '.backlog', '.githooks', '.husky', '.github'];
const FORBIDDEN = new Set(['.git', 'node_modules', 'dist', 'data', 'coverage', '.DS_Store', '.npmrc']);
const log = (text) => console.error(`[test-isolated] ${text}`);

export function parseArgs(args) {
  const [mode, ...rest] = args;
  const separator = rest.indexOf('--');
  const own = separator < 0 ? rest : rest.slice(0, separator);
  let timeoutMs = TIMEOUT;
  if (own.length === 2 && own[0] === '--timeout-ms') timeoutMs = Number(own[1]);
  else if (own.length) throw new Error('Unknown launcher option; use --timeout-ms <ms> before --');
  if (!['check', 'test', 'docker'].includes(mode) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT) {
    throw new Error('Usage: node scripts/test-isolated.mjs <check|test|docker> [--timeout-ms <1..1500000>] [-- <vitest args>]');
  }
  const vitestArgs = separator < 0 ? [] : rest.slice(separator + 1);
  // Users select test paths/name filters, not a different execution policy.
  for (const arg of vitestArgs) {
    if (/^(?:-w|--(?:watch|ui|inspect|pool|maxWorkers|minWorkers|fileParallelism|execArgv|config|workspace|project|merge-reports))(?:$|[=.-])/i.test(arg)
      || /^(?:--watchAll|--watch-all|--watchall)$/i.test(arg)) {
      throw new Error(`Refused test option ${arg}: the run is bounded and its worker policy is fixed`);
    }
  }
  return { mode, vitestArgs, timeoutMs };
}

export function stageSnapshot(root, destination) {
  destination = path.resolve(destination);
  if (destination === path.parse(destination).root || destination === path.resolve(root)) throw new Error('Snapshot needs a separate non-root destination');
  function makeDirectory(target) {
    fs.mkdirSync(target, { recursive: true });
    for (let current = target; current === destination || current.startsWith(destination + path.sep); current = path.dirname(current)) {
      fs.chmodSync(current, 0o755);
    }
  }
  makeDirectory(destination);
  let count = 0, bytes = 0;
  function assertNoLinks(relative) {
    let prefix = root;
    for (const part of relative.split(path.sep)) {
      prefix = path.join(prefix, part);
      if (fs.existsSync(prefix) && fs.lstatSync(prefix).isSymbolicLink()) throw new Error(`Snapshot refuses symlink: ${relative}`);
    }
  }
  function copy(relative) {
    const name = path.basename(relative);
    if (FORBIDDEN.has(name) || /^\.env(?:$|\.)/.test(name)) return;
    const source = path.join(root, relative);
    if (!fs.existsSync(source)) return;
    assertNoLinks(relative);
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error(`Snapshot refuses symlink: ${relative}`);
    if (++count > 100_000) throw new Error('Source snapshot exceeds entry limit');
    const target = path.join(destination, relative);
    if (stat.isDirectory()) {
      makeDirectory(target);
      for (const child of fs.readdirSync(source)) copy(path.join(relative, child));
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (stat.size > 10 * 1024 * 1024 || bytes > 100 * 1024 * 1024) throw new Error('Source snapshot exceeds byte limit');
      makeDirectory(path.dirname(target));
      fs.copyFileSync(source, target);
      // Docker copies as root. Source-only copies must be readable by uid1000;
      // preserve execute intent, never source ownership or restrictive modes.
      fs.chmodSync(target, stat.mode & 0o111 ? 0o755 : 0o644);
    } else throw new Error(`Snapshot refuses special file: ${relative}`);
  }
  for (const entry of [...FILES, ...DIRS, '.beads/config.yaml', '.beads/policy.yaml', '.beads/issues.jsonl']) copy(entry);
  for (const manifest of ['package.json', 'package-lock.json']) {
    if (!fs.existsSync(path.join(destination, manifest))) throw new Error(`Missing ${manifest}`);
  }
  // Preserve the committed install policy, never npm credentials or registry
  // overrides from an owner config. Unknown options require an explicit design.
  const npmrc = path.join(root, '.npmrc');
  if (fs.existsSync(npmrc)) {
    assertNoLinks('.npmrc');
    if (fs.statSync(npmrc).size > 4096) throw new Error('Unsupported .npmrc policy: file too large');
    const policy = [];
    for (const line of fs.readFileSync(npmrc, 'utf8').split(/\r?\n/)) {
      if (!line.trim() || /^[#;]/.test(line.trim())) continue;
      if (!/^legacy-peer-deps=(true|false)$/.test(line.trim())) {
        throw new Error('Unsupported .npmrc policy: only legacy-peer-deps=true|false is allowed');
      }
      policy.push(line.trim());
    }
    fs.writeFileSync(path.join(destination, '.npmrc'), policy.join('\n') + '\n');
    fs.chmodSync(path.join(destination, '.npmrc'), 0o644);
  }
  return destination;
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export function acquireLock(directory = path.join(os.tmpdir(), `lifemodel-test-${os.userInfo().uid}.lock`)) {
  const ownerFile = path.join(directory, 'owner.json');
  const owner = JSON.stringify({ pid: process.pid, id: randomUUID() });
  function claim() {
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(ownerFile, owner, { mode: 0o600 });
  }
  try { claim(); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const recovery = `${directory}.recovery`;
    try { fs.mkdirSync(recovery, { mode: 0o700 }); } catch {
      throw new Error('Another launcher is recovering the isolation lock');
    }
    try {
      let holder;
      try { holder = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); } catch {
        throw new Error(`Isolation lock has no valid owner: ${directory}; inspect it before removing it`);
      }
      if (processAlive(holder.pid)) throw new Error(`Another isolated run is active (pid ${holder.pid})`);
      // Recovery is serialized; fresh contenders must observe this live claim.
      fs.rmSync(directory, { recursive: true });
      claim();
      log('Recovered lock from a stopped launcher');
    } finally { fs.rmdirSync(recovery); }
  }
  return () => {
    if (fs.existsSync(ownerFile) && fs.readFileSync(ownerFile, 'utf8') === owner) {
      fs.rmSync(directory, { recursive: true });
    }
  };
}

export function innerSteps(mode, args) {
  const suite = ['vitest', 'run', ...args, '--maxWorkers=2'];
  // The loader is a separate TypeScript project: root and loader typechecks,
  // then lint and format over both trees, then the suite last.
  return mode === 'check'
    ? [['tsc', '--noEmit'], ['tsc', '-p', 'loader/tsconfig.json', '--noEmit'],
      ['eslint', 'src/', 'loader/'], ['prettier', '--check', 'src/**/*.ts', 'loader/**/*.ts'], suite]
    : [suite];
}

export function containerArgs(name, image, offline) {
  return ['create', '--name', name, '--label', `${LABEL}=${process.getuid?.() ?? 'user'}`,
    ...LIMITS, ...(offline ? ['--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=768m',
      '--tmpfs', '/home/node:rw,nosuid,nodev,size=64m', '--user', 'node', '--network', 'none', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '-e', 'HOME=/home/node', '-e', 'TMPDIR=/tmp', '-e', 'HUSKY=0', '-e', 'DATA_PATH=/tmp/test-state'] : []), image];
}

// The host environment is needed only by the CONTROL CLI. No variable is
// forwarded into test processes; containers receive only their explicit env.
function controlEnv() {
  return Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DOCKER_HOST', 'DOCKER_CONTEXT']
    .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
}

export function command(program, args, { timeoutMs = 60_000, signal, live = false, killGraceMs = 1_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const child = spawn(program, args, { env: controlEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', stopped;
    let escalation;
    const stop = (reason) => {
      if (stopped) return;
      stopped = reason;
      child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    };
    const abort = () => stop(signal.reason);
    const timer = setTimeout(() => stop(Object.assign(new Error(`${program} command timed out`), { exitCode: 124 })), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-4_000_000); if (live) process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4_000_000); if (live) process.stderr.write(chunk); });
    const settle = () => { clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener('abort', abort); };
    child.once('error', (error) => { settle(); reject(error); });
    child.once('close', (code) => {
      settle();
      if (stopped) reject(stopped);
      else resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function quote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

export async function run(argv) {
  let parsed;
  try { parsed = parseArgs(argv); } catch (error) { log(error.message); return 2; }
  let release;
  try { release = acquireLock(); } catch (error) { log(error.message); return 2; }
  const controller = new AbortController();
  const owned = new Set();
  const ownedImages = new Set();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lifemodel-test-'));
  const stop = (exitCode, reason) => controller.abort(Object.assign(new Error(reason), { exitCode }));
  const onInt = () => stop(130, 'Interrupted (SIGINT)');
  const onTerm = () => stop(143, 'Interrupted (SIGTERM)');
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
  const deadline = setTimeout(() => stop(124, 'Overall isolation deadline exceeded'), parsed.timeoutMs);
  async function docker(args, { mustSucceed = true, ...options } = {}) {
    const result = await command('docker', args, { timeoutMs: 10 * 60_000, signal: controller.signal, ...options });
    if (mustSucceed && result.code) throw new Error(`docker ${args[0]} failed (${result.code}): ${result.stderr}`);
    return result;
  }
  let result = 1;
  try {
    const snapshot = stageSnapshot(ROOT, path.join(temporary, 'source'));
    if (parsed.mode === 'docker') {
      const backend = path.join(ROOT, 'scripts/test-docker-isolated.mjs');
      if (!fs.existsSync(backend)) throw new Error('Private Docker backend is unavailable; no owner-daemon fallback');
      const execution = await command(process.execPath, [backend, '--snapshot', snapshot, '--timeout', String(Math.max(1, parsed.timeoutMs - 60_000)), '--', ...parsed.vitestArgs],
        { timeoutMs: parsed.timeoutMs + 60_000, signal: controller.signal, live: true, killGraceMs: 75_000 });
      result = execution.code;
    } else {
      await docker(['version'], { timeoutMs: 20_000 });
      // Only our per-user labels are reclaimed, under the global launch lock.
      const stale = await docker(['ps', '-aq', '--filter', `label=${LABEL}=${process.getuid?.() ?? 'user'}`], { timeoutMs: 20_000 });
      for (const id of stale.stdout.trim().split(/\s+/).filter(Boolean)) {
        log(`Removing leftover owned container ${id}`);
        await docker(['rm', '-f', id], { timeoutMs: 20_000 });
      }
      const staleImages = await docker(['image', 'ls', '-q', '--filter', `label=${SOURCE_LABEL}=${process.getuid?.() ?? 'user'}`], { timeoutMs: 20_000 });
      for (const id of new Set(staleImages.stdout.trim().split(/\s+/).filter(Boolean))) {
        log(`Removing leftover snapshot image ${id}`);
        await docker(['image', 'rm', id], { timeoutMs: 20_000 });
      }
      const inspect = await docker(['image', 'inspect', BASE_IMAGE, '--format', '{{.Id}}/{{.Architecture}}'], { mustSucceed: false, timeoutMs: 20_000 });
      if (inspect.code) await docker(['pull', BASE_IMAGE], { live: true });
      const base = inspect.code ? await docker(['image', 'inspect', BASE_IMAGE, '--format', '{{.Id}}/{{.Architecture}}']) : inspect;
      const hash = createHash('sha256').update('recipe-v2\0' + base.stdout)
        .update(fs.readFileSync(path.join(snapshot, 'package.json')))
        .update(fs.readFileSync(path.join(snapshot, 'package-lock.json')))
        .update(fs.existsSync(path.join(snapshot, '.npmrc')) ? fs.readFileSync(path.join(snapshot, '.npmrc')) : '').digest('hex').slice(0, 24);
      const image = `lifemodel-test-deps:${hash}`;
      const cached = await docker(['image', 'inspect', image], { mustSucceed: false, timeoutMs: 20_000 });
      if (cached.code) {
        const prep = `lifemodel-test-prep-${randomUUID()}`;
        owned.add(prep); // Before creation: even a timed-out create must be reaped.
        await docker([...containerArgs(prep, BASE_IMAGE, false), 'sleep', 'infinity']);
        await docker(['start', prep]);
        await docker(['exec', prep, 'sh', '-ec', 'mkdir -p /opt/deps /snapshot; apt-get update -qq; apt-get install -y -qq --no-install-recommends git ca-certificates; chown node:node /opt/deps'], { live: true });
        for (const file of ['package.json', 'package-lock.json', ...(fs.existsSync(path.join(snapshot, '.npmrc')) ? ['.npmrc'] : [])]) await docker(['cp', path.join(snapshot, file), `${prep}:/opt/deps/${file}`]);
        await docker(['exec', '-u', 'node', '-w', '/opt/deps', '-e', 'HUSKY=0', '-e', 'HOME=/home/node', prep, 'npm', 'ci', '--no-audit', '--no-fund'], { live: true });
        await docker(['commit', prep, image], { live: true });
        await docker(['rm', '-f', prep]);
        owned.delete(prep);
      }
      // Embed the sanitized source before enabling a read-only test root.
      // Docker cp never mounts the checkout; temporary image ownership is
      // recorded before commit, and labels allow next-run crash recovery.
      const sourceContainer = `lifemodel-test-source-${randomUUID()}`;
      const sourceImage = `lifemodel-test-snapshot:${randomUUID()}`;
      owned.add(sourceContainer);
      ownedImages.add(sourceImage);
      await docker([...containerArgs(sourceContainer, image, false), 'sleep', 'infinity']);
      await docker(['cp', `${snapshot}/.`, `${sourceContainer}:/snapshot`]);
      await docker(['commit', '--change', `LABEL ${SOURCE_LABEL}=${process.getuid?.() ?? 'user'}`, sourceContainer, sourceImage]);
      await docker(['rm', '-f', sourceContainer]);
      owned.delete(sourceContainer);
      const name = `lifemodel-test-run-${randomUUID()}`;
      owned.add(name);
      const steps = innerSteps(parsed.mode, parsed.vitestArgs).map(([binary, ...args]) =>
        [quote(`/opt/deps/node_modules/.bin/${binary}`), ...args.map(quote)].join(' ')).join(' && ');
      const linkDependencies = 'const fs=require("node:fs"); for(const name of fs.readdirSync("/opt/deps/node_modules")) fs.symlinkSync("/opt/deps/node_modules/"+name,"/tmp/work/node_modules/"+name)';
      const script = 'cp -R /snapshot /tmp/work; mkdir /tmp/work/node_modules; node -e ' + quote(linkDependencies) + '; cd /tmp/work; '
        + 'git init -q -b main; git -c user.name=lifemodel-test -c user.email=test@lifemodel.local -c core.hooksPath=/dev/null add -A; '
        + 'git -c user.name=lifemodel-test -c user.email=test@lifemodel.local -c core.hooksPath=/dev/null commit -qm snapshot; ' + steps;
      await docker([...containerArgs(name, sourceImage, true), 'sh', '-ec', script]);
      log(`Running ${parsed.mode} in disposable offline Node 24 container`);
      const execution = await docker(['start', '-a', name], { mustSucceed: false, live: true, timeoutMs: TIMEOUT });
      // docker start -a normally propagates the container code; inspect it explicitly.
      const state = await docker(['inspect', '--format', '{{.State.ExitCode}}', name]);
      result = execution.code || Number(state.stdout.trim());
    }
  } catch (error) { log(error.message); result = error.exitCode ?? 1; }
  finally {
    clearTimeout(deadline);
    process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
    for (const name of owned) {
      try {
        const cleanup = await command('docker', ['rm', '-f', name], { timeoutMs: 15_000 });
        if (cleanup.code && !/No such container/.test(cleanup.stderr)) { log(`Cleanup failed for ${name}: ${cleanup.stderr}`); if (!result) result = 1; }
      } catch (error) { log(`Cleanup failed for ${name}: ${error.message}`); if (!result) result = 1; }
    }
    for (const image of ownedImages) {
      try {
        const cleanup = await command('docker', ['image', 'rm', image], { timeoutMs: 15_000 });
        if (cleanup.code && !/No such image/.test(cleanup.stderr)) { log(`Snapshot cleanup failed: ${cleanup.stderr}`); if (!result) result = 1; }
      } catch (error) { log(`Snapshot cleanup failed: ${error.message}`); if (!result) result = 1; }
    }
    fs.rmSync(temporary, { recursive: true, force: true });
    release();
  }
  return result;
}

function invokedDirectly() {
  try { return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (invokedDirectly()) process.exitCode = await run(process.argv.slice(2));
