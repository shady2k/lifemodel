import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { lstat, rm } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, proof, scenario, caseName, home, ownedRoot] = process.argv.slice(2);
// Trust only the explicit root supplied by this fixture's observer.
// No directory scan, prefix routing, or readiness-derived replacement path.
if (!home || !ownedRoot || !isAbsolute(home) || !isAbsolute(ownedRoot) ||
    resolve(home) !== home || resolve(ownedRoot) !== ownedRoot ||
    dirname(ownedRoot) !== home) {
  throw new Error('invalid explicit world-root ownership');
}
const file = fileURLToPath(import.meta.url);
const world = fileURLToPath(new URL('./loader-signal-world.mts', import.meta.url));
const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, LANG: 'C' };
const interrupted = scenario === 'SIGINT' || scenario === 'SIGTERM';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function send(target, message, gone) {
  try {
    if (!target.connected || !target.send) return gone();
    target.send(message, error => { if (error) gone(error); });
  } catch (error) { gone(error); }
}
function disconnect(target) {
  try { if (target?.connected) target.disconnect(); } catch { /* best effort */ }
}

if (mode === 'member') {
  // Inherit the runner group. This member proves group, rather than PID, delivery.
  function finish(signal) {
    try {
      writeFileSync(`${proof}.member.json`, JSON.stringify({ pid: process.pid, signal }));
    } catch { process.exit(1); }
    process.exit(signal ? 0 : 1);
  }
  process.on('SIGINT', () => finish('SIGINT'));
  process.on('SIGTERM', () => finish('SIGTERM'));
  process.on('disconnect', () => finish(null));
  process.on('error', () => finish(null));
  process.stdout.on('error', () => finish(null));
  process.stderr.on('error', () => finish(null));
  setInterval(() => undefined, 1000);
  send(process, { type: 'memberReady', pid: process.pid }, () => finish(null));
} else if (mode === 'runner') {
  // Spawned detached by the observer: process.pid is our private, live PGID.
  // Keep default signal dispositions. The detached guard is outside this group.
  const guard = spawn(process.execPath,
    [file, 'guard', proof, scenario, caseName, home, ownedRoot],
    { detached: true, env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  let member;
  let lost = false;
  let requested;
  function parentGone() {
    if (lost) return;
    lost = true;
    // Cleanup starts on the guard's actual IPC disconnect, not a synthetic ack.
    disconnect(guard);
    disconnect(member);
  }
  process.on('disconnect', parentGone);
  process.on('error', parentGone);
  process.stdout.on('error', parentGone);
  process.stderr.on('error', parentGone);
  guard.on('error', parentGone);
  guard.on('message', message => {
    if (message.type === 'groupSignalled') {
      if (!lost && requested === message.signal) {
        // No observer check/use gap: the caller itself is necessarily alive.
        try { process.kill(-process.pid, requested); }
        catch (error) {
          send(guard, { type: 'runnerFault', error: String(error) }, parentGone);
          parentGone();
          process.exitCode = 1;
        }
      }
      return;
    }
    send(process, message, parentGone);
  });
  process.on('message', message => {
    if (lost) return;
    if (message.type === 'interrupt') {
      if (!interrupted || requested || message.signal !== scenario) return;
      requested = message.signal;
      send(guard, { type: 'groupSignal', signal: requested }, parentGone);
    } else if (message.type === 'continue' && !interrupted) {
      send(guard, message, parentGone);
    }
  });
  if (interrupted) {
    member = spawn(process.execPath,
      [file, 'member', proof, scenario, caseName, home, ownedRoot],
      { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    member.on('error', parentGone);
    member.on('message', message => {
      if (message.type === 'memberReady') send(guard, message, parentGone);
    });
  }
  guard.once('close', (code, signal) => {
    process.exitCode = signal === null ? (code ?? 1) : 1;
    disconnect(member);
    disconnect(process);
  });
} else if (mode === 'guard') {
  if (process.platform !== 'linux') throw new Error('Linux /proc is required');
  function stat(pid) {
    try {
      const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
      return { pid: Number(pid), state: fields[0], group: Number(fields[2]), start: fields[19] };
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
      throw error;
    }
  }
  function members(group) {
    // Enumerate only to select this private group, never by owner or global name.
    return readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(stat)
      .filter(entry => entry !== null && entry.group === group);
  }
  const requiredRoles = caseName === 'loader'
    ? ['loader', 'lifemodel-standin', 'caddy', 'vault']
    : caseName === 'supervisor' ? ['instance'] : null;
  if (!requiredRoles) throw new Error('unknown signal fixture case');

  let child, identity, spawnError, stopping, cleanupTimer, runnerMember;
  let closed = false, finished = false, parentLost = false, requested = false;
  let readyMessage, readiness, groupSignal, continued = false;
  let result = { code: 1, error: 'fixture did not return a result' };
  let settledReport;
  const rootCleanup = { beforeExists: false, afterGone: false };
  const seen = new Map();
  function publish(report, code) {
    if (finished) return;
    finished = true;
    clearTimeout(runtimeTimer);
    clearTimeout(cleanupTimer);
    try { writeFileSync(proof, JSON.stringify(report)); } catch { code = 1; }
    process.exit(code);
  }
  function fail(error) {
    publish({ ...settledReport, clean: false, result, error: String(error),
      ownedRoot, rootCleanup, parentLost, readiness,
      groupSignal, runnerMember, seen: [...seen.values()] }, 1);
  }
  function parentGone() { parentLost = true; void stop(); }
  process.on('disconnect', parentGone);
  process.on('error', parentGone);
  process.stdout.on('error', parentGone);
  process.stderr.on('error', parentGone);
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  const runtimeTimer = setTimeout(() => void stop(), 35_000);
  child = spawn(process.execPath,
    ['--import', 'tsx', world, caseName, scenario, ownedRoot],
    { detached: true, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const spawned = new Promise(resolve => {
    child.once('spawn', () => resolve(true));
    child.once('error', error => { spawnError = error; resolve(false); void stop(); });
  });
  const close = new Promise(resolve => {
    child.once('close', () => { closed = true; resolve(); void stop(); });
  });
  child.once('exit', () => void stop());
  child.stdout.on('error', () => void stop());
  child.stderr.on('error', () => void stop());
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  function anchored() {
    const current = stat(child.pid);
    if (!identity || !current || current.start !== identity.start ||
        current.group !== child.pid || current.state === 'Z' || closed) {
      throw new Error('group anchor lost; refusing a possibly reused PGID');
    }
  }
  function snapshot() {
    const entries = members(child.pid);
    for (const entry of entries) seen.set(`${entry.pid}:${entry.start}`, entry);
    return entries;
  }
  async function acquireIdentity() {
    if (!await spawned) throw spawnError ?? new Error('spawn failed');
    const end = Date.now() + 1_000;
    do {
      const current = stat(child.pid);
      if (current && current.group === child.pid && current.state !== 'Z') {
        identity = current;
        return;
      }
      if (closed) break;
      await delay(25);
    } while (Date.now() < end);
    throw new Error('could not acquire private group anchor identity');
  }
  const identityReady = acquireIdentity();
  void identityReady.catch(error => { result = { code: 1, error: String(error) }; void stop(); });

  function requiredIdentity(descriptor, expected) {
    if (!descriptor || !Number.isSafeInteger(descriptor.pid) ||
        descriptor.pid <= 0 || descriptor.pid === child.pid) {
      throw new Error('invalid required workload PID');
    }
    const current = stat(descriptor.pid);
    if (!current || current.group !== child.pid ||
        current.state === 'Z' || current.state === 'X' ||
        typeof current.start !== 'string' || !/^\d+$/.test(current.start)) {
      throw new Error(`required workload is not live in private group: ${descriptor.role}`);
    }
    if (expected && (current.pid !== expected.pid ||
        current.start !== expected.starttime || current.group !== expected.pgrp ||
        descriptor.role !== expected.role || expected.nonZombie !== true)) {
      throw new Error(`required workload identity changed: ${descriptor.role}`);
    }
    seen.set(`${current.pid}:${current.start}`, current);
    return {
      pid: current.pid,
      starttime: current.start,
      pgrp: current.group,
      nonZombie: true,
      role: descriptor.role,
    };
  }
  function captureRequired(descriptors) {
    if (!Array.isArray(descriptors) || descriptors.length !== requiredRoles.length ||
        new Set(descriptors.map(entry => entry?.pid)).size !== requiredRoles.length ||
        requiredRoles.some(role => descriptors.filter(entry => entry?.role === role).length !== 1)) {
      throw new Error('readiness must identify every required workload role exactly once');
    }
    return requiredRoles.map(role =>
      requiredIdentity(descriptors.find(entry => entry.role === role)));
  }
  function forwardReady() {
    if (stopping || readiness || !readyMessage || (interrupted && !runnerMember)) return;
    anchored();
    const before = snapshot().filter(entry => entry.state !== 'Z');
    const required = captureRequired(readyMessage.required);
    readiness = { group: child.pid, before, required };
    send(process, { ...readyMessage, required, readiness }, parentGone);
  }
  function fault(error) { result = { code: 1, error: String(error) }; void stop(); }
  child.on('message', message => {
    if (message.type === 'ready') {
      if (readyMessage || message.root !== ownedRoot) {
        fault('duplicate or mismatched world root readiness');
        return;
      }
      // Copy trusted fields; later packets cannot replace ownership or readiness.
      readyMessage = {
        type: 'ready',
        root: ownedRoot,
        required: message.required,
      };
      void identityReady.then(forwardReady).catch(fault);
    } else if (message.type === 'barrierFault') {
      fault(message.error);
    } else if (message.type === 'result') {
      result = message;
      // An unexpected result cannot outrun an interruption request.
      if (!interrupted) void stop();
    }
  });
  process.on('message', message => {
    try {
      if (message.type === 'memberReady') {
        const current = stat(message.pid);
        if (!current || current.state === 'Z' || current.group !== process.ppid)
          throw new Error('runner witness is not a live member of the runner group');
        runnerMember = current;
        void identityReady.then(forwardReady).catch(fault);
      } else if (message.type === 'continue') {
        if (!readiness || continued || interrupted || stopping) return;
        continued = true;
        send(child, { type: 'continue' }, parentGone);
      } else if (message.type === 'groupSignal') {
        if (!interrupted || message.signal !== scenario || requested || stopping) return;
        if (!readiness) throw new Error('interruption before observed readiness');
        requested = true;
        anchored();
        const before = snapshot().filter(entry => entry.state !== 'Z');
        // Individually re-read every required PID immediately before signalling.
        // No await, IPC send, or group enumeration separates these checks and kill.
        const beforeSignalling = readiness.required.map(expected =>
          requiredIdentity(expected, expected));
        // Sequential checks cannot guarantee absolute concurrent liveness.
        // A required process can still exit after its check and before delivery.
        process.kill(-child.pid, message.signal);
        groupSignal = { signal: message.signal, group: child.pid, before, beforeSignalling };
        send(process, { type: 'groupSignalled', signal: message.signal }, parentGone);
        // Do NOT stop here. The runner must actually self-signal and disconnect.
      } else if (message.type === 'runnerFault') fault(message.error);
    } catch (error) { fault(error); }
  });
  function stop() {
    if (stopping) return stopping;
    cleanupTimer = setTimeout(() => fail('hard cleanup deadline exceeded'), 12_000);
    stopping = (async () => {
      await identityReady;
      anchored();
      snapshot();
      process.kill(-child.pid, 'SIGTERM');
      const grace = Date.now() + 5_000;
      while (Date.now() < grace) {
        anchored();
        if (snapshot().every(entry => entry.pid === child.pid)) break;
        await delay(25);
      }
      anchored();
      snapshot();
      process.kill(-child.pid, 'SIGKILL'); // Last-ever signal to this workload PGID.
      const end = Date.now() + 5_000;
      const memberPresent = () => {
        if (!runnerMember) return false;
        return stat(runnerMember.pid)?.start === runnerMember.start;
      };
      while ((!closed || members(child.pid).length !== 0 || memberPresent()) && Date.now() < end)
        await delay(25);
      if (!closed || members(child.pid).length !== 0 || memberPresent())
        throw new Error('owned workload or runner witness did not settle');
      await close;
      settledReport = {
        clean: true, result, parentLost, readiness, groupSignal, runnerMember,
        group: child.pid, remaining: [], closed, seen: [...seen.values()],
        ownedRoot,
      };

      // All existing native-close, empty-group, and witness checks passed.
      // This detached guard owns the explicit root independently of runner IPC.
      // It can therefore finish cleanup after the runner or observer disconnects.
      // Never use result.roots or a later ready packet as deletion authority.
      try {
        const before = await lstat(ownedRoot);
        if (!before.isDirectory() || before.isSymbolicLink())
          throw new Error('owned world root is not a directory');
        rootCleanup.beforeExists = true;
        await rm(ownedRoot, { recursive: true, force: false });
        try {
          await lstat(ownedRoot);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          rootCleanup.afterGone = true;
        }
        if (!rootCleanup.afterGone)
          throw new Error('owned world root remains after removal');
      } catch (error) {
        rootCleanup.error = String(error);
        throw error;
      }
      publish({ ...settledReport, rootCleanup }, result.code);
    })().catch(fail);
    return stopping;
  }
} else {
  throw new Error('unknown guard mode');
}
