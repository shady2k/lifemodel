import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const script = resolve(process.cwd(), 'deploy/mdns/publish-name');
function fixture(options: { address?: string; absentInterface?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mdns-publisher-'));
  roots.push(root);
  const bin = join(root, 'bin');
  const state = join(root, 'state');
  mkdirSync(bin);
  writeFileSync(state, options.address ?? '192.0.2.10\n');
  const ip = `#!/bin/bash\nif [[ "$1" == link ]]; then [[ ! -f "${root}/gone" ]]; exit; fi
if [[ "$1" == monitor ]]; then echo "$$" > "${root}/monitor.pid"; while :; do if [[ -f "${root}/event" ]]; then rm -f "${root}/event"; echo address; fi; sleep .05; done; fi\ncat "${state}" | awk '{print "2: eth0 inet " $1 "/24 brd 192.0.2.255 scope global eth0"}'\n`;
  const avahi = `#!/bin/bash\nprintf "START %s\n" "$*" >> "${root}/calls"; printf "PID %s\n" "$$" >> "${root}/calls"\nif [[ -f "${root}/collision" ]]; then exit 1; fi\ntrap 'echo STOP >> '${root}/calls'; exit 0' TERM\nwhile :; do sleep .1; done\n`;
  writeFileSync(join(bin, 'ip'), ip);
  writeFileSync(join(bin, 'avahi-publish-address'), avahi);
  chmodSync(join(bin, 'ip'), 0o755);
  chmodSync(join(bin, 'avahi-publish-address'), 0o755);
  return { root, state, bin };
}
function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const poll = () =>
      predicate()
        ? resolve()
        : Date.now() - start > timeoutMs
          ? reject(new Error('timed out waiting for publisher'))
          : setTimeout(poll, 20);
    poll();
  });
}
function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
async function expectGone(pid: number) {
  await waitFor(() => processGone(pid), 2500);
}
function start(f: ReturnType<typeof fixture>): ChildProcess {
  return spawn('bash', [script, 'lifemodel.local', 'eth0'], {
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}
describe('mDNS publisher', () => {
  it('withdraws the prior address and publishes the new address after a netlink event', async () => {
    const f = fixture();
    const child = start(f);
    try {
      await waitFor(() => existsSync(join(f.root, 'calls')));
      expect(readFileSync(join(f.root, 'calls'), 'utf8')).toContain('lifemodel.local 192.0.2.10');
      writeFileSync(f.state, '192.0.2.11\n');
      writeFileSync(join(f.root, 'event'), 'change');
      await waitFor(() => readFileSync(join(f.root, 'calls'), 'utf8').includes('192.0.2.11'));
      expect(readFileSync(join(f.root, 'calls'), 'utf8')).toContain('lifemodel.local 192.0.2.11');
      const calls = readFileSync(join(f.root, 'calls'), 'utf8');
      expect(calls).toContain('192.0.2.10');
      expect(calls).toContain('192.0.2.11');
      expect(calls.indexOf('STOP')).toBeGreaterThan(-1);
      expect(calls.indexOf('STOP')).toBeLessThan(calls.indexOf('192.0.2.11'));
      expect(child.pid).toBeDefined();
      const monitorPid = Number(readFileSync(join(f.root, 'monitor.pid'), 'utf8'));
      const publisherPids = [
        ...readFileSync(join(f.root, 'calls'), 'utf8').matchAll(/PID (\d+)/g),
      ].map((match) => Number(match[1]));
      child.kill('SIGTERM');
      const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
      expect(code).toBe(0);
      expect(child.exitCode).toBe(0);
      await expectGone(monitorPid);
      for (const publisherPid of publisherPids) await expectGone(publisherPid);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      }
    }
  }, 5000);
  it.each([
    ['address present', '192.0.2.10\n'],
    ['address absent', ''],
  ])(
    'reaps monitor and publisher after SIGTERM with %s',
    async (_label, address) => {
      const f = fixture({ address });
      const child = start(f);
      try {
        await waitFor(() => existsSync(join(f.root, 'monitor.pid')));
        const monitorPid = Number(readFileSync(join(f.root, 'monitor.pid'), 'utf8'));
        if (address) await waitFor(() => existsSync(join(f.root, 'calls')));
        const publisherPids = address
          ? [...readFileSync(join(f.root, 'calls'), 'utf8').matchAll(/PID (\d+)/g)].map((match) =>
              Number(match[1])
            )
          : [];
        child.kill('SIGTERM');
        const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
        expect(code).toBe(0);
        await expectGone(monitorPid);
        for (const publisherPid of publisherPids) await expectGone(publisherPid);
      } finally {
        if (child.exitCode === null) {
          child.kill('SIGTERM');
          await new Promise<void>((resolve) => child.once('exit', () => resolve()));
        }
      }
    },
    5000
  );

  it('reaps the monitor and publisher when the interface disappears', async () => {
    const f = fixture();
    const child = start(f);
    try {
      await waitFor(
        () => existsSync(join(f.root, 'calls')) && existsSync(join(f.root, 'monitor.pid'))
      );
      const monitorPid = Number(readFileSync(join(f.root, 'monitor.pid'), 'utf8'));
      const publisherPids = [
        ...readFileSync(join(f.root, 'calls'), 'utf8').matchAll(/PID (\d+)/g),
      ].map((match) => Number(match[1]));
      writeFileSync(join(f.root, 'gone'), 'yes');
      writeFileSync(join(f.root, 'event'), 'change');
      const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
      expect(code).toBe(1);
      await expectGone(monitorPid);
      for (const publisherPid of publisherPids) await expectGone(publisherPid);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      }
    }
  }, 5000);

  it('exits visibly when avahi-publish-address reports a collision', async () => {
    const f = fixture();
    writeFileSync(join(f.root, 'collision'), 'yes');
    const child = start(f);
    let stderr = '';
    child.stderr?.on('data', (data) => {
      stderr += data;
    });
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).not.toBe(0);
    expect(stderr).toContain('possible name collision');
  }, 5000);
});
