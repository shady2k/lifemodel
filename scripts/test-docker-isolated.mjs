#!/usr/bin/env node
/**
 * test-docker-isolated.mjs — run vitest inside a disposable OrbStack isolated
 * machine against its own private rootless Docker daemon (lifemodel-q4x.5.3).
 *
 * Boundary:
 * - The machine is created with `orbctl create --isolated --isolate-network ...`:
 *   no Mac filesystem mount, no host network access, no SSH agent forwarding.
 *   OrbStack machines share OrbStack's single Linux kernel — this is NOT a
 *   hardware VM. It protects the owner's data and the owner's Docker daemon
 *   from test accidents (the workload is the project's own tests, not malware).
 * - The source arrives as a sanitized private snapshot (prepared by the generic
 *   launcher) and is streamed in as a tar piped to stdin. No host path is
 *   mounted, no owner git history travels with it: a fresh private repository
 *   is generated inside the machine from the snapshot.
 * - Docker inside the machine is a private rootless daemon assembled from
 *   pinned official static artifacts streamed from the host. The owner's Docker
 *   socket is never read, mounted or forwarded — not even read-only.
 * - Every phase is bounded. The machine is deleted from outside the test
 *   process on success, failure, timeout and interruption; the test's exit
 *   status is preserved. Stale machines are recovered only through exact
 *   ownership claims (unique machine name + recorded pid); other machines,
 *   including concurrently active ones, are never touched and `orbctl delete
 *   --all` is never used.
 *
 * Contract (dispatched by the generic launcher under its machine-wide lock):
 *   node scripts/test-docker-isolated.mjs --snapshot <dir> --timeout <ms> -- <vitest args>
 *
 * Exit codes: the vitest exit status on the test path; 2 usage or unsupported
 * host; 1 failed startup/provisioning; 124 hard deadline; 130 SIGINT;
 * 143 SIGTERM.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as parseLaunchArgs } from './test-isolated.mjs';

// ---------------------------------------------------------------------------
// Machine identity and filesystem layout inside the disposable machine
// ---------------------------------------------------------------------------

/** Owned prefix: this helper only ever deletes machines its own claims name. */
export const MACHINE_PREFIX = 'lifemodel-test-';
export const MACHINE_NAME_PATTERN = /^lifemodel-test-[0-9a-f]{16}$/;

export const MACHINE_IMAGE = 'ubuntu:24.04';
export const MACHINE_USER = 'lifemodel';
export const MACHINE_CPUS = '2';
export const MACHINE_MEMORY = '4G';
export const MACHINE_DISK = '32G';

export const MACHINE_HOME = '/home/lifemodel';
export const SRC_DIR = `${MACHINE_HOME}/src`;
export const PROVISION_DIR = '/opt/lifemodel-provision';
export const NODE_DIR = '/opt/node24';

