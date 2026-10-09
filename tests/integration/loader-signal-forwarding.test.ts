import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
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
// Retain every artifact; identity loss must never become a clean zero result.
// Required identities are checked individually, not atomically as a set.
// Check/use races still prevent a guarantee of absolute concurrent liveness.
async function prove(caseName: 'loader' | 'supervisor', scenario: Scenario) {
  const root = mkdtempSync(join(tmpdir(), 'loader-signal-proof-'));
  const proof = join(root, 'settled.json');
  const runner = spawn(process.execPath,
    [guard, 'runner', proof, scenario, caseName, root], {
      detached: true,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: root, LANG: 'C' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
  let ready = false, finished = false, closed = false;
  let fixtureRoot: string | undefined;
  let live: Report['readiness'] | undefined;
  let stderr = '';
  runner.stdout.on('error', () => { if (runner.connected) runner.disconnect(); });
  runner.stderr.on('error', () => { if (runner.connected) runner.disconnect(); });
  runner.stdout.resume();
  runner.stderr.on('data', chunk => { stderr += chunk.toString(); });
  runner.on('message', (message: {
    type?: string; root?: string; readiness?: Report['readiness'];
  }) => {
    if (message.type === 'ready') {
      ready = true;
      fixtureRoot = message.root;
      live = message.readiness;
    }
  });
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    runner.once('error', reject);
    runner.once('exit', (code, signal) => { finished = true; resolve({ code, signal }); });
  });
  const close = new Promise<void>(resolve => {
    runner.once('close', () => { closed = true; resolve(); });
  });
  void exit.catch(() => undefined);
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
    await waitUntil(() => {
      try { report = JSON.parse(readFileSync(proof, 'utf8')) as Report; return true; }
      catch { return false; }
    }, `guard settlement record retained at ${proof}`, 15_000);
    expect(report?.clean).toBe(true);
    expect(report?.closed).toBe(true);
    expect(report?.remaining).toEqual([]);
    expect(report?.seen.length).toBeGreaterThan(1);
  }
  try {
    await waitUntil(() => ready || finished, 'fixture readiness', 25_000);
    expect(ready).toBe(true);
    expect(fixtureRoot).toBeDefined();
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
  } finally {
    // No observer PGID kill, including after timeout or completed cleanup.
    try { if (runner.connected) runner.disconnect(); } catch { /* best effort */ }
    await bounded(exit, 15_000, 'final runner exit');
    if (!closed) await bounded(close, 15_000, 'final runner close');
    await bounded(settlement(), 16_000, 'final guard settlement');
  }
}
describe('owned real signal fixtures', () => {
  for (const caseName of ['loader', 'supervisor'] as const)
    for (const scenario of ['pass', 'failure', 'SIGINT', 'SIGTERM'] as const)
      it(`${caseName}: ${scenario}`, () => prove(caseName, scenario), 100_000);
});
