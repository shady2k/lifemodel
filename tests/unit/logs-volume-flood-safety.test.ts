/** Safety regressions for WALK-LOGS-VOLUME-FLOOD. No live cluster is used. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WALK = join('deploy', 'platform', 'logs-volume-flood-walk.py');
const HARNESS = join('tests', 'fixtures', 'logs-volume-flood-safety-harness.py');

interface Event {
  kind: string;
  name: string;
  detail?: string;
}
interface Outcome {
  events: Event[];
  namespace?: string;
  created?: boolean;
}

function harness<T = Outcome>(mode: string, input: unknown = {}): T {
  const run = spawnSync('python3', [HARNESS, mode, WALK], {
    encoding: 'utf8',
    input: JSON.stringify(input),
  });
  expect(run.error).toBeUndefined();
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout.trim()) as T;
}

const commit = (end: number, result = 'ok') => ({
  start: end * 1e9 - 1e6,
  end: end * 1e9,
  result,
});
function commits(values: ReturnType<typeof commit>[], end = 30): Outcome {
  return harness('commits', { commits: values, start: 0, end: end * 1e9, bound: 10 });
}
const kinds = (outcome: Outcome) => outcome.events.map((event) => event.kind);
const drop = {
  module: 'logs-evictor',
  time: '2026-11-10T00:00:01Z',
  message: JSON.stringify({
    msg: 'the oldest log day was removed',
    day: '20261109',
    freedBytes: 4096,
    reason: 'below_threshold',
  }),
};

describe('Postgres commits cover the full flood window', () => {
  it('cannot pass with no commits', () => {
    const outcome = commits([]);
    expect(kinds(outcome)).toContain('invalid');
    expect(kinds(outcome)).not.toContain('pass');
  });

  it('accepts continuous commits including both window edges', () => {
    const outcome = commits([commit(1), commit(10), commit(20), commit(29)]);
    expect(kinds(outcome)).not.toContain('invalid');
    expect(kinds(outcome)).not.toContain('fail');
    expect(kinds(outcome)).toContain('pass');
  });

  it.each([
    ['startup silence', [commit(15), commit(20), commit(29)]],
    ['shutdown silence', [commit(1), commit(10), commit(15)]],
    ['interior silence', [commit(1), commit(20), commit(29)]],
    ['a failed insert', [commit(1), commit(10, 'error'), commit(20), commit(29)]],
  ])('fails %s even when there are some successful commits', (_name, values) => {
    expect(kinds(commits(values))).toContain('fail');
  });

  it('does not mistake one commit for coverage of a long flood', () => {
    expect(kinds(commits([commit(15)]))).toContain('fail');
  });
});

describe('a refusal requires a real HTTP response or verified displacement', () => {
  it('cannot turn expiry of the fill bound into a refusal pass', () => {
    const outcome = harness('refusal', {
      samples: [
        [0, 200],
        [300000, 204],
      ],
    });
    expect(kinds(outcome)).toContain('invalid');
    expect(kinds(outcome)).not.toContain('pass');
  });

  it.each([
    { drops: [] },
    { drops: [{ ...drop, message: 'not JSON' }] },
    { drops: [{ ...drop, module: 'untrusted-task' }] },
    {
      drops: [
        {
          ...drop,
          message: JSON.stringify({
            msg: 'the log evictor removed nothing',
            reason: 'no_partition',
          }),
        },
      ],
    },
  ])('does not accept absent or unverified drop evidence %#', ({ drops }) => {
    expect(kinds(harness('refusal', { samples: [[0, 200]], drops }))).toContain('invalid');
  });

  it('notes verified displacement instead of claiming an unobserved 429', () => {
    const outcome = harness('refusal', {
      samples: [
        [0, 200],
        [300000, 200],
      ],
      drops: [drop],
    });
    expect(kinds(outcome)).toContain('note');
    expect(kinds(outcome)).not.toContain('invalid');
    expect(kinds(outcome)).not.toContain('fail');
    // A separate zero-second longest-refusal check may pass.
    expect(
      outcome.events
        .filter((event) => event.kind === 'pass')
        .every((event) => /(?:bound|longest|window|120)/i.test(event.name + (event.detail ?? '')))
    ).toBe(true);
  });

  it('accepts an observed HTTP 429 window of at most two minutes', () => {
    const outcome = harness('refusal', {
      samples: [
        [0, 200],
        [1000, 429],
        [121000, 200],
      ],
    });
    expect(kinds(outcome)).not.toContain('invalid');
    expect(kinds(outcome)).not.toContain('fail');
    expect(kinds(outcome)).toContain('pass');
  });

  it('cannot prove the refusal bound without a confirmed successful write afterward', () => {
    const outcome = harness('refusal', {
      samples: [
        [0, 200],
        [1000, 429],
        [10000, 429],
      ],
    });
    expect(kinds(outcome)).toContain('invalid');
    expect(
      outcome.events
        .filter((event) => event.kind === 'pass')
        .some((event) => /(?:bound|duration|longest)/i.test(event.name))
    ).toBe(false);
  });

  it('fails an observed refusal lasting more than two minutes', () => {
    const outcome = harness('refusal', {
      samples: [
        [0, 429],
        [121000, 429],
        [122000, 200],
      ],
    });
    expect(kinds(outcome)).toContain('fail');
  });
});

describe('pod creation is namespaced and reports only safe failure classes', () => {
  it('passes the manifest namespace explicitly to kubectl apply', () => {
    const outcome = harness('create', { code: 0 });
    expect(outcome.namespace).toBe('lifemodel-motor');
    expect(outcome.created).toBe(true);
  });

  it.each([
    ['admission', 'admission webhook denied the request'],
    ['PodSecurity', 'violates PodSecurity restricted:latest'],
    ['image', 'ImagePullBackOff: failed to pull image'],
  ])('names %s failures without exposing the API stderr', (classification, message) => {
    const outcome = harness('create', {
      stderr: message + ' authKey=fixture-secret-DO-NOT-PRINT password=fixture-password',
    });
    const text = JSON.stringify(outcome.events);
    expect(outcome.created).toBe(false);
    expect(kinds(outcome)).toContain('invalid');
    expect(text.toLowerCase()).toContain(classification.toLowerCase());
    expect(text).not.toContain('fixture-secret');
    expect(text).not.toContain('fixture-password');
    expect(text).not.toContain('authKey=');
  });
});

describe('the accounting baseline excludes writer and Postgres startup', () => {
  it.each([
    { running: false, committed: true },
    { running: true, committed: false },
  ])('cannot prepare without Running pods and one confirmed commit: %j', (input) => {
    const outcome = harness<Outcome & { prepared: boolean }>('prepare', input);
    expect(outcome.prepared).toBe(false);
    expect(kinds(outcome)).toContain('invalid');
  });

  it('requires both readiness and a successful commit before preparation succeeds', () => {
    const outcome = harness<Outcome & { prepared: boolean; probes: string[] }>('prepare');
    expect(outcome.prepared).toBe(true);
    expect(outcome.probes).toContain('running');
    expect(outcome.probes).toContain('commit-probe');
  });

  it('takes the actual flood_case baseline only after prepare_flood succeeds', () => {
    expect(harness<{ events: string[] }>('baseline-order').events).toEqual(['ready', 'baseline']);
  });

  it('does not sample the baseline or start a flood after failed readiness', () => {
    expect(harness<{ events: string[] }>('baseline-order', { ready: false }).events).toEqual([
      'ready',
    ]);
  });
});

describe('the actual flood recovery path', () => {
  it('includes failed and successful recovery responses in refusal evidence', () => {
    const outcome = harness<Outcome & { samples: [number, number][]; writes: number[] }>(
      'recovery'
    );
    expect(outcome.writes).toEqual([429, 503, 204]);
    expect(outcome.samples.map((sample) => sample[1])).toEqual([429, 503, 204]);
    expect(
      outcome.events.find(
        (event) => event.name === 'writes are accepted again without a store restart'
      )?.kind
    ).toBe('pass');
  });

  it('fails recovery if the store restarts before writes are accepted again', () => {
    const outcome = harness('recovery', { restart: true });
    expect(
      outcome.events.find(
        (event) => event.name === 'writes are accepted again without a store restart'
      )?.kind
    ).toBe('fail');
    expect(
      outcome.events.find((event) => event.name === 'the store did not restart under the flood')
        ?.kind
    ).toBe('fail');
  });
});

describe('pod manifest startup prerequisites, without claiming task admission', () => {
  interface Container {
    command: string[];
    args?: string[];
    resources: { requests: Record<string, string>; limits: Record<string, string> };
    volumeMounts?: { subPath?: string }[];
  }
  interface Pod {
    metadata: { namespace: string };
    spec: { securityContext?: { runAsUser?: number }; containers: Container[] };
  }

  it('starts Postgres as uid 999 without an unowned subPath and selects its database user', () => {
    const { postgres } = harness<{ postgres: Pod }>('manifests');
    const container = postgres.spec.containers[0];
    expect(postgres.spec.securityContext?.runAsUser).toBe(999);
    expect(container.volumeMounts?.some((mount) => mount.subPath !== undefined)).toBe(false);
    const script = [...container.command, ...(container.args ?? [])].join(' ');
    expect(script).toContain('docker-entrypoint.sh postgres');
    expect(script).toMatch(/psql[^;]*-U postgres/);
    expect(script).toMatch(/psql[^;]*-d postgres/);
  });

  it('gives task writers explicit CPU and memory requests and limits in the task namespace', () => {
    const { writer } = harness<{ writer: Pod }>('manifests');
    expect(writer.metadata.namespace).toBe('lifemodel-motor');
    const resources = writer.spec.containers[0].resources;
    for (const key of ['cpu', 'memory']) {
      expect(resources.requests[key]).toBeTruthy();
      expect(resources.limits[key]).toBeTruthy();
    }
  });
});