export const MACHINE_PATH = `${NODE_DIR}/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

/** Overall default phase bounds (ms); the --timeout deadline caps everything. */
export const PHASE_TIMEOUTS_MS = {
  create: 120_000,
  boot: 90_000,
  transfer: 300_000,
  provision: 480_000,
  daemon: 240_000,
  npmCi: 600_000,
  discoverUid: 30_000,
  teardown: 60_000,
};

export const EXIT_USAGE = 2;
export const EXIT_FAILURE = 1;
export const EXIT_TIMEOUT = 124;
export const EXIT_SIGINT = 130;
export const EXIT_SIGTERM = 143;

export class UsageError extends Error {}
export class IsolationError extends Error {}
export class ActiveRunError extends IsolationError {}
export class DeadlineError extends IsolationError {}
export class CancelledError extends IsolationError {
  constructor(signalName) {
    super(`interrupted by ${signalName}`);
    this.signalName = signalName;
  }
}

// ---------------------------------------------------------------------------
// Pinned upstream artifacts: official static builds, versions pinned and
// digests recorded from the official distribution points. Nothing is downloaded
// inside the machine for provisioning; the host verifies digests and streams
// the bytes in with the rest of the provisioning payload.
// ---------------------------------------------------------------------------

export const PINNED = {
  dockerVersion: '29.9.0',
  nodeVersion: 'v24.21.0',
  artifacts: {
    docker: {
      aarch64: {
        file: 'docker-29.9.0.tgz',
        url: 'https://download.docker.com/linux/static/stable/aarch64/docker-29.9.0.tgz',
        sha256: '811f6eee271678fc98dbe5c4d896c00fc5fe2daa4f7a37069c17abc036eab85b',
      },
      x86_64: {
        file: 'docker-29.9.0.tgz',
        url: 'https://download.docker.com/linux/static/stable/x86_64/docker-29.9.0.tgz',
        sha256: '33e1ab8b63d14bca449f7a3d30d7f6aa669daa544e60a86b17fec87f61afe2b4',
      },
    },
    rootlessExtras: {
      aarch64: {
        file: 'docker-rootless-extras-29.9.0.tgz',
        url: 'https://download.docker.com/linux/static/stable/aarch64/docker-rootless-extras-29.9.0.tgz',
        sha256: 'f1b76a0721101e15c1eabeccf08751c0d42206defe06422de2e4b8897fc0f129',
      },
      x86_64: {
        file: 'docker-rootless-extras-29.9.0.tgz',
        url: 'https://download.docker.com/linux/static/stable/x86_64/docker-rootless-extras-29.9.0.tgz',
        sha256: '6b4a2e085a1e4ade5ba3de99fd770a0a9b53c719e6bf6b1632242bf4b068adb6',
      },
    },
    node: {
      aarch64: {
        file: 'node-v24.21.0-linux-arm64.tar.xz',
        url: 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-arm64.tar.xz',
        sha256: '6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2',
      },
      x86_64: {
        file: 'node-v24.21.0-linux-x64.tar.xz',
        url: 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz',
        sha256: 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
      },
    },
  },
};

/** Map the host's Node arch to the Linux artifact arch (an OrbStack machine runs the Mac's arch). */
export function machineArch(nodeArch = process.arch) {
  if (nodeArch === 'arm64') return 'aarch64';
  if (nodeArch === 'x64') return 'x86_64';
  throw new IsolationError(`unsupported host architecture: ${nodeArch}`);
}

// ---------------------------------------------------------------------------
// Host environment scrubbing
// ---------------------------------------------------------------------------

/**
 * Allowlist environment for host-side processes (orbctl, tar). Everything else
 * — ORBENV, DOCKER_HOST, SSH_AUTH_SOCK, GIT_*, tokens, proxy settings — is
 * dropped, so nothing from the owner's environment leaks into the machine or
 * influences the provisioning path.
 */
export function scrubEnv(env = process.env) {
  const out = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM']) {
    const value = env[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

export function usageText() {
  return [
    'Usage:',
    '  node scripts/test-docker-isolated.mjs --snapshot <dir> --timeout <ms> -- <vitest args>',
    '',
    'Runs vitest inside a disposable OrbStack isolated machine with its own',
    'private rootless Docker daemon. The owner Docker socket is never used.',
    '',
    'Options:',
    '  --snapshot <dir>  sanitized private source snapshot (no .git, no unsafe',
    '                    symlinks), prepared by the generic launcher',
    '  --timeout <ms>    hard deadline for the whole run (machine included)',
    '  -- <vitest args>  arguments passed to `vitest run` inside the machine',
    '',
    'Exit codes: vitest status; 2 usage/unsupported host; 1 startup failure;',
    '124 deadline; 130 SIGINT; 143 SIGTERM.',
  ].join('\n');
}

export function parseArgs(argv) {
  const parsed = { snapshot: undefined, timeoutMs: undefined, vitestArgs: [] };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--') {
      parsed.vitestArgs = argv.slice(i + 1);
      break;
    }
    if (arg === '--help' || arg === '-h') {
      throw new UsageError(usageText());
    }
    if (arg === '--snapshot' || arg === '--timeout') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`missing value for ${arg}`);
      }
      if (arg === '--snapshot') parsed.snapshot = value;
      else parsed.timeoutMs = value;
      i += 2;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new UsageError(`unknown option: ${arg}`);
    }
    throw new UsageError(`unexpected positional argument before '--': ${arg}`);
  }
  if (parsed.snapshot === undefined) throw new UsageError('missing required --snapshot <dir>');
  if (parsed.timeoutMs === undefined) throw new UsageError('missing required --timeout <ms>');
  const timeoutMs = Number(parsed.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new UsageError(`--timeout must be a positive integer of milliseconds, got: ${parsed.timeoutMs}`);
  }
  try { parseLaunchArgs(['docker', '--', ...parsed.vitestArgs]); }
  catch (error) { throw new UsageError(error.message); }
  return { snapshot: parsed.snapshot, timeoutMs, vitestArgs: parsed.vitestArgs };
}

// ---------------------------------------------------------------------------
// Snapshot validation — fail closed before anything leaves the host
// ---------------------------------------------------------------------------

const SNAPSHOT_MAX_ENTRIES = 200_000;
const SNAPSHOT_MAX_DEPTH = 32;

/**
 * Validate the sanitized snapshot: a directory with package.json and
 * package-lock.json; no owner git, dotenv, root data or dependency trees;
 * no symlinks or non-regular files. Enforce the same byte bounds and safe
 * npm policy as the public launcher even for a direct helper call.
 */
export async function validateSnapshot(dir) {
  const problems = [];
  let st;
  try {
    st = await fsp.stat(dir);
  } catch {
    throw new IsolationError(`snapshot directory is not readable: ${dir}`);
  }
  if (!st.isDirectory()) {
    throw new IsolationError(`snapshot is not a directory: ${dir}`);
  }
  const root = await fsp.realpath(dir);
  for (const required of ['package.json', 'package-lock.json']) {
    try {
      await fsp.access(path.join(root, required));
    } catch {
      problems.push(`missing ${required} (npm ci inside the machine needs it)`);
    }
  }

  let seen = 0, bytes = 0;
  const stack = [{ rel: '', depth: 0 }];
  while (stack.length > 0) {
    const { rel, depth } = stack.pop();
    const full = rel === '' ? root : path.join(root, rel);
    let dirents;
    try {
      dirents = await fsp.readdir(full, { withFileTypes: true });
    } catch (e) {
      problems.push(`unreadable snapshot directory ${rel || '.'}: ${e.message}`);
      continue;
    }
    for (const dirent of dirents) {
      seen += 1;
      if (seen > SNAPSHOT_MAX_ENTRIES) {
        throw new IsolationError(`snapshot has too many entries (>${SNAPSHOT_MAX_ENTRIES}); refusing`);
      }
      const relPath = rel === '' ? dirent.name : `${rel}/${dirent.name}`;
      if (dirent.name === '.git' || dirent.name === 'node_modules' || /^\.env(?:$|\.)/.test(dirent.name) || relPath === 'data') {
        problems.push(`contains forbidden owner/dependency content: ${relPath}`);
        continue;
      }
      const fullEntry = path.join(full, dirent.name);
      if (dirent.isSymbolicLink()) {
        problems.push(`unsafe symlink ${relPath}`);
        continue;
      }
      if (dirent.isFile()) {
        const size = (await fsp.stat(fullEntry)).size;
        bytes += size;
        if (size > 10 * 1024 * 1024 || bytes > 100 * 1024 * 1024) throw new IsolationError('snapshot exceeds byte limit');
        if (dirent.name === '.npmrc') {
          if (size > 4096) throw new IsolationError('unsupported .npmrc policy: file too large');
          const lines = (await fsp.readFile(fullEntry, 'utf8')).split(/\r?\n/).map((line) => line.trim());
          if (lines.some((line) => line && !/^[#;]/.test(line) && !/^legacy-peer-deps=(true|false)$/.test(line))) {
            problems.push(`unsupported .npmrc policy: ${relPath}`);
          }
        }
      }
      if (dirent.isDirectory()) {
        if (depth >= SNAPSHOT_MAX_DEPTH) {
          throw new IsolationError(`snapshot nested deeper than ${SNAPSHOT_MAX_DEPTH} levels; refusing`);
        }
        stack.push({ rel: relPath, depth: depth + 1 });
        continue;
      }
      if (!dirent.isFile()) {
        problems.push(`non-regular file (socket/fifo/device): ${relPath}`);
      }
    }
  }

  if (problems.length > 0) {
    throw new IsolationError(`refusing snapshot ${dir}:\n- ${problems.slice(0, 20).join('\n- ')}`);
  }
  return { path: root, entries: seen };
}

// ---------------------------------------------------------------------------
// Machine naming, ownership claims and stale recovery
// ---------------------------------------------------------------------------

export function makeMachineName(runId) {
  if (!/^[0-9a-f]{16}$/.test(runId)) {
    throw new IsolationError(`run id must be 16 hex chars, got: ${runId}`);
  }
  return `${MACHINE_PREFIX}${runId}`;
}

export function newRunId() {
  return randomBytes(8).toString('hex');
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function claimsDir(stateDir) {
  return path.join(stateDir, 'claims');
}

/**
 * Recover machines recorded by previous runs of THIS helper whose owner
 * process is gone. Never deletes machines without a claim naming them; never
 * touches claims whose recorded pid is still alive (a concurrent run); never
 * uses `orbctl delete --all`.
 */
export async function recoverStale({ stateDir, invoker, isAlive = isProcessAlive, log = () => {} }) {
  const dir = claimsDir(stateDir);
  const deleted = [];
  const skipped = [];
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return { deleted, skipped };
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const claimPath = path.join(dir, name);
    let claim;
    try {
      claim = JSON.parse(await fsp.readFile(claimPath, 'utf8'));
    } catch {
      log(`stale recovery: unreadable claim ${name}, leaving it alone`);
      continue;
    }
    if (typeof claim.machine !== 'string' || !MACHINE_NAME_PATTERN.test(claim.machine)) {
      log(`stale recovery: claim ${name} does not name an owned machine, leaving it alone`);
      continue;
    }
    if (isAlive(claim.pid)) {
      skipped.push(claim.machine);
      continue;
    }
    log(`stale recovery: deleting abandoned machine ${claim.machine}`);
    try {
      const r = await invoker.runStep({
        id: 'recover-stale',
        kind: 'orb',
        argv: ['delete', '--force', claim.machine],
        timeoutMs: PHASE_TIMEOUTS_MS.teardown,
      });
      if (r.code !== 0) {
        log(`stale recovery: delete of ${claim.machine} exited ${r.code}; keeping its claim`);
        continue;
      }
    } catch (e) {
      log(`stale recovery: delete of ${claim.machine} failed: ${e.message}; keeping its claim`);
      continue;
    }
    await fsp.rm(claimPath, { force: true });
    deleted.push(claim.machine);
  }
  return { deleted, skipped };
}

// ---------------------------------------------------------------------------
// Plan — the pure, inspectable orchestration
// ---------------------------------------------------------------------------

function runArgv(machineName, user, workdir, command) {
  const argv = ['run', '-m', machineName];
  if (user) argv.push('--user', user);
  if (workdir) argv.push('--workdir', workdir);
  // orbctl's parser stops at COMMAND; it rejects the usual standalone --.
  argv.push(...command);
  return argv;
}

/** Rootless daemon socket of the machine's user; the only DOCKER_HOST this helper ever sets. */
export function rootlessSocketPath(uid) {
  return `unix:///run/user/${uid}/docker.sock`;
}

