import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { waitUntil } from '../helpers/loader-doubles.js';

const guard = fileURLToPath(new URL('./loader-signal-guard.mjs', import.meta.url));
type Scenario = 'pass' | 'failure' | 'SIGINT' | 'SIGTERM';
type Identity = { pid: number; start: string; group: number; state: string };
type RequiredIdentity = {
  pid: number;
  starttime: string;
  pgrp: number;
  nonZombie: boolean;
  role: string;
};
type Report = {
  clean: boolean;
  ownedRoot: string;
  rootCleanup: {
    beforeExists: boolean;
    afterGone: boolean;
    error?: string;
  };
  result: { code: number };
  parentLost: boolean;
  readiness: { group: number; before: Identity[]; required: RequiredIdentity[] };
  groupSignal?: {
    signal: string;
    group: number;
    before: Identity[];
    beforeSignalling: RequiredIdentity[];
  };
  runnerMember?: Identity;
  group: number;
  remaining: unknown[];
  closed: boolean;
  seen: Identity[];
};
function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); });
  });
}
function assertRequired(
  entries: RequiredIdentity[] | undefined,
  caseName: 'loader' | 'supervisor',
  group: number | undefined
) {
  const roles = caseName === 'loader'
    ? ['loader', 'lifemodel-standin', 'caddy', 'vault']
    : ['instance'];
  expect(entries?.map(entry => entry.role)).toEqual(roles);
  expect(new Set(entries?.map(entry => entry.pid)).size).toBe(roles.length);
  expect(Number.isSafeInteger(group) && Number(group) > 0).toBe(true);
  expect(entries?.every(entry =>
    Number.isSafeInteger(entry.pid) && entry.pid > 0 && entry.pid !== group &&
    typeof entry.starttime === 'string' && /^\d+$/.test(entry.starttime) &&
    entry.pgrp === group && entry.nonZombie === true
  )).toBe(true);
}

