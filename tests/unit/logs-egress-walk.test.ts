/** WALK-LOGS-EGRESS (ADR-016 L10): a refusal proves policy only after an
 * unrestricted witness reaches that destination. Observation checks original
 * conntrack tuples, never the store's reply tuple as a new outbound flow.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const WALK = join('deploy', 'platform', 'logs-egress-walk.py');
const HARNESS = join('tests', 'fixtures', 'logs-egress-walk-harness.py');

interface Target {
  name: string;
  host: string;
  port: number;
  protocol: string;
  open: boolean;
}

const TARGETS: Target[] = [
  { name: 'store', host: '10.42.0.20', port: 9428, protocol: 'tcp', open: true },
  { name: 'dns', host: '10.43.0.10', port: 53, protocol: 'udp', open: true },
  { name: 'api-service', host: '10.43.0.1', port: 443, protocol: 'tcp', open: true },
  { name: 'node-api', host: '192.0.2.10', port: 6443, protocol: 'tcp', open: true },
  { name: 'other-api', host: '10.42.1.30', port: 6443, protocol: 'tcp', open: true },
  { name: 'other-http', host: '10.42.1.30', port: 8080, protocol: 'tcp', open: false },
  { name: 'other-https', host: '10.42.1.30', port: 443, protocol: 'tcp', open: false },
  { name: 'public-dns', host: '1.1.1.1', port: 53, protocol: 'udp', open: false },
  { name: 'public-dns-tcp', host: '1.1.1.1', port: 53, protocol: 'tcp', open: false },
  { name: 'public-https', host: '198.51.100.20', port: 443, protocol: 'tcp', open: false },
];

interface Summary {
  failures: number;
  invalid: number;
  calls: [string, unknown][];
  passes: string[];
}

let directory = '';

function harness(mode: string, fixture: object): { status: number | null; value: Summary } {
  const path = join(directory, 'fixture.json');
  writeFileSync(path, JSON.stringify(fixture));
  const result = spawnSync('python3', [HARNESS, mode, WALK, path], { encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  const summary = result.stdout.split('\n').find((line) => line.startsWith('SUMMARY '));
  expect(summary, result.stderr).toBeDefined();
  return { status: result.status, value: JSON.parse((summary ?? '').slice(8)) as Summary };
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'logs-egress-walk-'));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('the collector egress matrix', () => {
  it.each([false, true])('checks every L10 destination, with TCP DNS = %s', (tcpDns) => {
    const targets = tcpDns
      ? [...TARGETS, { ...TARGETS[1]!, name: 'dns-tcp', protocol: 'tcp' }]
      : TARGETS;
    const run = harness('matrix', { targets });
    expect(run.status).toBe(0);
    expect(run.value.failures).toBe(0);
    expect(run.value.invalid).toBe(0);
    expect(run.value.passes).toHaveLength(targets.length);
    for (const target of targets) {
      expect(run.value.calls).toContainEqual(['probe', target.name]);
      if (!target.open) {
        const witness = run.value.calls.findIndex(
          ([role, name]) => role === 'witness' && name === target.name
        );
        const collector = run.value.calls.findIndex(
          ([role, name]) => role === 'probe' && name === target.name
        );
        expect(witness).toBeGreaterThanOrEqual(0);
        expect(witness).toBeLessThan(collector);
      }
    }
  });

  it.each(TARGETS.filter((target) => target.open))('fails closed allowed path $name', (target) => {
    const run = harness('matrix', {
      targets: TARGETS,
      answers: { ['probe:' + target.name]: false },
    });
    expect(run.status).toBe(1);
    expect(run.value.failures).toBe(1);
    expect(run.value.passes).toHaveLength(TARGETS.length - 1);
  });

  it.each(TARGETS.filter((target) => !target.open))('fails open forbidden path $name', (target) => {
    const run = harness('matrix', {
      targets: TARGETS,
      answers: { ['probe:' + target.name]: true },
    });
    expect(run.status).toBe(1);
    expect(run.value.failures).toBe(1);
    expect(run.value.invalid).toBe(0);
    expect(run.value.passes).toHaveLength(TARGETS.length - 1);
  });

  it.each([false, null])('cannot pass a refusal when its witness returns %s', (answer) => {
    const target = TARGETS.find((entry) => !entry.open)!;
    const run = harness('matrix', {
      targets: [target],
      answers: { ['witness:' + target.name]: answer },
    });
    expect(run.status).toBe(1);
    expect(run.value.invalid).toBe(1);
    expect(run.value.passes).toEqual([]);
  });
});

const COLLECTOR = '10.42.0.10';
const STORE = '10.42.0.20';
const DNS = '10.43.0.10';
const TCP = `tcp 6 431999 ESTABLISHED src=${COLLECTOR} dst=${STORE} sport=40100 dport=9428 src=${STORE} dst=${COLLECTOR} sport=9428 dport=40100 [ASSURED] mark=0 use=1`;
const UDP = `[NEW] udp 17 30 src=${COLLECTOR} dst=${DNS} sport=40101 dport=53 [UNREPLIED] src=${DNS} dst=${COLLECTOR} sport=53 dport=40101`;

function observation(text: string) {
  return harness('observation', {
    text,
    collector_ips: [COLLECTOR],
    store_ips: [STORE],
    permitted: [
      ['tcp', STORE, 9428],
      ['udp', DNS, 53],
    ],
  });
}

describe('observed egress uses only original conntrack tuples', () => {
  it('accepts permitted TCP and UDP traffic and ignores the store reply tuple', () => {
    const run = observation(TCP + '\n' + UDP + '\n');
    expect(run.status).toBe(0);
    expect(run.value.failures).toBe(0);
    expect(run.value.invalid).toBe(0);
  });

  it.each([
    `tcp 6 120 SYN_SENT src=${COLLECTOR} dst=198.51.100.20 sport=40102 dport=443 [UNREPLIED] src=198.51.100.20 dst=${COLLECTOR} sport=443 dport=40102`,
    `udp 17 30 src=${COLLECTOR} dst=${DNS} sport=40103 dport=443 [UNREPLIED] src=${DNS} dst=${COLLECTOR} sport=443 dport=40103`,
    `tcp 6 120 SYN_SENT src=${COLLECTOR} dst=${DNS} sport=40104 dport=53 [UNREPLIED] src=${DNS} dst=${COLLECTOR} sport=53 dport=40104`,
  ])('fails unexpected collector destination, port or protocol', (line) => {
    const run = observation(TCP + '\n' + line);
    expect(run.status).toBe(1);
    expect(run.value.failures).toBeGreaterThan(0);
  });

  it('fails a store-originated connection even to a collector-permitted destination', () => {
    const line = `udp 17 30 src=${STORE} dst=${DNS} sport=40105 dport=53 [UNREPLIED] src=${DNS} dst=${STORE} sport=53 dport=40105`;
    const run = observation(TCP + '\n' + line);
    expect(run.status).toBe(1);
    expect(run.value.failures).toBeGreaterThan(0);
  });

  it.each([
    'garbage',
    'tcp 6 src=10.42.0.10 dst=10.42.0.20',
    'icmp 1 30 src=10.42.0.10 dst=10.42.0.20 type=8 code=0',
  ])('invalidates unparsed evidence: %s', (line) => {
    const run = observation(TCP + '\n' + line);
    expect(run.status).toBe(1);
    expect(run.value.invalid).toBeGreaterThan(0);
  });
  it.each([
    '',
    '\n  \n',
    `udp 17 30 src=10.42.2.50 dst=${DNS} sport=40106 dport=53 [UNREPLIED] src=${DNS} dst=10.42.2.50 sport=53 dport=40106`,
  ])('invalidates a window with no collector connections', (text) => {
    const run = observation(text);
    expect(run.status).toBe(1);
    expect(run.value.invalid).toBeGreaterThan(0);
  });
});

describe('the deployed walk fixture lifecycle', () => {
  it('settles policy before probing and removes synthetic sources before observation', () => {
    const run = harness('lifecycle', {});
    expect(run.status).toBe(0);
    const steps = run.value.calls.map(([step]) => step);
    expect(steps.indexOf('settle')).toBeLessThan(steps.indexOf('matrix'));
    expect(run.value.calls[steps.indexOf('settle')]).toEqual(['settle', 5]);
    const deletes = steps.flatMap((step, index) => (step === 'delete' ? [index] : []));
    expect(deletes).toHaveLength(2);
    expect(deletes.every((index) => index > steps.indexOf('matrix'))).toBe(true);
    expect(deletes.every((index) => index < steps.indexOf('observe'))).toBe(true);
    const matrix = run.value.calls.find(([step]) => step === 'matrix')![1] as Target[];
    expect(matrix).toHaveLength(11);
  });

  it('uses the collector labels and node without granting mounts or a token', () => {
    const run = harness('lifecycle', {});
    interface Manifest {
      kind: string;
      metadata: {
        name: string;
        labels: Record<string, string>;
        ownerReferences?: { name: string; uid: string; controller: boolean }[];
      };
      spec?: { nodeName?: string; automountServiceAccountToken: boolean; volumes?: unknown[] };
    }
    const manifests = run.value.calls
      .filter(([step]) => step === 'apply')
      .map(([, value]) => value as Manifest);
    const pods = manifests.filter((manifest) => manifest.kind === 'Pod');
    expect(pods).toHaveLength(3);
    for (const pod of pods) {
      expect(pod.spec?.automountServiceAccountToken).toBe(false);
      expect(pod.spec?.volumes ?? []).toEqual([]);
    }
    const probe = pods.find((pod) => pod.metadata.name.startsWith('walk-egress-'))!;
    expect(probe.metadata.labels).toEqual({
      'app.kubernetes.io/name': 'logs-collector',
      fixture: 'same-policy',
    });
    expect(probe.spec?.nodeName).toBe('fixture-node');
    expect(probe.metadata.ownerReferences).toEqual([
      expect.objectContaining({ name: 'collector', uid: 'collector-uid', controller: true }),
    ]);
  });

  it.each(['namespace', 'witness', 'listener', 'probe', 'start'])(
    'cleans up resources even when %s creation or startup throws',
    (exception) => {
      const run = harness('lifecycle', { exception });
      expect(run.status).toBe(1);
      const deletes = run.value.calls
        .filter(([step]) => step === 'delete')
        .map(([, value]) => value as string[]);
      expect(deletes.some((args) => args.includes('namespace'))).toBe(true);
      if (exception === 'probe' || exception === 'start') {
        expect(deletes.some((args) => args.includes('pod'))).toBe(true);
      }
      expect(run.value.calls.some(([step]) => step === 'observe')).toBe(false);
    }
  );
});

function packets(text: string, connections = TCP) {
  return harness('packets', {
    packets: text,
    connections,
    collector_ips: [COLLECTOR],
    store_ips: [STORE],
  });
}

const FORWARD = `12:00:00.000001 IP ${COLLECTOR}.40100 > ${STORE}.9428: tcp 10`;
const REPLY = `12:00:00.000002 IP ${STORE}.9428 > ${COLLECTOR}.40100: tcp 10`;

describe('packet direction is attributed through conntrack tuples', () => {
  it('accepts collector traffic and a store REPLY without treating it as initiation', () => {
    const run = packets(FORWARD + '\n' + REPLY);
    expect(run.status).toBe(0);
    expect(run.value.invalid).toBe(0);
  });

  it('fails an attributed store-initiated external connection', () => {
    const connection = `tcp 6 120 ESTABLISHED src=${STORE} dst=198.51.100.20 sport=41000 dport=443 src=198.51.100.20 dst=${STORE} sport=443 dport=41000`;
    const packet = `12:00:00.000003 IP ${STORE}.41000 > 198.51.100.20.443: tcp 10`;
    const run = packets(FORWARD + '\n' + packet, TCP + '\n' + connection);
    expect(run.status).toBe(1);
    expect(run.value.invalid).toBe(0);
    expect(run.value.failures).toBeGreaterThan(0);
  });

  it.each(['unparseable packet', ''])(
    'invalidates malformed evidence or a silent window',
    (text) => {
      const run = packets(text);
      expect(run.status).toBe(1);
      expect(run.value.invalid).toBeGreaterThan(0);
    }
  );
});