/** Fresh, credential-free environment for npm ci / vitest inside the machine. */
export function vitestEnv(uid) {
  return {
    HOME: MACHINE_HOME,
    USER: MACHINE_USER,
    LOGNAME: MACHINE_USER,
    PATH: MACHINE_PATH,
    HUSKY: '0',
    TMPDIR: '/tmp',
    XDG_RUNTIME_DIR: `/run/user/${uid}`,
    DOCKER_HOST: rootlessSocketPath(uid),
    LIFEMODEL_DOCKER_TESTS: '1',
  };
}

export function machineCreateArgv(machineName) {
  return [
    'create',
    '--isolated',
    '--isolate-network',
    '--cpus', MACHINE_CPUS,
    '--memory', MACHINE_MEMORY,
    '--disk', MACHINE_DISK,
    '-u', MACHINE_USER,
    MACHINE_IMAGE,
    machineName,
  ];
}

/**
 * The pre-provisioning plan: create the machine, wait for it, stream the
 * artifacts and the source snapshot in, provision rootless docker and node,
 * and generate the machine-private git repository from the snapshot.
 */
export function buildPlan(input) {
  const {
    machineName,
    snapshotPath,
    artifacts,
    artifactsHostDir,
    bootstrapScriptDir,
    bootstrapScriptName = 'bootstrap-orb.sh',
  } = input;
  if (!MACHINE_NAME_PATTERN.test(machineName)) {
    throw new IsolationError(`refusing machine name outside the owned prefix: ${machineName}`);
  }
  if (!snapshotPath) {
    throw new IsolationError('missing snapshot path for the source transfer');
  }
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new IsolationError('missing pinned artifacts for provisioning');
  }
  if (!artifactsHostDir || !bootstrapScriptDir || !bootstrapScriptName) {
    throw new IsolationError('missing artifact host dir or bootstrap script');
  }

  // Host-side tar arguments: the bootstrap script and the pinned artifacts,
  // relative to their own -C roots. These host paths never appear in any
  // machine-side argv; the machine only ever reads the tar stream from stdin.
  const artifactTarArgs = [
    '-cf', '-', '-C', bootstrapScriptDir, bootstrapScriptName,
    '-C', artifactsHostDir, ...artifacts.map((a) => a.file),
  ];

  return [
    {
      id: 'create',
      kind: 'orb',
      argv: machineCreateArgv(machineName),
      timeoutMs: PHASE_TIMEOUTS_MS.create,
    },
    {
      id: 'boot',
      kind: 'orb',
      argv: runArgv(machineName, MACHINE_USER, MACHINE_HOME, ['true']),
      poll: { intervalMs: 1_000 },
      timeoutMs: PHASE_TIMEOUTS_MS.boot,
    },
    {
      // Creates the machine-side marker that bootstrap-orb.sh checks before
      // every stage, so its stages refuse to run anywhere but in this machine.
      id: 'stage-dirs',
      kind: 'orb',
      argv: runArgv(machineName, 'root', null, [
        'sh', '-c',
        'mkdir -p "$1" "$2" && printf %s "$3" > "$1/.machine-id"',
        'stage-dirs', PROVISION_DIR, SRC_DIR, machineName,
      ]),
      timeoutMs: PHASE_TIMEOUTS_MS.transfer,
    },
    {
      id: 'stage-chown-src',
      kind: 'orb',
      argv: runArgv(machineName, 'root', null, ['chown', '-R', `${MACHINE_USER}:${MACHINE_USER}`, SRC_DIR]),
      timeoutMs: PHASE_TIMEOUTS_MS.transfer,
    },
    {
      id: 'stage-artifacts',
      kind: 'tar-stdin',
      hostTarArgs: artifactTarArgs,
      argv: runArgv(machineName, 'root', null, ['tar', '-xf', '-', '-C', PROVISION_DIR]),
      timeoutMs: PHASE_TIMEOUTS_MS.transfer,
    },
    {
      id: 'transfer-source',
      kind: 'tar-stdin',
      hostTarArgs: ['-C', snapshotPath, '-cf', '-', '.'],
      argv: runArgv(machineName, MACHINE_USER, SRC_DIR, ['tar', '-xf', '-']),
      timeoutMs: PHASE_TIMEOUTS_MS.transfer,
    },
    {
      id: 'provision-root',
      kind: 'orb',
      argv: runArgv(machineName, 'root', PROVISION_DIR, ['bash', `./${bootstrapScriptName}`, 'root']),
      timeoutMs: PHASE_TIMEOUTS_MS.provision,
    },
    {
      id: 'provision-repo',
      kind: 'orb',
      argv: runArgv(machineName, MACHINE_USER, PROVISION_DIR, ['bash', `./${bootstrapScriptName}`, 'repo']),
      timeoutMs: PHASE_TIMEOUTS_MS.provision,
    },
    {
      id: 'provision-daemon',
      kind: 'orb',
      argv: runArgv(machineName, 'root', PROVISION_DIR, ['bash', `./${bootstrapScriptName}`, 'daemon']),
      timeoutMs: PHASE_TIMEOUTS_MS.daemon,
    },
    {
      id: 'discover-uid',
      kind: 'orb',
      argv: runArgv(machineName, MACHINE_USER, null, ['id', '-u']),
      capture: true,
      timeoutMs: PHASE_TIMEOUTS_MS.discoverUid,
    },
  ];
}