// Source-only proposal. Root static review is required before any execution.
// Eight scenarios, with Node fixtures only. No nested Vitest workers.
// This is Linux Node-group kernel proof, NOT actual Vitest lifecycle proof.
// No guarantee covers guard SIGKILL, escaped groups, or failed reaping.
// Retain artifacts when settlement or validation fails.
// Identity loss must never become a clean zero result.
// Required identities are checked individually, not atomically as a set.
// Check/use races still prevent a guarantee of absolute concurrent liveness.
async function prove(caseName: 'loader' | 'supervisor', scenario: Scenario) {
  const root = mkdtempSync(join(tmpdir(), 'loader-signal-proof-'));
  const proof = join(root, 'settled.json');
  // Register control ownership immediately, before child allocation or startup.
  const artifacts = { controlRoot: root, proof, ownedRoot: undefined as string | undefined };
  let ownedRoot: string | undefined;
  let runner!: ReturnType<typeof spawn>;
  // A synchronous spawn throw does not prove that no process started.
  let startAttempted = false;
  let settlementVerified = false;
  let controlRemovalStarted = false;
  let controlRemovalSettled = false;
  let controlAbsenceVerified = false;
  let ready = false, finished = false, closed = false;
  let fixtureRoot: string | undefined;
  let live: Report['readiness'] | undefined;
  let stderr = '';
  const failures: unknown[] = [];
  // If startup throws before listeners exist, settlement remains unproven.
  // These pending promises are still subject to the final bounded waits.
  let exit = new Promise<{ code: number | null; signal: string | null }>(() => undefined);
  let close = new Promise<void>(() => undefined);
  function send(message: object) {
    return new Promise<void>((resolve, reject) => {
      try {
        if (!runner.connected) throw new Error('runner IPC disconnected');
        runner.send(message, error => { if (error) reject(error); else resolve(); });
      } catch (error) { reject(error); }
    });
  }
  let report: Report | undefined;
  async function settlement() {
    const allocatedRoot = ownedRoot;
    if (allocatedRoot === undefined) throw new Error('owned world root was not allocated');
    await waitUntil(() => {
      try { report = JSON.parse(readFileSync(proof, 'utf8')) as Report; return true; }
      catch { return false; }
    }, `guard settlement record retained at ${proof}`, 15_000);
    expect(report?.clean).toBe(true);
    expect(report?.closed).toBe(true);
    expect(report?.remaining).toEqual([]);
    expect(report?.seen.length).toBeGreaterThan(1);
    expect(report?.ownedRoot).toBe(allocatedRoot);
    expect(report?.rootCleanup).toEqual({
      beforeExists: true,
      afterGone: true,
    });
    // Independent observer check. Only ENOENT proves absence.
    let absent = false;
    try {
      await lstat(allocatedRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      absent = true;
    }
    expect(absent).toBe(true);
    settlementVerified = true;
  }
  try {
    // Allocation, spawn and listener setup share the original-error collector.
    ownedRoot = mkdtempSync(join(root, 'loader-signal-'));
    artifacts.ownedRoot = ownedRoot;
    startAttempted = true;
    runner = spawn(process.execPath,
      [guard, 'runner', proof, scenario, caseName, root, ownedRoot], {
        detached: true,
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: root, LANG: 'C' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    exit = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      runner.once('error', reject);
      runner.once('exit', (code, signal) => { finished = true; resolve({ code, signal }); });
    });
    void exit.catch(() => undefined);
    close = new Promise<void>(resolve => {
      runner.once('close', () => { closed = true; resolve(); });
    });
    runner.stdout!.on('error', () => { if (runner.connected) runner.disconnect(); });
    runner.stderr!.on('error', () => { if (runner.connected) runner.disconnect(); });
    runner.stdout!.resume();
    runner.stderr!.on('data', chunk => { stderr += chunk.toString(); });
    runner.on('message', (message: {
      type?: string; root?: string; readiness?: Report['readiness'];
    }) => {
      if (message.type === 'ready') {
        if (ready || message.root !== ownedRoot) {
          failures.push(new Error('duplicate or mismatched world root readiness'));
          try { if (runner.connected) runner.disconnect(); } catch { /* best effort */ }
          return;
        }
        ready = true;
        fixtureRoot = ownedRoot;
        live = message.readiness;
      }
    });
    await waitUntil(() => ready || finished, 'fixture readiness', 25_000);
    expect(ready).toBe(true);
    expect(fixtureRoot).toBeDefined();
    expect(fixtureRoot).toBe(ownedRoot);
    // Independent existence check while the world remains paused.
    expect((await lstat(ownedRoot)).isDirectory()).toBe(true);
    assertRequired(live?.required, caseName, live?.group);
    // The world remains paused while these observer assertions run.
    if (scenario === 'pass' || scenario === 'failure') {
      await bounded(send({ type: 'continue' }), 2_000, 'observer continuation');
    } else {
      await bounded(send({ type: 'interrupt', signal: scenario }), 2_000, 'interrupt instruction');
    }
    const outcome = await bounded(exit, 40_000, 'actual runner exit');
    await bounded(close, 15_000, 'actual runner close');
    await bounded(settlement(), 16_000, 'guard settlement');
    expect(report?.readiness).toEqual(live);
    expect(report?.readiness.group).toBe(report?.group);
    assertRequired(report?.readiness.required, caseName, report?.group);
    if (scenario === 'pass' || scenario === 'failure') {
      const code = scenario === 'pass' ? 0 : 1;
      expect(outcome).toEqual({ code, signal: null });
      expect(report?.result.code).toBe(code);
    } else {
      expect(outcome.signal).toBe(scenario);
      expect(report?.parentLost).toBe(true);
      expect(report?.groupSignal?.signal).toBe(scenario);
      expect(report?.groupSignal?.group).toBe(report?.group);
      assertRequired(report?.groupSignal?.beforeSignalling, caseName, report?.group);
      // Same named PIDs, start times, groups and non-zombie checks for every role.
      expect(report?.groupSignal?.beforeSignalling).toEqual(live?.required);
      const member = JSON.parse(readFileSync(`${proof}.member.json`, 'utf8'));
      expect(member.signal).toBe(scenario);
      expect(member.pid).toBe(report?.runnerMember?.pid);
      expect(report?.runnerMember?.group).toBe(runner.pid);
    }
    expect(stderr).toBe('');
  } catch (error) {
    failures.push(error);
  } finally {
    // No observer PGID kill, including after uncertain synchronous spawn failure.
    try {
      if (runner?.connected) runner.disconnect();
    } catch (error) {
      failures.push(error);
    }

    if (startAttempted) {
      // Attempt all three bounded waits even after body or setup failure.
      try {
        await bounded(exit, 15_000, 'final runner exit');
      } catch (error) {
        failures.push(error);
      }
      try {
        await bounded(close, 15_000, 'final runner close');
      } catch (error) {
        failures.push(error);
      }
      try {
        await bounded(settlement(), 16_000, 'final guard settlement');
      } catch (error) {
        failures.push(error);
      }
    }

    // NoProcessStarted: only owned directories can need cleanup.
    // SpawnMayExist: only verified native settlement licenses cleanup.
    // Preserve proof data through verification, and retain it on any failure.
    const cleanupLicensed = failures.length === 0 &&
      (!startAttempted || (closed && settlementVerified));
    if (cleanupLicensed) {
      // One explicit deadline covers both removal and independent observation.
      // Racing this deadline does NOT cancel an already-started filesystem call.
      const cleanupDeadline = Date.now() + 4_000;
      async function filesystemStep<T>(
        operation: () => Promise<T>,
        label: string
      ): Promise<T> {
        const remaining = cleanupDeadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`${label}: control cleanup deadline exceeded; path: ${root}`);
        }
        return bounded(operation(), remaining, `${label}; path: ${root}`);
      }
      try {
        await filesystemStep(() => {
          controlRemovalStarted = true;
          return rm(root, { recursive: true, force: false }).then(
            () => { controlRemovalSettled = true; },
            error => { controlRemovalSettled = true; throw error; }
          );
        }, 'control-root removal');
      } catch (error) {
        failures.push(error);
      }
      // Independent of remover success. A successful no-op must fail here.
      try {
        await filesystemStep(async () => {
          let absent = false;
          try {
            await lstat(root);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            absent = true;
          }
          expect(absent).toBe(true);
          controlAbsenceVerified = true;
        }, 'independent control-root absence assertion');
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length !== 0) {
    const removalState = controlRemovalStarted
      ? controlRemovalSettled
        ? 'removal settled; failure may have left partial artifacts'
        : 'removal may still be pending; deadline race did not cancel it'
      : 'removal not started; owned artifacts retained';
    throw new AggregateError(failures,
      `signal proof failed (Linux Node-group directory scope only); ` +
      `artifact locations: ${JSON.stringify(artifacts)}; ` +
      `process state: ${startAttempted ? 'SpawnMayExist' : 'NoProcessStarted'}; ` +
      `${removalState}; control absence verified: ${controlAbsenceVerified}. ` +
      `Reported paths may be absent or partially removed after attempted cleanup.`);
  }
}
describe('owned real signal fixtures', () => {
  for (const caseName of ['loader', 'supervisor'] as const)
    for (const scenario of ['pass', 'failure', 'SIGINT', 'SIGTERM'] as const)
      // Allow body deadlines, all three final waits, and directory cleanup.
      // This outer timeout is not filesystem cancellation or settlement proof.
      it(`${caseName}: ${scenario}`, () => prove(caseName, scenario), 160_000);
});
