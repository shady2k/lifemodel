import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let directory = '';
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'egress-sources-'));
});
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});
function run(fixture: object) {
  const path = join(directory, 'fixture.json');
  writeFileSync(path, JSON.stringify(fixture));
  const result = spawnSync(
    'python3',
    ['tests/fixtures/logs-egress-sources-harness.py', 'deploy/platform/logs-egress-walk.py', path],
    { encoding: 'utf8' }
  );
  const line = result.stdout.split('\n').find((value) => value.startsWith('SUMMARY '));
  expect(line, result.stderr).toBeDefined();
  return JSON.parse(line!.slice(8)) as { status: number; calls: unknown[][]; output: string };
}

describe('normal-work evidence sources', () => {
  it('uses PATH tools and preserves baseline, events and final with cleanup', () => {
    const result = run({ path: ['conntrack', 'tcpdump'] });
    expect(result.status).toBe(0);
    expect(result.calls).toContainEqual(['evidence', 'BASELINE\nEVENT\nFINAL', 'PACKET']);
    expect(result.calls).toContainEqual(['stop', 'conntrack']);
    expect(result.calls).toContainEqual(['stop', 'tcpdump']);
    expect(result.output).toContain('conntrack');
  });
  it('uses bounded Nix startup and puts config only in child environment', () => {
    const result = run({ path: ['nix'], nix_config: 'PRIVATE CONFIG' });
    expect(result.status).toBe(0);
    for (const call of result.calls.filter(([kind]) => kind === 'run' || kind === 'start')) {
      const argv = call[1] as string[];
      expect(argv.slice(0, 6)).toEqual([
        'nix',
        '--extra-experimental-features',
        'nix-command flakes',
        'run',
        argv.includes('nixpkgs#tcpdump') ? 'nixpkgs#tcpdump' : 'nixpkgs#conntrack-tools',
        '--',
      ]);
      expect(argv.join(' ')).not.toContain('PRIVATE CONFIG');
      expect(call[2]).toBe('PRIVATE CONFIG');
      if (call[0] === 'run') expect(call[3]).toBeGreaterThan(0);
    }
    expect(result.output).not.toContain('PRIVATE');
    expect(result.output).toContain('conntrack (Nix)');
    expect(result.output).toContain('tcpdump (Nix)');
  });
  it('splits explicit commands as argv, without shell interpolation', () => {
    const result = run({
      conntrack_command: '/tool/ct "two words" ;echo',
      tcpdump_command: '/tool/tcpdump "two words"',
      nix_config: 'PRIVATE CONFIG',
    });
    expect(result.status).toBe(0);
    const start = result.calls.find(([kind]) => kind === 'start');
    expect((start![1] as string[]).slice(0, 3)).toEqual(['/tool/ct', 'two words', ';echo']);
  });
  it.each([
    { path: [] },
    { path: ['conntrack'], command_failed: true },
    { path: ['nix'], run_timeout: true },
    { path: ['conntrack'], conntrack_startup_failed: true },
  ])('polls proc snapshots after unavailable/failed startup: %j', (fixture) => {
    const result = run({ ...fixture, proc: 'SNAPSHOT' });
    expect(result.status).toBe(0);
    expect(result.calls.filter(([kind]) => kind === 'proc').length).toBeGreaterThanOrEqual(3);
    expect(result.output).toContain('/proc/net/nf_conntrack');
    expect(result.output).toMatch(/short.*flow/i);
    expect(result.output).not.toContain('PRIVATE');
  });
  it('invalidates when no connection source exists', () => {
    expect(run({ path: [] }).status).toBe(1);
  });
  it('invalidates when proc evidence becomes unreadable', () => {
    expect(run({ path: [], proc: 'SNAPSHOT', proc_lost: true }).status).toBe(1);
  });
  it.each([
    { path: ['conntrack'] },
    { path: ['conntrack', 'tcpdump'], tcpdump_missing: true },
    { path: ['conntrack', 'tcpdump'], tcpdump_startup_failed: true },
    { path: ['conntrack', 'tcpdump'], capture_no_ready: true },
  ])('allows conntrack-only observation when optional capture cannot start: %j', (fixture) => {
    const result = run(fixture);
    expect(result.status).toBe(0);
    expect(result.output).toMatch(/no packet capture/i);
    expect(result.calls.find(([kind]) => kind === 'evidence')![2]).toBeNull();
  });
  it.each(['tcpdump', 'conntrack'])('never downgrades lost running %s evidence', (tool) => {
    const result = run({
      path: ['conntrack', 'tcpdump'],
      [tool + '_lost']: true,
      proc: 'SNAPSHOT',
    });
    expect(result.status).toBe(1);
    expect(result.calls.some(([kind, name]) => kind === 'wait' && name === 'conntrack')).toBe(true);
    expect(result.calls.some(([kind, name]) => kind === 'wait' && name === 'tcpdump')).toBe(true);
  });
  it.each([{ dropped_packets: 2 }, { event_errors: 'PRIVATE EVENT LOSS' }])(
    'invalidates incomplete evidence without printing raw diagnostics: %j',
    (fixture) => {
      const result = run({ path: ['conntrack', 'tcpdump'], ...fixture });
      expect(result.status).toBe(1);
      expect(result.output).not.toContain('PRIVATE');
    }
  );
  it('checks proc-prefixed tuples through the real destination guard', () => {
    const tuple =
      'ipv4 2 tcp 6 300 ESTABLISHED src=10.42.0.10 dst=10.42.0.20 sport=40100 dport=9428 src=10.42.0.20 dst=10.42.0.10 sport=9428 dport=40100';
    expect(run({ path: [], proc: tuple, check_observation: true }).status).toBe(0);
    expect(run({ path: [], proc: '', check_observation: true }).status).toBe(1);
    expect(
      run({
        path: [],
        proc: tuple.replace('dst=10.42.0.20', 'dst=198.51.100.20'),
        check_observation: true,
      }).status
    ).toBe(1);
  });
  it('exposes command and Nix config options on the real CLI', () => {
    const result = run({
      cli: [
        '--conntrack-command',
        'custom ct',
        '--tcpdump-command',
        'custom dump',
        '--nix-config',
        'PRIVATE CONFIG',
      ],
    });
    expect(result.status).toBe(0);
    const options = result.calls[0]![1] as Record<string, unknown>;
    expect(options.conntrack_command).toBe('custom ct');
    expect(options.tcpdump_command).toBe('custom dump');
    expect(options.nix_config).toBe('PRIVATE CONFIG');
    expect(result.output).not.toContain('PRIVATE CONFIG');
  });
});