/**
 * The test steps, after the machine's user id is known: npm ci with the
 * lockfile (HUSKY=0) and vitest with a fresh credential-free environment whose
 * DOCKER_HOST points at the machine's private rootless socket.
 */
export function vitestSteps({ machineName, uid, vitestArgs }) {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new IsolationError(`machine user id must be a positive integer, got: ${uid}`);
  }
  const env = vitestEnv(uid);
  const envKvs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  return [
    {
      id: 'npm-ci',
      kind: 'orb',
      argv: runArgv(machineName, MACHINE_USER, SRC_DIR, [
        'env', '-i', ...envKvs, 'npm', 'ci',
      ]),
      timeoutMs: PHASE_TIMEOUTS_MS.npmCi,
    },
    {
      id: 'vitest',
      kind: 'orb',
      argv: runArgv(machineName, MACHINE_USER, SRC_DIR, [
        'env', '-i', ...envKvs, './node_modules/.bin/vitest', 'run', ...vitestArgs, '--maxWorkers=2',
      ]),
      // Budget: whatever is left of the overall hard deadline.
      timeoutMs: Number.POSITIVE_INFINITY,
    },
  ];
}

export function teardownStep(machineName) {
  return {
    id: 'teardown',
    kind: 'orb',
    argv: ['delete', '--force', machineName],
    timeoutMs: PHASE_TIMEOUTS_MS.teardown,
  };
}

