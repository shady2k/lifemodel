import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const generator = resolve('deploy/k3s/resolv-conf.mjs');
const generateScript = resolve('deploy/k3s/k3s-resolv.sh');
const applyScript = resolve('deploy/k3s/k3s-dns-apply.sh');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'k3s-dns-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const source = join(root, 'source');
  const target = join(root, 'k3s-resolv.conf');
  const marker = join(root, 'k3s-resolv.applied');
  const calls = join(root, 'calls');
  const state = join(root, 'state');
  const pod = join(root, 'pod');
  writeFileSync(source, 'nameserver 192.168.0.30\n');
  writeFileSync(pod, 'nameserver 192.168.0.30\nsearch kube-system.svc.cluster.local\n');
  writeFileSync(state, 'active');
  writeFileSync(calls, '');
  function fake(name: string, body: string) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }
  fake(
    'systemctl',
    `printf 'systemctl %s\n' "$*" >> "$CALLS"
# Model systemd's job queue: start while activating coalesces, whereas
# restart cancels that activation and queues a replacement invocation.
if [ "$(cat "$STATE")" = apply-activating ]; then
  [ "$1" != restart ] || echo replacement-queued > "$STATE"
fi
exit 0`
  );
  fake('sleep', 'exit 0');
  fake(
    'k3s',
    `printf 'k3s %s\n' "$*" >> "$CALLS"
case "$*" in
  *'get --raw=/readyz'*)
    case "$(cat "$STATE")" in
      activating) echo active > "$STATE"; exit 1 ;;
      unavailable) exit 1 ;;
    esac ;;
  *'rollout restart'*)
    if [ -f "$FAIL_ONCE" ]; then rm "$FAIL_ONCE"; exit 1; fi ;;
  *'exec deploy/coredns -- cat /etc/resolv.conf'*)
    if [ "$(cat "$STATE")" = no-cat ]; then echo 'exec: cat: executable file not found' >&2; exit 127; fi
    cat "$POD" ;;
esac
exit 0`
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CALLS: calls,
    STATE: state,
    POD: pod,
    FAIL_ONCE: join(root, 'fail-once'),
  };
  function run(script: string, args: string[]) {
    const before = readFileSync(calls, 'utf8').length;
    const result = spawnSync('sh', [script, ...args], { env, encoding: 'utf8', timeout: 10_000 });
    return { ...result, calls: readFileSync(calls, 'utf8').slice(before) };
  }
  return {
    root,
    source,
    target,
    marker,
    calls,
    state,
    pod,
    env,
    generate: () => run(generateScript, [generator, target, source]),
    apply: () => run(applyScript, [target]),
    hash: () => createHash('sha256').update(readFileSync(target)).digest('hex'),
  };
}
describe('bounded generation and durable CoreDNS reconciliation', () => {
  it('generates locally without probing the network and queues pending apply even if unchanged', () => {
    const host = fixture();
    writeFileSync(host.state, 'unavailable');
    const first = host.generate();
    expect(first.status, first.stderr).toBe(0);
    expect(first.calls).toBe('systemctl restart --no-block lifemodel-k3s-dns-apply.service\n');
    const second = host.generate();
    expect(second.status, second.stderr).toBe(0);
    expect(second.calls).toBe(first.calls);
    expect(existsSync(host.marker)).toBe(false);
  });

  it('retries failed apply with unchanged desired bytes, then leaves applied pods alone', () => {
    const host = fixture();
    host.generate();
    writeFileSync(host.env.FAIL_ONCE, '');
    expect(host.apply().status).not.toBe(0);
    expect(existsSync(host.marker)).toBe(false);
    expect(host.generate().calls).toContain('restart --no-block lifemodel-k3s-dns-apply.service');
    const retry = host.apply();
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.calls).toContain('--request-timeout=10s');
    expect(retry.calls).toContain('rollout restart deploy/coredns -n kube-system');
    expect(retry.calls).toContain('rollout status deploy/coredns -n kube-system --timeout=90s');
    expect(retry.calls).toContain('exec deploy/coredns -- cat /etc/resolv.conf');
    expect(readFileSync(host.marker, 'utf8')).toBe(`${host.hash()}\n`);
    expect(host.generate().calls).toBe('');
    expect(host.apply().calls).not.toContain('rollout restart');
  });

  it('converges when k3s changes from activating to active with surviving pods', () => {
    const host = fixture();
    host.generate();
    writeFileSync(host.state, 'activating');
    const result = host.apply();
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.match(/get --raw=\/readyz/g)).toHaveLength(2);
    expect(readFileSync(host.marker, 'utf8')).toBe(`${host.hash()}\n`);
  });

  it('does not mark a rollout applied when the surviving pod has different nameservers', () => {
    const host = fixture();
    host.generate();
    writeFileSync(host.pod, 'nameserver 8.8.8.8\n');
    const mismatch = host.apply();
    expect(mismatch.status).not.toBe(0);
    expect(existsSync(host.marker)).toBe(false);
    expect(host.generate().calls).toContain('restart --no-block');
    writeFileSync(host.pod, 'nameserver 192.168.0.30\n');
    expect(host.apply().status).toBe(0);
    expect(readFileSync(host.marker, 'utf8')).toBe(`${host.hash()}\n`);
  });

  it('queues a replacement job rather than coalescing with an activating apply', () => {
    const host = fixture();
    host.generate();
    expect(host.apply().status).toBe(0);
    // A has passed verification but its start job has not yet finished. B is
    // published now. systemd start would coalesce; restart replaces that job.
    writeFileSync(host.state, 'apply-activating');
    writeFileSync(host.source, 'nameserver 10.0.0.53\n');
    const generated = host.generate();
    expect(generated.status, generated.stderr).toBe(0);
    expect(generated.calls).toBe('systemctl restart --no-block lifemodel-k3s-dns-apply.service\n');
    expect(readFileSync(host.state, 'utf8').trim()).toBe('replacement-queued');
    writeFileSync(host.pod, 'nameserver 10.0.0.53\n');
    expect(host.apply().status).toBe(0);
    expect(readFileSync(host.marker, 'utf8')).toBe(`${host.hash()}\n`);
  });

  it('keeps the update pending if the CoreDNS image cannot execute cat', () => {
    const host = fixture();
    host.generate();
    writeFileSync(host.state, 'no-cat');
    const result = host.apply();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('executable file not found');
    expect(existsSync(host.marker)).toBe(false);
  });

  it('bounds API unavailability and keeps the desired update pending', () => {
    const host = fixture();
    host.generate();
    writeFileSync(host.state, 'unavailable');
    const result = host.apply();
    expect(result.status).not.toBe(0);
    const probes = result.calls.split('\n').filter((line) => line.includes('get --raw=/readyz'));
    expect(probes.length).toBeGreaterThan(1);
    expect(probes.length).toBeLessThanOrEqual(11);
    expect(probes.every((line) => line.includes('--request-timeout=10s'))).toBe(true);
    expect(existsSync(host.marker)).toBe(false);
  });

  it('fails closed on failed generation or a missing/empty output', () => {
    const host = fixture();
    const emptyGenerator = join(host.root, 'empty.mjs');
    writeFileSync(emptyGenerator, "console.log('unchanged');");
    const run = () =>
      spawnSync('sh', [generateScript, emptyGenerator, host.target, host.source], {
        encoding: 'utf8',
        env: host.env,
      });
    expect(run().status).not.toBe(0);
    writeFileSync(host.target, '');
    expect(run().status).not.toBe(0);
    writeFileSync(emptyGenerator, 'process.exit(1);');
    expect(run().status).not.toBe(0);
  });
});
