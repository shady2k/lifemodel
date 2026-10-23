import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const walk = readFileSync(
  fileURLToPath(new URL('../../docs/features/motor/storage-pressure-walk.md', import.meta.url)),
  'utf8'
);
const programs = [...walk.matchAll(/```js\n([\s\S]*?)```/g)].map((match) => match[1]!);
const [caller = '', sampler = '', coordinator = ''] = programs;

// These are the documented executable operations, not prose claims about order.
// Regressing to a sampler stop between phases must invalidate the procedure.
function requireLifecycle(source: string): void {
  const operations = [
    "await rss.barrier('ready')",
    "launch('phase1-task-a'",
    "launch('phase1-task-b'",
    "await Promise.all([a.barrier('barrier', 'overload'), b.barrier('barrier', 'overload')])",
    "launch('phase1-control'",
    "launch('phase1-read'",
    'await accept([a, b, control1, read1])',
    "launch('phase2-stall'",
    "await stall.barrier('barrier', 'partial-body-sent')",
    "launch('phase2-put'",
    "launch('phase2-control'",
    "launch('phase2-read'",
    'await accept([stall, put, control2, read2])',
    'await Promise.all(jobs.filter(job => job !== rss).map(job => job.done))',
    "rss.child.stdin.write('stop\\n')",
    'const result = await rss.done',
  ];
  let previous = -1;
  for (const operation of operations) {
    const position = source.indexOf(operation);
    if (position < 0 || position <= previous) throw Error(`walk_lifecycle: ${operation}`);
    previous = position;
  }
}

describe('WALK-STORAGE-LOAD executable evidence (lifemodel-653.7.7)', () => {
  it('keeps sampling from observed ready through all callers in both phases', () => {
    expect(programs).toHaveLength(3);
    requireLifecycle(coordinator);
    expect(sampler).toContain("input.includes('stop\\n')");
    expect(sampler).toContain('stop = true; process.exitCode = 7;');
    expect(sampler).toContain('stop = true; process.exitCode = 6;');
    expect(sampler).toContain("event: samples === 1 ? 'ready' : 'sample'");
    expect(sampler).toContain('if (stop) break;');
    expect(sampler).not.toContain('process.exit(samples?0:5)');
    expect(coordinator).toContain('summary.maxKiB > 524288');
  });

  it('rejects the old early-stop lifecycle rather than only checking sampler words', () => {
    const stop = "rss.child.stdin.write('stop\\n');";
    const earlyStop = coordinator
      .replace(stop, '')
      .replace(
        "  const stall = launch('phase2-stall'",
        `${stop}\n  const stall = launch('phase2-stall'`
      );
    expect(earlyStop).not.toBe(coordinator);
    expect(() => requireLifecycle(earlyStop)).toThrow('walk_lifecycle');
  });

  it('records every command own status and ISO caller/request intervals', () => {
    expect(coordinator).toContain("child.on('close', async (code, signal)");
    expect(coordinator).toContain('exitCode: spawnFailed ? 127 : code, signal, timedOut');
    expect(coordinator).toContain('`${name}.status.json`');
    expect(coordinator).toContain("child.kill('SIGKILL')");
    expect(coordinator).toContain("name === 'rss' ? 150000 : 75000");
    expect(coordinator).toContain('result.artifactFailure = true');
    expect(coordinator).toContain('result.exitCode !== 0 || result.signal');
    expect(caller).toContain("event: 'caller-start', startedAt");
    expect(caller).toContain("event: 'caller-end', startedAt, endedAt: new Date().toISOString()");
    expect(caller).toContain("event: 'request-end', number, startedAt: requestStartedAt");
    expect(caller).toContain('endedAt: new Date().toISOString(), ms: performance.now() - start');
    expect(walk).toContain('WALK_STATUS=$?');
  });

  it('checks PID 1 cmdline, not the Node 24 thread name, and requires task DNS', () => {
    expect(sampler).toContain("readFile('/proc/1/cmdline', 'utf8')");
    expect(sampler).toContain("split('\\0')");
    expect(sampler).toContain("argv[1] !== '/opt/lifemodel/loader/dist/storage-module.js'");
    expect(sampler).not.toContain('/proc/1/comm');
    expect(walk).toContain('Task-pod egress **must include DNS**');
    expect(walk).toMatch(/not\*\*\s+proof of module admission/);
  });
});