// ---------------------------------------------------------------------------
// Real invoker — spawns orbctl with a scrubbed environment
// ---------------------------------------------------------------------------

function settle(child) {
  return new Promise((resolve) => {
    child.once('close', (code) => resolve({ code: code === null ? 1 : code }));
    child.once('error', () => resolve({ code: 1 }));
  });
}

function registerKiller(active, child, label, log) {
  let killed = false, timer;
  const closed = new Promise((resolve) => child.once('close', () => { clearTimeout(timer); resolve(); }));
  const send = (signal) => {
    try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
  };
  const killer = () => {
    if (!killed) {
      killed = true;
      log(`killing ${label} (pid ${child.pid})`);
      send('SIGTERM');
      timer = setTimeout(() => send('SIGKILL'), 5_000);
    }
    return closed;
  };
  active.add(killer);
  return () => { clearTimeout(timer); active.delete(killer); };
}

/**
 * Invoker that actually spawns orbctl (and the host tar). All host-side
 * processes run with a scrubbed, allowlist environment: no ORBENV, no owner
 * DOCKER_HOST, no SSH agent, no git credentials.
 */
export function createOrbInvoker({ orbctlPath, log = () => {} }) {
  const active = new Set();
  async function runOrb(step, stdin) {
    const child = spawn(orbctlPath, step.argv, {
      env: scrubEnv(),
      detached: true,
      stdio: stdin ? ['pipe', step.capture ? 'pipe' : 'inherit', 'inherit'] : ['ignore', step.capture ? 'pipe' : 'inherit', 'inherit'],
    });
    child.on('error', (e) => log(`spawn failed for ${step.id}: ${e.message}`));
    const unregister = registerKiller(active, child, step.id, log);
    if (stdin) {
      child.stdin.on('error', () => {}); // e.g. EPIPE when the machine side dies first
      stdin.pipe(child.stdin);
    }
    const chunks = [];
    if (step.capture) child.stdout.on('data', (chunk) => chunks.push(chunk));
    const r = await settle(child);
    unregister();
    return { code: r.code, stdout: step.capture ? Buffer.concat(chunks).toString('utf8') : undefined };
  }

  return {
    async runStep(step) {
      if (step.kind === 'orb') return runOrb(step, null);
      if (step.kind === 'tar-stdin') {
        // Safe transfer: a host-side tar of the sanitized input piped into
        // `orbctl run ... tar -xf -`. The host path lives only in the host
        // tar arguments; the machine-side argv never names a host path.
        const tar = spawn('tar', step.hostTarArgs, { env: scrubEnv(), detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
        tar.on('error', (e) => log(`tar spawn failed for ${step.id}: ${e.message}`));
        const unregisterTar = registerKiller(active, tar, `${step.id} (host tar)`, log);
        const [orbResult, tarResult] = await Promise.all([runOrb(step, tar.stdout), settle(tar)]);
        unregisterTar();
        if (orbResult.code !== 0) return orbResult;
        if (tarResult.code !== 0) {
          log(`host tar for ${step.id} exited ${tarResult.code}; refusing to continue`);
          return { code: tarResult.code, stdout: orbResult.stdout };
        }
        return orbResult;
      }
      throw new IsolationError(`unknown step kind: ${step.kind}`);
    },
    async killActive() {
      await Promise.all([...active].map((killer) => killer()));
    },
  };
}


// ---------------------------------------------------------------------------
// Artifact cache — pinned official builds verified against recorded digests
// ---------------------------------------------------------------------------

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Ensure the pinned artifacts exist in the cache with the exact pinned
 * digests. `download` is injectable for tests; production downloads over
 * HTTPS from the official distribution points only.
 */
export async function ensureArtifacts({ arch, cacheDir, download, log = () => {} }) {
  const specs = PINNED.artifacts;
  const wanted = [];
  for (const key of Object.keys(specs)) {
    const spec = specs[key][arch];
    if (!spec) throw new IsolationError(`no pinned ${key} artifact for ${arch}`);
    wanted.push({ key, ...spec });
  }
  const out = [];
  for (const spec of wanted) {
    const dir = path.join(cacheDir, arch);
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, spec.file);
    let ok = false;
    if (fs.existsSync(target)) {
      ok = (await sha256File(target)) === spec.sha256;
      if (!ok) log(`artifact ${spec.file} in cache has the wrong digest; re-downloading`);
    }
    if (!ok) {
      log(`downloading ${spec.url}`);
      const bytes = await download(spec.url);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== spec.sha256) {
        await fsp.rm(target, { force: true });
        throw new IsolationError(
          `downloaded ${spec.file} does not match the pinned digest (got ${digest}); refusing`,
        );
      }
      const tmp = `${target}.tmp-${randomBytes(4).toString('hex')}`;
      await fsp.writeFile(tmp, bytes);
      await fsp.rename(tmp, target);
    }
    out.push({ key: spec.key, file: spec.file, hostPath: target });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runner — bounded orchestration with cleanup from outside the test process
// ---------------------------------------------------------------------------

const sleep = (timers, ms) => new Promise((resolve) => timers.setTimeout(resolve, ms));

export function defaultStateDir() {
  const base = process.env.LIFEMODEL_TEST_STATE_DIR || path.join(os.homedir(), '.cache', 'lifemodel-test-isolated');
  return path.resolve(base);
}

export function acquireLock(stateDir, { isAlive = isProcessAlive } = {}) {
  fs.mkdirSync(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, 'run.lock');
  const owner = JSON.stringify({ pid: process.pid, startedAt: Date.now(), id: newRunId() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try { fs.writeFileSync(fd, owner); } finally { fs.closeSync(fd); }
      return { path: lockPath, owner };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let observed, holder;
      try { observed = fs.readFileSync(lockPath, 'utf8'); holder = JSON.parse(observed); }
      catch { throw new ActiveRunError(`run lock has no valid owner: ${lockPath}; inspect it before removing it`); }
      if (!Number.isInteger(holder.pid) || holder.pid <= 1) throw new ActiveRunError(`invalid run-lock owner: ${lockPath}`);
      if (isAlive(holder.pid)) throw new ActiveRunError(`another test-docker-isolated run (pid ${holder.pid}) holds ${lockPath}; refusing to touch its machine`);
      // Serialize stale-file replacement; a contender cannot unlink a fresh claim.
      const recovery = `${lockPath}.recovery`;
      try { fs.mkdirSync(recovery); }
      catch { throw new ActiveRunError(`another launcher is recovering ${lockPath}`); }
      try {
        if (fs.readFileSync(lockPath, 'utf8') === observed) fs.unlinkSync(lockPath);
      } finally { fs.rmdirSync(recovery); }
    }
  }
  throw new ActiveRunError(`could not acquire the run lock at ${lockPath}`);
}

export function releaseLock(stateDir, handle) {
  const lockPath = path.join(stateDir, 'run.lock');
  try {
    if (handle && fs.readFileSync(lockPath, 'utf8') === handle.owner) fs.unlinkSync(lockPath);
  } catch {}
}

async function writeClaim(stateDir, claim) {
  const dir = claimsDir(stateDir);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${claim.machine}.json`), JSON.stringify(claim));
}

/**
 * The runner executes the plan against an invoker. Every phase is bounded by
 * the overall hard deadline; the machine is deleted in `cleanup` on success,
 * failure, deadline and interruption, and the recorded exit status is returned.
 */
export function createRunner({
  invoker,
  machineName,
  snapshotPath,
  vitestArgs,
  artifacts,
  artifactsHostDir,
  bootstrapScriptDir,
  bootstrapScriptName,
  stateDir,
  deadlineMs,
  log = () => {},
  timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) },
  now = Date.now,
}) {
  if (!MACHINE_NAME_PATTERN.test(machineName)) {
    throw new IsolationError(`refusing machine name outside the owned prefix: ${machineName}`);
  }
  const deadlineAt = now() + deadlineMs;
  const remainingMs = () => deadlineAt - now();

  let abort = null; // { kind: 'signal' | 'deadline', signalName? }
  let abortResolve;
  const abortGate = new Promise((resolve) => {
    abortResolve = resolve;
  });
  let cleaned = false;
  let claimWritten = false;
  let lockHandle = null;

  function fireAbort(kind, signalName) {
    if (abort) return;
    abort = kind === 'deadline' ? { kind } : { kind: 'signal', signalName };
    log(abort.kind === 'deadline' ? `hard deadline reached; aborting` : `aborting on ${signalName}`);
    abortResolve();
  }

  function budgetFor(requested) {
    const remaining = remainingMs();
    if (remaining <= 0) return null;
    return Math.min(requested, remaining);
  }

  async function raceWithAbort(promise, what) {
    return Promise.race([promise, abortGate.then(() => {
      throw new CancelledError(abort && abort.signalName ? abort.signalName : 'cancelled');
    })]).catch((e) => {
      if (e instanceof CancelledError) {
        invoker.killActive();
      }
      throw e;
    });
  }

  async function runStepOnce(step, budgetMs) {
    const budget = budgetFor(budgetMs);
    if (budget === null) throw new DeadlineError('no time left in the hard deadline');
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = timers.setTimeout(() => {
        // A step can only be timed out by the global deadline or by its own
        // phase budget; classify so the run reports 124 for the deadline and
        // a phase failure otherwise, whichever timer fired first.
        if (remainingMs() <= 0) {
          reject(new DeadlineError(`step ${step.id} ran into the hard deadline`));
        } else {
          reject(new Error(`step ${step.id} exceeded its budget of ${budget} ms`));
        }
      }, budget);
    });
    try {
      return await raceWithAbort(Promise.race([invoker.runStep(step), timedOut]), step.id);
    } finally {
      timers.clearTimeout(timer);
    }
  }

  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    await invoker.killActive();
    let deletionConfirmed = false;
    try {
      // Teardown always gets its own bound: even a run that just hit the
      // hard deadline still deletes its machine from outside.
      const step = teardownStep(machineName);
      const budget = step.timeoutMs;
      if (budget > 0 && claimWritten) {
        let timer;
        const bound = new Promise((resolve) => {
          timer = timers.setTimeout(resolve, budget);
        });
        let r = null;
        try {
          r = await Promise.race([invoker.runStep(step), bound.then(() => null)]);
        } catch (e) {
          log(`teardown: machine delete failed: ${e.message}`);
        } finally {
          timers.clearTimeout(timer);
          await invoker.killActive(); // a hung delete child must not outlive the run
        }
        deletionConfirmed = r !== null && r.code === 0;
        if (!deletionConfirmed) {
          log(`teardown: deletion unconfirmed; keeping the recovery claim for ${machineName}`);
        }
      }
    } finally {
      if (claimWritten && deletionConfirmed) {
        try {
          await fsp.rm(path.join(claimsDir(stateDir), `${machineName}.json`), { force: true });
        } catch {}
      }
      if (lockHandle) releaseLock(stateDir, lockHandle); // only release our exact claim
    }
    return !claimWritten || deletionConfirmed;
  }

  async function run() {
    let exitCode = EXIT_FAILURE;
    let deadlineTimer;
    try {
      deadlineTimer = timers.setTimeout(() => fireAbort('deadline'), deadlineMs);
      fs.mkdirSync(stateDir, { recursive: true });
      lockHandle = acquireLock(stateDir);
      await recoverStale({ stateDir, invoker: { runStep: (step) => runStepOnce(step, step.timeoutMs) }, log });
      const claim = { machine: machineName, pid: process.pid, startedAt: now(), deadlineAt };
      await writeClaim(stateDir, claim);
      claimWritten = true;
      log(`claimed disposable machine ${machineName} (deleted unconditionally when this run ends)`);

      let uid = null;
      const plan = buildPlan({ machineName, snapshotPath, artifacts, artifactsHostDir, bootstrapScriptDir, bootstrapScriptName });
      for (const step of plan) {
        if (step.poll) {
          const pollStart = now();
          let r = null;
          for (;;) {
            r = await runStepOnce(step, remainingMs());
            if (r.code === 0) break;
            if (now() - pollStart >= step.timeoutMs) {
              throw new IsolationError(`machine did not boot within ${step.timeoutMs} ms`);
            }
            if (remainingMs() <= step.poll.intervalMs) {
              throw new DeadlineError('machine did not boot within the hard deadline');
            }
            await raceWithAbort(sleep(timers, step.poll.intervalMs), 'boot-wait');
          }
          continue;
        }
        const r = await runStepOnce(step, step.timeoutMs);
        if (step.id === 'discover-uid') {
          const parsed = Number.parseInt((r.stdout || '').trim(), 10);
          if (!Number.isInteger(parsed) || parsed <= 0) {
            throw new IsolationError(`could not read the machine user's id (got: ${JSON.stringify(r.stdout)})`);
          }
          uid = parsed;
          continue;
        }
        if (r.code !== 0) {
          throw new IsolationError(`step ${step.id} failed with exit code ${r.code}`);
        }
      }

      const tail = vitestSteps({ machineName, uid, vitestArgs });
      for (const step of tail) {
        const r = await runStepOnce(step, step.id === 'vitest' ? remainingMs() : step.timeoutMs);
        if (step.id === 'vitest') {
          log(`vitest exited ${r.code}`);
          exitCode = r.code; // preserve the test's exit status
          break;
        }
        if (r.code !== 0) {
          throw new IsolationError(`step ${step.id} failed with exit code ${r.code}`);
        }
      }
    } catch (e) {
      if (abort && abort.kind === 'deadline') {
        exitCode = EXIT_TIMEOUT;
      } else if (e instanceof CancelledError) {
        exitCode = abort && abort.signalName === 'SIGTERM' ? EXIT_SIGTERM : EXIT_SIGINT;
      } else if (e instanceof DeadlineError) {
        exitCode = EXIT_TIMEOUT;
        log(`deadline: ${e.message}`);
      } else if (e instanceof UsageError) {
        exitCode = EXIT_USAGE;
        log(`usage: ${e.message}`);
      } else {
        exitCode = EXIT_FAILURE;
        log(e instanceof IsolationError ? `refused: ${e.message}` : `failed: ${e.stack || e.message}`);
      }
    } finally {
      try {
        const cleanedUp = await cleanup();
        if (!cleanedUp && exitCode === 0) exitCode = EXIT_FAILURE;
      } catch (e) {
        if (exitCode === 0) exitCode = EXIT_FAILURE;
        log(`cleanup error: ${e.message}`);
      }
      if (deadlineTimer) timers.clearTimeout(deadlineTimer);
    }
    return exitCode;
  }

  return {
    run,
    cancel: (signalName) => fireAbort('signal', signalName),
    get abortReason() {
      return abort;
    },
    get stateDirPath() {
      return stateDir;
    },
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export function findOrbctl({ existsSync = fs.existsSync } = {}) {
  const candidates = [
    process.env.LIFEMODEL_TEST_ORBCTL,
    '/opt/homebrew/bin/orbctl',
    '/usr/local/bin/orbctl',
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'orbctl')),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new IsolationError(
    'orbctl not found (looked on PATH, /opt/homebrew/bin, /usr/local/bin). Docker isolation needs OrbStack; refusing to run without it — no fallback to the owner daemon.',
  );
}

