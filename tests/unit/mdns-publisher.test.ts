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
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mdns-publisher-'));
  roots.push(root);
  const bin = join(root, 'bin');
  const state = join(root, 'state');
  mkdirSync(bin);
  writeFileSync(state, '192.0.2.10\n');
  const ip = `#!/bin/bash\nif [[ "$1" == monitor ]]; then while :; do if [[ -f "${root}/event" ]]; then rm -f "${root}/event"; echo address; fi; sleep .05; done; fi\ncat "${state}" | awk '{print "2: eth0 inet " $1 "/24 brd 192.0.2.255 scope global eth0"}'\n`;
  const avahi = `#!/bin/bash\nprintf "%s\n" "$*" >> "${root}/calls"\nif [[ -f "${root}/collision" ]]; then exit 1; fi\ntrap 'exit 0' TERM\nwhile :; do sleep .1; done\n`;
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
    } finally {
      child.kill('SIGTERM');
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
