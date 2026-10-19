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
  const goodPod = {
    metadata: { creationTimestamp: '2999-01-01T00:00:00Z', labels: { 'k8s-app': 'kube-dns' } },
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
  };
  const setPods = (items = [goodPod]) => writeFileSync(pod, JSON.stringify({ items }));
  setPods();
  const deployment = join(root, 'deployment');
  writeFileSync(
    deployment,
    JSON.stringify({ metadata: { generation: 2 }, status: { observedGeneration: 2 } })
  );
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
  *'get pods -l k8s-app=kube-dns -o json'*) cat "$POD" ;;
  *'get deploy/coredns -o json'*) cat "$DEPLOYMENT" ;;
esac
exit 0`
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CALLS: calls,
    STATE: state,
    POD: pod,
    DEPLOYMENT: deployment,
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
    deployment,
    goodPod,
    setPods,
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

  it('records the desired hash and write time atomically and preserves it on unchanged generation', () => {
    const host = fixture();
    const before = Date.now();
    expect(host.generate().status).toBe(0);
    const sidecar = join(host.root, 'k3s-resolv.written');
    const first = readFileSync(sidecar, 'utf8');
    const record = JSON.parse(first);
    expect(record.sha256).toBe(host.hash());
    expect(record.writtenAt).toBeGreaterThanOrEqual(before);
    expect(record.writtenAt).toBeLessThanOrEqual(Date.now());
    host.generate();
    expect(readFileSync(sidecar, 'utf8')).toBe(first);
    // Crash between file and sidecar publication fails closed until generation
    // repairs the record; stale metadata never verifies different bytes.
    writeFileSync(sidecar, JSON.stringify({ ...record, sha256: 'stale' }));
    expect(host.apply().status).not.toBe(0);
    expect(existsSync(host.marker)).toBe(false);
    host.generate();
    expect(JSON.parse(readFileSync(sidecar, 'utf8')).sha256).toBe(host.hash());
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
    expect(retry.calls).toContain('get pods -l k8s-app=kube-dns -o json');
    expect(retry.calls).toContain('get deploy/coredns -o json');
    expect(retry.calls).not.toContain(' exec ');
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

  it('leaves the marker unwritten if even one CoreDNS pod predates the resolver write', () => {
    const host = fixture();
    host.generate();
    host.setPods([
      host.goodPod,
      {
        ...host.goodPod,
        metadata: { ...host.goodPod.metadata, creationTimestamp: '2000-01-01T00:00:00Z' },
      },
    ]);
    expect(host.apply().status).not.toBe(0);
    expect(existsSync(host.marker)).toBe(false);
    expect(host.generate().calls).toContain('restart --no-block');
    host.setPods([host.goodPod, host.goodPod]);
    expect(host.apply().status).toBe(0);
    expect(readFileSync(host.marker, 'utf8')).toBe(`${host.hash()}\n`);
  });

  it('does not reuse an old A proof after interrupted B and republished A', () => {
    const host = fixture();
    host.generate();
    expect(host.apply().status).toBe(0);
    // Simulate pods created from B before its interrupted apply wrote a marker.
    writeFileSync(host.source, 'nameserver 10.0.0.53\n');
    host.generate();
    host.setPods([
      {
        ...host.goodPod,
        metadata: { ...host.goodPod.metadata, creationTimestamp: '2000-01-01T00:00:00Z' },
      },
    ]);
    writeFileSync(host.source, 'nameserver 192.168.0.30\n');
    host.generate();
    expect(host.generate().calls).toContain('restart --no-block');
    const interrupted = host.apply();
    expect(interrupted.calls).toContain('rollout restart');
    expect(interrupted.status).not.toBe(0);
    host.setPods();
    const retry = host.apply();
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.calls).toContain('rollout restart');
  });

  it('requires every CoreDNS pod to be Running and Ready, not just one', () => {
    const host = fixture();
    host.generate();
    for (const status of [
      { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }] },
      { phase: 'Pending', conditions: [{ type: 'Ready', status: 'True' }] },
      { phase: 'Running', conditions: [] },
    ]) {
      host.setPods([host.goodPod, { ...host.goodPod, status }]);
      expect(host.apply().status).not.toBe(0);
      expect(existsSync(host.marker)).toBe(false);
    }
  });

  it('rejects missing pods and an unobserved deployment generation', () => {
    const host = fixture();
    host.generate();
    host.setPods([]);
    expect(host.apply().status).not.toBe(0);
    expect(existsSync(host.marker)).toBe(false);
    host.setPods();
    writeFileSync(
      host.deployment,
      JSON.stringify({ metadata: { generation: 3 }, status: { observedGeneration: 2 } })
    );
    expect(host.apply().status).not.toBe(0);
    expect(existsSync(host.marker)).toBe(false);
  });

  it('requires creation strictly after the recorded write time', () => {
    const host = fixture();
    host.generate();
    const written = JSON.parse(readFileSync(join(host.root, 'k3s-resolv.written'), 'utf8'));
    host.setPods([
      {
        ...host.goodPod,
        metadata: {
          ...host.goodPod.metadata,
          creationTimestamp: new Date(written.writtenAt).toISOString(),
        },
      },
    ]);
    expect(host.apply().status).not.toBe(0);
    expect(existsSync(host.marker)).toBe(false);
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
    host.setPods();
    expect(host.apply().status).toBe(0);
    expect(readFileSync(host.marker, 'utf8')).toBe(`${host.hash()}\n`);
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