/** Fail closed on hosts this helper does not support. OrbStack is macOS only. */
export function requireSupportedHost(platform = process.platform) {
  if (platform === 'darwin') return;
  throw new IsolationError(
    `unsupported host platform: ${platform}. Docker isolation runs in a disposable OrbStack machine (macOS only); on ${platform} this helper refuses to run rather than weaken isolation or touch any host Docker daemon (Linux backend is out of scope).`,
  );
}

export async function main(argv) {
  const write = (line) => process.stderr.write(`${line}\n`);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usageText()}\n`);
    return 0;
  }
  const parsed = parseArgs(argv);
  requireSupportedHost();
  const snapshot = await validateSnapshot(parsed.snapshot);
  const arch = machineArch();
  const stateDir = defaultStateDir();
  const artifactsDir = path.join(stateDir, 'artifacts');
  const log = (line) => write(`[test-docker-isolated] ${line}`);

  log(`snapshot: ${snapshot.path} (${snapshot.entries} entries)`);
  log(`deadline: ${parsed.timeoutMs}ms`);

  const orbctlPath = findOrbctl();
  log(`orbctl: ${orbctlPath}`);
  const invoker = createOrbInvoker({ orbctlPath, log });

  const bootstrapScriptPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'docker',
    'test',
    'bootstrap-orb.sh',
  );
  if (!fs.existsSync(bootstrapScriptPath)) {
    throw new IsolationError(`bootstrap script missing: ${bootstrapScriptPath}`);
  }
  const artifacts = await ensureArtifacts({
    arch,
    cacheDir: artifactsDir,
    download: async (url) => {
      // bounded: a hung artifact download must not outlive the helper
      const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new IsolationError(`download failed (${res.status}): ${url}`);
      return Buffer.from(await res.arrayBuffer());
    },
    log,
  });

  const machineName = makeMachineName(newRunId());
  const runner = createRunner({
    invoker,
    machineName,
    snapshotPath: snapshot.path,
    vitestArgs: parsed.vitestArgs,
    artifacts,
    artifactsHostDir: path.dirname(artifacts[0].hostPath),
    bootstrapScriptDir: path.dirname(bootstrapScriptPath),
    bootstrapScriptName: path.basename(bootstrapScriptPath),
    stateDir,
    deadlineMs: parsed.timeoutMs,
    log,
  });

  const onSignal = (signalName) => {
    log(`received ${signalName}`);
    runner.cancel(signalName);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  const code = await runner.run();
  log(`exit ${code}`);
  return code;
}

function invokedDirectly() {
  try {
    // realpath both sides: macOS exposes /var as a symlink to /private/var.
    return (
      process.argv[1] != null && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((e) => {
      process.stderr.write(`${e instanceof UsageError ? e.message : e.stack || e.message}\n`);
      process.exit(e instanceof UsageError ? EXIT_USAGE : EXIT_FAILURE);
    });
}
