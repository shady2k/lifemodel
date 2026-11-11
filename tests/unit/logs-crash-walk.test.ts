/** WALK-LOGS-CRASH (ADR-016 L07, §6): the walk is an operator script for a
 * deployed build, so these checks hold its verdict, its not-valid states and the
 * way it reads the collector's buffer against the fake node in
 * `tests/fixtures/logs-crash-walk-harness.py`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const WALK = join('deploy', 'platform', 'logs-crash-walk.py');
const HARNESS = join('tests', 'fixtures', 'logs-crash-walk-harness.py');

interface Run {
  readonly status: number | null;
  readonly lines: readonly string[];
}

function python(args: readonly string[]): Run {
  const result = spawnSync('python3', args, { encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  return { status: result.status, lines: result.stdout.split('\n') };
}

function jsonLine<T>(run: Run, prefix: string): T {
  const line = run.lines.find((entry) => entry.startsWith(prefix + ' '));
  expect(line).toBeDefined();
  return JSON.parse((line ?? '').slice(prefix.length + 1)) as T;
}

let directory = '';

function harness(mode: string, value: object = {}): Run {
  const fixture = join(directory, mode + '.json');
  writeFileSync(fixture, JSON.stringify(value));
  return python([HARNESS, mode, WALK, fixture]);
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'logs-crash-walk-'));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("the crash walk's argument handling", () => {
  it('names the Flux owner lookup, the reconcile annotation and the saturation ceiling', () => {
    const header = readFileSync(WALK, 'utf8').split('\n').slice(0, 220).join('\n');
    expect(header).toContain('kustomize.toolkit.fluxcd.io/name');
    expect(header).toContain('reconcile.fluxcd.io/requestedAt');
    expect(header).toContain('spec.suspend');
    expect(header).toContain('--fill-ceiling');
  });

  it('prints its usage and exits 0 on --help', () => {
    const run = python([WALK, '--help']);
    expect(run.status).toBe(0);
    const help = run.lines.join('\n');
    for (const name of [
      '--password-file',
      '--collector',
      '--writer-namespace',
      '--metrics-port',
      '--crictl',
      '--fill-bound',
      '--recover-bound',
      '--restore-bound',
      '--writer-rate',
      '--max-load',
      '--saturated-seconds',
      '--unsaturated-lines',
    ]) {
      expect(help).toContain(name);
    }
  });

  it('refuses an unknown argument and a missing password file', () => {
    expect(python([WALK, '--no-such-argument']).status).toBe(2);
    expect(python([WALK]).status).toBe(2);
  });
});

describe('the crash walk states its rows and what it cannot prove', () => {
  it('names its walk, L07, the buffer gauges and the kubelet verdict', () => {
    const header = readFileSync(WALK, 'utf8').split('\n').slice(0, 200).join('\n');
    expect(header).toContain('WALK-LOGS-CRASH');
    expect(header).toMatch(/ADR-016 L07/);
    expect(header).toContain('vector_buffer_size_events');
    expect(header).toContain('vector_buffer_max_size_events');
    expect(header).toContain('/var/log/pods');
    expect(header).toContain('kill -9');
    expect(header).toMatch(/What it does not cover/);
  });

  it('says exactly what the saturated case needs when nothing exposes the buffer', () => {
    const run = harness('not-valid-buffer');
    const value = jsonLine<{ text: string; saturated: boolean }>(run, 'GAP');
    expect(value.saturated).toBe(false);
    expect(value.text).toContain('internal_metrics');
    expect(value.text).toContain('prometheus_exporter');
    expect(value.text).toContain('127.0.0.1:9598');
    expect(value.text).toContain('vector.yaml');
  });

  it('picks the logs-store series by component_id, and says why a scrape failed', () => {
    const state = jsonLine<{ size: number; max: number; received: number }>(
      harness('metrics-component'),
      'STATE'
    );
    expect(state).toEqual({ size: 0, max: 500000, received: 143 });
    const scraped = jsonLine<{ text: string }>(harness('metrics-scrape-fails'), 'GAP');
    expect(scraped.text).toContain('cannot be scraped');
    expect(scraped.text).not.toContain('no exporter');
    const series = jsonLine<{ text: string }>(harness('metrics-no-store-series'), 'GAP');
    expect(series.text).toContain('none for component_id=\"logs-store\"');
    expect(series.text).not.toContain('cannot be scraped');
  }, 30000);

  it('marks a writer that never fills the buffer as not valid', () => {
    const value = jsonLine<{ saturated: boolean }>(harness('slow-writer'), 'SLOW');
    expect(value.saturated).toBe(false);
  }, 30000);

  it('fails a collector that restarts before its buffer is full, and still counts', () => {
    const run = harness('oom-before-full');
    const value = jsonLine<{ ok: boolean; detail: string; counting: string }>(run, 'OOM');
    expect(value.ok).toBe(false);
    expect(value.detail).toContain('OOMKilled');
    expect(value.detail).toContain('buffer 410000 of 500000');
    expect(value.counting).toContain('lost while still in the kubelet');
    expect(run.lines.join('\n')).toContain(
      "the collector's buffer cannot reach its maximum inside its memory limit"
    );
    expect(run.status).toBe(1);
  }, 30000);

  it('fails the kill when crictl reports pid 1', () => {
    const run = harness('not-valid-pid');
    const value = jsonLine<{ pid: number | null; detail: string }>(run, 'PID');
    expect(value.pid).toBeNull();
    expect(value.detail).toContain('pid 1');
    expect(value.detail).toContain('nothing would be killed');
  });

  it('kills the vector process by a real pid', () => {
    const run = harness('pid-real');
    expect(jsonLine<{ pid: number }>(run, 'PID').pid).toBe(4242);
  });
});

describe('the crash writer starts and explains an empty read', () => {
  it('uses the deployed evictor image with Node, not the collector image', () => {
    expect(jsonLine<string>(harness('writer-image'), 'IMAGE')).toBe(
      'loader-with-node@sha256:fixture'
    );
  });

  it.each([
    ['image', 'Pending', 'ImagePullBackOff', 'FailedPull'],
    ['scheduling', 'Pending', 'unknown', 'FailedScheduling'],
    ['admission', 'absent', 'unknown', 'FailedCreate restricted'],
    ['exited', 'Failed', 'StartError', 'node executable missing'],
    ['read', 'Running', 'running', 'Started'],
    ['silent', 'Running', 'running', 'Started'],
  ])('reports %s without claiming an empty writer succeeded', (cause, phase, reason, event) => {
    const run = harness('writer-empty', { case: cause });
    expect(run.status).toBe(1);
    expect(jsonLine<{ ok: boolean }>(run, 'START').ok).toBe(false);
    const output = run.lines.join('\n');
    expect(output).toContain('phase=' + phase);
    expect(output).toContain(reason);
    expect(output).toContain(event);
    expect(output).toContain('logs exit=' + (cause === 'silent' ? '0' : '1'));
    expect(output).toContain('stderr=');
    expect(output).not.toContain('PRIVATE_TOKEN');
    expect(output).not.toContain('PRIVATE_VALUE');
  });

  it('never evaluates buffer saturation if writer startup fails', () => {
    expect(jsonLine<string[]>(harness('writer-gates-buffer'), 'ORDER')).toEqual([
      'buffer',
      'writer-ready',
    ]);
  });

  it('waits for Running and the first numbered line before allowing buffer reads', () => {
    const run = harness('writer-start-order');
    expect(run.status).toBe(0);
    expect(jsonLine<{ ok: boolean; events: string[] }>(run, 'START')).toEqual({
      ok: true,
      events: ['pod', 'logs'],
    });
  });
});

describe('the crash walk stays bounded and restores after failures', () => {
  it('prints RESTORE and a nonzero RESULT after an unexpected stage exception', () => {
    const run = harness('main-runtime-error');
    expect(run.status).toBe(1);
    expect(jsonLine<{ status: number }>(run, 'MAIN').status).toBe(1);
    const output = run.lines.join('\n');
    expect(output).toContain('RESTORE');
    expect(output).toContain('RESULT');
    expect(output).toContain('FAIL');
    expect(output.indexOf('RESTORE')).toBeLessThan(output.indexOf('RESULT'));
  });

  it.each([false, true])(
    'retries kubectl timeouts and runs later cleanup even when exhausted=%s',
    (exhausted) => {
      const run = harness('restore-timeouts', { exhausted });
      const cleanup = jsonLine<{
        calls: string[];
        attempts: Record<string, number>;
        timeouts: number[];
      }>(run, 'CLEANUP');
      expect(cleanup.attempts.scale).toBe(exhausted ? 3 : 2);
      expect(cleanup.attempts['walk-crash-writer']).toBe(exhausted ? 3 : 2);
      for (const step of [
        'store-ready',
        'walk-crash-writer-2',
        'walk-crash-writer-3',
        'namespace',
        'collector-ready',
      ]) {
        expect(cleanup.calls).toContain(step);
      }
      expect(cleanup.calls.indexOf('namespace')).toBeGreaterThan(
        cleanup.calls.lastIndexOf('walk-crash-writer')
      );
      expect(cleanup.timeouts.every((timeout) => timeout > 120)).toBe(true);
      expect(run.status).toBe(exhausted ? 1 : 0);
      expect(run.lines.join('\n')).toContain('RESTORE');
      if (exhausted) expect(run.lines.join('\n')).toContain('incomplete');
    }
  );

  it('interrupts a blocked stage when the background load monitor sees excess load', () => {
    const run = harness('watch-load', { load: 9.0 });
    expect(run.status).toBe(1);
    expect(jsonLine<{ waits: number[]; signals: object[] }>(run, 'WATCH')).toEqual({
      waits: [1],
      signals: [{ own_pid: true, sigint: true }],
    });
    expect(run.lines.join('\n')).toContain('TEST NOT VALID');
  });

  it('ends the load monitor when stopped without interrupting a safe stage', () => {
    const run = harness('watch-load', { load: 1.0 });
    expect(run.status).toBe(0);
    expect(jsonLine<{ waits: number[]; signals: object[] }>(run, 'WATCH')).toEqual({
      waits: [1, 1],
      signals: [],
    });
  });

  it('marks an unreadable load average invalid rather than letting the stage proceed', () => {
    const run = harness('load-unavailable');
    expect(run.status).toBe(1);
    expect(jsonLine<{ ok: boolean }>(run, 'SAFE').ok).toBe(false);
    expect(run.lines.join('\n')).toContain('TEST NOT VALID');
    expect(run.lines.join('\n')).toContain('unavailable');
  });

  it('retries a KeyboardInterrupt during restore and still completes every step', () => {
    const run = harness('restore-timeouts', { interrupt: true });
    const cleanup = jsonLine<{ calls: string[]; attempts: Record<string, number> }>(run, 'CLEANUP');
    expect(run.status).toBe(0);
    expect(cleanup.attempts.scale).toBe(2);
    expect(cleanup.attempts['walk-crash-writer']).toBe(2);
    for (const step of [
      'store-ready',
      'walk-crash-writer-2',
      'walk-crash-writer-3',
      'namespace',
      'collector-ready',
    ]) {
      expect(cleanup.calls).toContain(step);
    }
    expect(run.lines.join('\n')).toContain('RESTORE');
  });

  it('rejects excess node load before creating writers or waiting for a full buffer', () => {
    const run = harness('load-gate', { load: 9.0 });
    expect(run.status).toBe(1);
    expect(jsonLine<string[]>(run, 'LOAD')).toEqual([]);
    expect(run.lines.join('\n')).toContain('TEST NOT VALID');
    expect(run.lines.join('\n').toLowerCase()).toContain('load');
  });
});

describe('the crash writer has a paced aggregate target', () => {
  it('measures emitted totals across sequence bases without retaining every log line', () => {
    expect(jsonLine<number>(harness('emitted-count'), 'EMITTED')).toBe(1701);
  });

  it('splits 1700 lines/s across three pods in timed batches of at most twenty', () => {
    const commands = jsonLine<string[][]>(harness('writer-paced'), 'COMMANDS');
    expect(commands).toHaveLength(3);
    const totals: number[] = [];
    for (const command of commands) {
      expect(command.slice(0, 2)).toEqual(['node', '-e']);
      const script = command[2] ?? '';
      expect(script).not.toContain('setImmediate');
      let now = 0;
      let written = 0;
      let batch = 0;
      const batches: number[] = [];
      const timers: { at: number; callback: () => void }[] = [];
      runInNewContext(
        script,
        {
          process: {
            argv: [command[0], ...command.slice(3)],
            stdout: {
              write: (line: string) => {
                const lines = line.split('\n').length - 1;
                written += lines;
                batch += lines;
                return true;
              },
            },
          },
          Date: { now: () => now },
          setTimeout: (callback: () => void, delay: number) => {
            expect(delay).toBeGreaterThan(0);
            timers.push({ at: now + delay, callback });
          },
        },
        { timeout: 1000 }
      );
      batches.push(batch);
      // Virtual timers prove pacing without a wall-clock or Kubernetes wait.
      for (let turns = 0; timers.length > 0 && turns < 10000; turns += 1) {
        timers.sort((left, right) => left.at - right.at);
        const timer = timers.shift();
        if (!timer || timer.at >= 1000) break;
        now = timer.at;
        batch = 0;
        timer.callback();
        batches.push(batch);
      }
      expect(timers.length).toBeLessThan(10000);
      expect(batches.every((size) => size <= 20)).toBe(true);
      expect(written).toBeGreaterThan(540);
      expect(written).toBeLessThan(600);
      totals.push(written);
    }
    const total = totals.reduce((sum, value) => sum + value, 0);
    expect(total).toBeGreaterThanOrEqual(1650);
    expect(total).toBeLessThanOrEqual(1760);
  });
});

describe('the crash walk holds the store outage against Flux', () => {
  it('suspends the whole chain top down before it scales the store to zero', () => {
    const run = harness('stop-store');
    const value = jsonLine<{
      ok: boolean;
      calls: string[];
      suspended: string[];
      specSuspend: Record<string, boolean | null>;
    }>(run, 'STOP');
    expect(value.ok).toBe(true);
    const patches = value.calls.filter((call) => call.includes('patch kustomization'));
    const scale = value.calls.findIndex((call) => call.includes('scale deployment'));
    expect(patches).toHaveLength(2);
    expect(patches[0]).toContain('kustomization platform ');
    expect(patches[1]).toContain('kustomization platform-logs-store ');
    expect(scale).toBeGreaterThan(value.calls.indexOf(patches[1] ?? ''));
    expect(value.suspended).toEqual(['platform', 'platform-logs-store']);
    expect(value.specSuspend).toEqual({ 'platform-logs-store': true, platform: true });
    expect(run.lines.join('\n')).toContain('spec.suspend=true');
  });

  it('asks kubectl for the Deployment managedFields the diagnostic names', () => {
    const args = jsonLine<string[]>(harness('deployment-args'), 'ARGS');
    expect(args).toContain('--show-managed-fields');
    expect(args).toContain('deployment');
  });

  it('reads the ownership chain upward and refuses a cycle', () => {
    const chain = jsonLine<{ names: string[]; error: string | null }>(
      harness('flux-chain'),
      'CHAIN'
    );
    expect(chain.names).toEqual(['platform-logs-store', 'platform']);
    expect(chain.error).toBeNull();
    const deeper = jsonLine<{ names: string[]; error: string | null }>(
      harness('flux-chain', { chain: ['platform-logs-store', 'platform', 'platform-a'] }),
      'CHAIN'
    );
    expect(deeper.names).toEqual(['platform-logs-store', 'platform', 'platform-a']);
    expect(deeper.error).toBeNull();
    const cycle = jsonLine<{ names: string[]; error: string | null }>(
      harness('flux-chain', { cycle: true }),
      'CHAIN'
    );
    expect(cycle.error).toContain('loops back');
    expect(cycle.error).toContain('platform-logs-store');
    const atLimit = jsonLine<{ names: string[]; error: string | null }>(
      harness('flux-chain', {
        chain: ['level-0', 'level-1', 'level-2', 'level-3', 'level-4', 'level-5'],
      }),
      'CHAIN'
    );
    expect(atLimit.names).toHaveLength(6);
    expect(atLimit.error).toBeNull();
    const tooDeep = jsonLine<{ error: string | null }>(
      harness('flux-chain', {
        chain: ['level-0', 'level-1', 'level-2', 'level-3', 'level-4', 'level-5', 'level-6'],
      }),
      'CHAIN'
    );
    expect(tooDeep.error).toContain('deeper than 6 levels');
  });

  it('refuses a cyclic chain before scaling the store down', () => {
    const run = harness('stop-store', { cycle: true });
    const value = jsonLine<{ ok: boolean; calls: string[] }>(run, 'STOP');
    expect(value.ok).toBe(false);
    expect(value.calls.some((call) => call.includes('scale deployment'))).toBe(false);
    expect(value.calls.some((call) => call.includes('patch kustomization'))).toBe(false);
    expect(run.lines.join('\n')).toContain('loops back');
    expect(run.lines.join('\n')).toContain('TEST NOT VALID');
  });

  it('marks a Kustomization whose hold cleared mid-outage TEST NOT VALID, naming it', () => {
    const run = harness('owner-resumed');
    expect(run.status).toBe(1);
    expect(jsonLine<{ ok: boolean }>(run, 'HOLD').ok).toBe(false);
    const output = run.lines.join('\n');
    expect(output).toContain('TEST NOT VALID the Flux Kustomization flux-system/platform');
    expect(output).toContain('no longer reads spec.suspend=true');
    expect(output).not.toMatch(/^PASS /m);
  });

  it('never scales the store down when the suspension is refused', () => {
    const run = harness('stop-store', { refuseSuspend: true });
    const value = jsonLine<{ ok: boolean; calls: string[] }>(run, 'STOP');
    expect(value.ok).toBe(false);
    expect(value.calls.some((call) => call.includes('scale deployment'))).toBe(false);
    expect(run.lines.join('\n')).toContain('TEST NOT VALID');
  });

  it('reads the owning Kustomization from the Deployment labels, with defaults only otherwise', () => {
    const labels = {
      'kustomize.toolkit.fluxcd.io/name': 'platform-logs-store',
      'kustomize.toolkit.fluxcd.io/namespace': 'flux-system',
    };
    const labelled = jsonLine<{ namespace: string; name: string; source: string }>(
      harness('flux-owner', { labels }),
      'OWNER'
    );
    expect(labelled).toEqual({
      namespace: 'flux-system',
      name: 'platform-logs-store',
      source: "the store Deployment's kustomize.toolkit.fluxcd.io/name label",
    });
    const defaulted = jsonLine<{ namespace: string; name: string; source: string }>(
      harness('flux-owner'),
      'OWNER'
    );
    expect(defaulted.namespace).toBe('flux-system');
    expect(defaulted.name).toBe('platform-logs-store');
    expect(defaulted.source).toContain('defaults');
  });

  it('marks a store restored mid-outage TEST NOT VALID and names who restored it', () => {
    const run = harness('store-restored');
    const value = jsonLine<{ ok: boolean; managers: string[] }>(run, 'DOWN');
    expect(value.ok).toBe(false);
    expect(value.managers).toContain('kustomize-controller');
    const output = run.lines.join('\n');
    expect(output).toContain('TEST NOT VALID the store came back while it had to stay down');
    expect(output).toContain('kustomize-controller');
    expect(output).toContain('outage never lasted');
    expect(output).not.toMatch(/^PASS /m);
    expect(run.status).toBe(1);
  });

  it('derives the saturation clock from the measured rate and line size', () => {
    const run = harness('saturation-plan');
    const value = jsonLine<{
      line: number;
      bound: number;
      neededSeconds: number;
      reachable: boolean;
      note: string;
    }>(run, 'PLAN');
    expect(value.line).toBeGreaterThan(40);
    expect(value.bound).toBeGreaterThan(600);
    expect(value.bound).toBeLessThanOrEqual(2400);
    expect(value.neededSeconds).toBeGreaterThan(600);
    expect(value.note).toContain('201326592');
    expect(value.note).toContain('derives');
    expect(value.note).toContain('ceiling');
  });

  it('keeps the configured clock when it already covers the arithmetic', () => {
    const value = jsonLine<{ bound: number; fromConfigured: boolean }>(
      harness('saturation-plan', { rate: 20000 }),
      'PLAN'
    );
    expect(value.bound).toBe(600);
    expect(value.fromConfigured).toBe(true);
  });
});

describe('RESTORE resumes the suspended Flux Kustomizations', () => {
  it('resumes, verifies and reconciles even after the store step failed', () => {
    const run = harness('restore-resume');
    expect(run.status).toBe(1);
    const value = jsonLine<{
      calls: string[];
      suspend: Record<string, boolean | null>;
      handled: Record<string, boolean>;
    }>(run, 'RESUMED');
    expect(value.suspend).toEqual({ 'platform-logs-store': false });
    expect(value.handled).toEqual({ 'platform-logs-store': true });
    expect(
      value.calls.some(
        (call) =>
          call.includes('annotate kustomization') &&
          call.includes('reconcile.fluxcd.io/requestedAt')
      )
    ).toBe(true);
    const output = run.lines.join('\n');
    expect(output).toContain('FAIL RESTORE store Ready');
    expect(output).toContain('resumed and reconciled');
    expect(output.indexOf('FAIL RESTORE store Ready')).toBeLessThan(
      output.indexOf('resumed and reconciled')
    );
  });

  it('resumes the child before its parent and reconciles both', () => {
    const run = harness('restore-resume', { chain: true });
    expect(run.status).toBe(1);
    const value = jsonLine<{
      calls: string[];
      suspend: Record<string, boolean | null>;
      handled: Record<string, boolean>;
    }>(run, 'RESUMED');
    const patches = value.calls.filter((call) => call.includes('patch kustomization'));
    expect(patches).toHaveLength(2);
    expect(patches[0]).toContain('kustomization platform-logs-store ');
    expect(patches[1]).toContain('kustomization platform ');
    const annotations = value.calls.filter((call) => call.includes('annotate kustomization'));
    expect(annotations).toHaveLength(2);
    expect(value.suspend).toEqual({ 'platform-logs-store': false, platform: false });
    expect(value.handled).toEqual({ 'platform-logs-store': true, platform: true });
  });

  it('reports a partial resume failure as a loud RESTORE FAIL naming the parent', () => {
    const run = harness('restore-resume', { chain: true, resumeRefused: ['platform'] });
    expect(run.status).toBe(1);
    const value = jsonLine<{
      suspend: Record<string, boolean | null>;
      handled: Record<string, boolean>;
    }>(run, 'RESUMED');
    expect(value.suspend).toEqual({ 'platform-logs-store': false, platform: true });
    expect(value.handled).toEqual({ 'platform-logs-store': true, platform: false });
    const output = run.lines.join('\n');
    expect(output).toContain('FAIL RESTORE resume the Flux Kustomization flux-system/platform ');
    expect(output).toContain('FAIL RESTORE the Flux Kustomization flux-system/platform is still suspended');
    expect(output).toContain('resumed and reconciled: flux-system/platform-logs-store');
    expect(output).toContain('NOT RESUMED, resume by hand: flux-system/platform');
  });

  it('reports a resume that fails as a loud RESTORE FAIL', () => {
    const run = harness('restore-resume', { resumeRefused: true });
    expect(run.status).toBe(1);
    const output = run.lines.join('\n');
    expect(output).toContain('FAIL RESTORE resume the Flux Kustomization');
    expect(output).toContain('still suspended');
    expect(output).toContain('NOT RESUMED');
    expect(
      jsonLine<{ suspend: Record<string, boolean | null> }>(run, 'RESUMED').suspend
    ).toEqual({ 'platform-logs-store': true });
  });
});

describe('a fake node for the crash walk', () => {
  it("passes when every line still in the kubelet's files was delivered", () => {
    const run = harness('verdict-pass');
    const value = jsonLine<{ ok: boolean; detail: string }>(run, 'VERDICT');
    expect(value.ok).toBe(true);
    expect(value.detail).toContain('2 duplicated');
  });

  it("fails a line lost while still in the kubelet's files, naming it", () => {
    const run = harness('verdict-lost');
    const value = jsonLine<{ ok: boolean; detail: string }>(run, 'VERDICT');
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("lost while still in the kubelet's files: seq 7..8");
  });

  it('allows a line the kubelet has rotated away', () => {
    const run = harness('verdict-rotated');
    const value = jsonLine<{ ok: boolean; detail: string }>(run, 'VERDICT');
    expect(value.ok).toBe(true);
    expect(value.detail).toContain('3 rotated away');
  });
});
