import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import {
  evaluateTaskAdmission as outcomes,
  taskAdmissionPolicy as policy,
} from '../helpers/task-admission.js';

const a0 = 'deploy/platform/a0/';
const resources = YAML.parse(readFileSync(`${a0}kustomization.yaml`, 'utf8')).resources;
const objects = resources.flatMap((name: string) =>
  YAML.parseAllDocuments(readFileSync(`${a0}${name}`, 'utf8')).map((doc) => doc.toJSON())
);
const core = 'system:serviceaccount:lifemodel:core';
const controller = 'system:serviceaccount:kube-system:job-controller';
const launch = 'lifemodel.dev/launch-id';
const labels = { [launch]: 'launch-1', 'app.kubernetes.io/name': 'task' };
const securityContext = {
  runAsNonRoot: true,
  runAsUser: 1000,
  runAsGroup: 1000,
  fsGroup: 1000,
  seccompProfile: { type: 'RuntimeDefault' },
};
function job(): any {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: 'task-admission-probe', namespace: 'lifemodel-motor', labels: { ...labels } },
    spec: {
      parallelism: 1,
      completions: 1,
      backoffLimit: 0,
      activeDeadlineSeconds: 600,
      podReplacementPolicy: 'Failed',
      podFailurePolicy: {
        rules: [
          { action: 'FailJob', onPodConditions: [{ type: 'DisruptionTarget', status: 'True' }] },
          { action: 'FailJob', onExitCodes: { operator: 'NotIn', values: [0] } },
        ],
      },
      template: {
        metadata: { labels: { ...labels } },
        spec: {
          serviceAccountName: 'task',
          automountServiceAccountToken: false,
          restartPolicy: 'Never',
          terminationGracePeriodSeconds: 0,
          enableServiceLinks: false,
          dnsPolicy: 'ClusterFirst',
          securityContext: structuredClone(securityContext),
          containers: [
            {
              name: 'task',
              image: `zot.lifemodel-system.svc:5001/lifemodel/workbench@sha256:${'a'.repeat(64)}`,
              // Entrypoint is baked into the trusted digest-pinned image (653.8.3).
              securityContext: {
                allowPrivilegeEscalation: false,
                privileged: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              volumeMounts: [{ name: 'ca', mountPath: '/var/run/task-ca', readOnly: true }],
            },
          ],
          volumes: [
            { name: 'work', emptyDir: {} },
            { name: 'ca', configMap: { name: 'lifemodel-ca' } },
            {
              name: 'identity',
              projected: {
                sources: ['model', 'storage', 'channel'].map((audience) => ({
                  serviceAccountToken: {
                    audience: `lifemodel-task-${audience}`,
                    path: audience,
                    expirationSeconds: 600,
                  },
                })),
              },
            },
          ],
        },
      },
    },
  };
}
function pod(): any {
  const source = job();
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      ...source.metadata,
      ownerReferences: [
        {
          apiVersion: 'batch/v1',
          kind: 'Job',
          name: source.metadata.name,
          uid: '11111111-1111-1111-1111-111111111111',
          controller: true,
        },
      ],
    },
    spec: source.spec.template.spec,
  };
}
function reject(kind: 'Job' | 'Pod', mutate: (value: any) => void, family: string) {
  const object = kind === 'Job' ? job() : pod();
  mutate(object);
  expect(outcomes(kind, object).some((message) => message.startsWith(`task ${family}:`))).toBe(
    true
  );
}

describe('task admission (actual CEL expression evaluation; API-server typecheck and defaulting still require VM proof)', () => {
  it.each(['Job', 'Pod'] as const)(
    'renders fail-closed %s guards in A0 with namespace-wide Deny, not identity opt-in',
    (kind) => {
      const guard = policy(kind);
      expect(guard).toBeDefined();
      expect(guard.spec.failurePolicy).toBe('Fail');
      expect(guard.spec.matchConstraints.namespaceSelector).toEqual({
        matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-motor' },
      });
      expect(guard.spec.matchConstraints.resourceRules).toEqual([
        {
          apiGroups: [kind === 'Job' ? 'batch' : ''],
          apiVersions: ['v1'],
          resources: kind === 'Job' ? ['jobs'] : ['pods', 'pods/ephemeralcontainers'],
          operations: ['CREATE', 'UPDATE'],
        },
      ]);
      expect(guard.spec.matchConditions ?? []).toEqual([]);
      expect(
        objects.find(
          (item: any) =>
            item.kind === 'ValidatingAdmissionPolicyBinding' &&
            item.metadata.name === guard.metadata.name
        )?.spec
      ).toEqual({ policyName: guard.metadata.name, validationActions: ['Deny'] });
      expect(outcomes(kind, kind === 'Job' ? job() : pod())).toEqual([]);
    }
  );
  it('uses CREATE-only controller probes without requiring Pod get rights', () => {
    const instructions = readFileSync('tests/fixtures/task-admission/README.md', 'utf8');
    const controllerCommands = instructions
      .split('\n')
      .filter((line) => line.startsWith('node ') && line.includes(`--as=${controller}`));
    expect(controllerCommands).toHaveLength(2);
    for (const command of controllerCommands)
      expect(command).toContain(`kubectl --as=${controller} create --dry-run=server -f -`);
  });
  it.each(['Job', 'Pod'] as const)(
    '%s sidecar probe has native-valid distinct container names before CEL rejects it',
    (kind) => {
      const object = JSON.parse(
        execFileSync(
          process.execPath,
          ['tests/fixtures/task-admission/probe.mjs', 'sidecar', kind],
          {
            encoding: 'utf8',
          }
        )
      );
      const spec = kind === 'Job' ? object.spec.template.spec : object.spec;
      const names = [...spec.containers, ...spec.initContainers].map((c: any) => c.name);
      expect(new Set(names).size).toBe(names.length);
      for (const name of names) expect(name).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
      expect(outcomes(kind, object)).toContainEqual(expect.stringMatching(/^task launcher:/));
    }
  );
  it.each(
    (['Job', 'Pod'] as const).flatMap((kind) =>
      ['valid', 'image', 'image-ghcr', 'image-repository', 'image-registry'].map(
        (variant) => [kind, variant] as const
      )
    )
  )('%s VM probe %s enforces the same sole zot repository', (kind, variant) => {
    const object = JSON.parse(
      execFileSync(process.execPath, ['tests/fixtures/task-admission/probe.mjs', variant, kind], {
        encoding: 'utf8',
      })
    );
    if (variant === 'valid') expect(outcomes(kind, object)).toEqual([]);
    else expect(outcomes(kind, object)).toContainEqual(expect.stringMatching(/^task launcher:/));
  });
  it('permits core Job creation and actual k3s per-controller Pod identity only', () => {
    expect(outcomes('Job', job())).toEqual([]);
    expect(outcomes('Pod', pod(), 'CREATE', null, core)).toEqual([]);
    expect(outcomes('Pod', pod())).toEqual([]);
    for (const username of [
      'system:kube-controller-manager',
      'system:serviceaccount:lifemodel-motor:task',
      'system:serviceaccount:lifemodel-motor:lifemodel-motor-applier',
    ]) {
      expect(outcomes('Job', job(), 'CREATE', null, username)).toContainEqual(
        expect.stringMatching(/^task creator:/)
      );
      expect(outcomes('Pod', pod(), 'CREATE', null, username)).toContainEqual(
        expect.stringMatching(/^task creator:/)
      );
    }
  });
  it.each([
    ['parallelism', 2],
    ['completions', 2],
    ['backoffLimit', 1],
    ['podReplacementPolicy', 'TerminatingOrFailed'],
    ['activeDeadlineSeconds', undefined],
    ['activeDeadlineSeconds', 0],
    ['activeDeadlineSeconds', 86401],
    ['suspend', true],
    ['manualSelector', true],
    ['ttlSecondsAfterFinished', 10],
  ])('rejects Job scheduling/deadline widening %s=%s', (key, value) => {
    reject(
      'Job',
      (j) => {
        if (value === undefined) delete j.spec[key];
        else j.spec[key] = value;
      },
      'execution'
    );
  });
  it('requires disruption and every nonzero exit to fail the Job, never Ignore or container-only filtering', () => {
    for (const mutate of [
      (j: any) => {
        delete j.spec.podFailurePolicy;
      },
      (j: any) => {
        j.spec.podFailurePolicy.rules.shift();
      },
      (j: any) => {
        j.spec.podFailurePolicy.rules.pop();
      },
      (j: any) => {
        j.spec.podFailurePolicy.rules[0].action = 'Ignore';
      },
      (j: any) => {
        j.spec.podFailurePolicy.rules[1].onExitCodes.values = [0, 1];
      },
      (j: any) => {
        j.spec.podFailurePolicy.rules[1].onExitCodes.containerName = 'task';
      },
    ])
      reject('Job', mutate, 'failure');
  });
  it('allows only monotone deadline shortening and immutable launch label/template on UPDATE', () => {
    const old = job();
    const shorter = job();
    shorter.spec.activeDeadlineSeconds = 300;
    expect(outcomes('Job', shorter, 'UPDATE', old)).toEqual([]);
    for (const mutate of [
      (j: any) => {
        delete j.spec.activeDeadlineSeconds;
      },
      (j: any) => {
        j.spec.activeDeadlineSeconds = 601;
      },
      (j: any) => {
        j.metadata.labels[launch] = 'another';
      },
      (j: any) => {
        j.spec.template.spec.containers[0].workingDir = '/tmp';
      },
      (j: any) => {
        j.spec.suspend = true;
      },
    ]) {
      const changed = job();
      mutate(changed);
      expect(outcomes('Job', changed, 'UPDATE', old)).toContainEqual(
        expect.stringMatching(/^task update:/)
      );
    }
  });
  it('requires a single controller Job owner reference on Pods', () => {
    for (const mutate of [
      (p: any) => {
        delete p.metadata.ownerReferences;
      },
      (p: any) => {
        p.metadata.ownerReferences[0].kind = 'ReplicaSet';
      },
      (p: any) => {
        p.metadata.ownerReferences[0].apiVersion = 'v1';
      },
      (p: any) => {
        p.metadata.ownerReferences[0].controller = false;
      },
      (p: any) => {
        delete p.metadata.ownerReferences[0].uid;
      },
    ])
      reject('Pod', mutate, 'owner');
  });
  it.each(['Job', 'Pod'] as const)(
    '%s requires matching launch/app labels and explicit task identity',
    (kind) => {
      const spec = (o: any) => (kind === 'Job' ? o.spec.template.spec : o.spec);
      reject(
        kind,
        (o) => {
          delete o.metadata.labels[launch];
        },
        'launch'
      );
      reject(
        kind,
        (o) => {
          o.metadata.labels['app.kubernetes.io/name'] = 'core';
        },
        'launch'
      );
      if (kind === 'Job')
        reject(
          kind,
          (o) => {
            o.spec.template.metadata.labels[launch] = 'other';
          },
          'launch'
        );
      reject(
        kind,
        (o) => {
          spec(o).serviceAccountName = 'core';
        },
        'identity'
      );
      reject(
        kind,
        (o) => {
          delete spec(o).automountServiceAccountToken;
        },
        'identity'
      );
      reject(
        kind,
        (o) => {
          spec(o).automountServiceAccountToken = true;
        },
        'identity'
      );
    }
  );
  it.each(['Job', 'Pod'] as const)(
    '%s only runs a digest-pinned trusted launcher without sidecars or alternate hooks',
    (kind) => {
      const spec = (o: any) => (kind === 'Job' ? o.spec.template.spec : o.spec);
      for (const mutate of [
        (s: any) => {
          s.containers.push({ ...structuredClone(s.containers[0]), name: 'task-extra' });
        },
        (s: any) => {
          s.initContainers = [{ ...structuredClone(s.containers[0]), name: 'task-init' }];
        },
        (s: any) => {
          s.ephemeralContainers = [{ ...structuredClone(s.containers[0]), name: 'task-debug' }];
        },
        (s: any) => {
          s.containers[0].image = 'zot.lifemodel-system.svc:5001/lifemodel/workbench:latest';
        },
        (s: any) => {
          s.containers[0].image = `evil.example/workbench@sha256:${'a'.repeat(64)}`;
        },
        (s: any) => {
          s.containers[0].command = ['/bin/sh'];
        },
        (s: any) => {
          s.containers[0].args = ['--skip-binding'];
        },
        (s: any) => {
          s.containers[0].lifecycle = { postStart: { exec: { command: ['/bin/sh'] } } };
        },
      ])
        reject(kind, (o) => mutate(spec(o)), 'launcher');
    }
  );
  it.each(
    (['Job', 'Pod'] as const).flatMap((kind) =>
      [
        `ghcr.io/shady2k/lifemodel-workbench@sha256:${'a'.repeat(64)}`,
        'zot.lifemodel-system.svc:5001/lifemodel/workbench:latest',
        `zot.lifemodel-system.svc:5001/lifemodel/other@sha256:${'a'.repeat(64)}`,
        `other.example:5001/lifemodel/workbench@sha256:${'a'.repeat(64)}`,
        `zot.lifemodel-system.svc:5001/lifemodel/workbench@sha256:${'A'.repeat(64)}`,
        `zot.lifemodel-system.svc:5001/lifemodel/workbench@sha256:${'a'.repeat(63)}`,
      ].map((image) => [kind, image] as const)
    )
  )('%s refuses any image outside the digest-pinned local zot repository: %s', (kind, image) => {
    reject(
      kind,
      (object) => {
        const spec = kind === 'Job' ? object.spec.template.spec : object.spec;
        spec.containers[0].image = image;
      },
      'launcher'
    );
  });
  it.each(['Job', 'Pod'] as const)(
    '%s requires explicit restricted contexts and refuses host escape/exfil fields',
    (kind) => {
      const spec = (o: any) => (kind === 'Job' ? o.spec.template.spec : o.spec);
      for (const mutate of [
        (s: any) => {
          delete s.securityContext;
        },
        (s: any) => {
          s.securityContext.runAsNonRoot = false;
        },
        (s: any) => {
          s.securityContext.runAsUser = 0;
        },
        (s: any) => {
          s.securityContext.seccompProfile.type = 'Unconfined';
        },
        (s: any) => {
          delete s.containers[0].securityContext;
        },
        (s: any) => {
          s.containers[0].securityContext.privileged = true;
        },
        (s: any) => {
          s.containers[0].securityContext.allowPrivilegeEscalation = true;
        },
        (s: any) => {
          s.containers[0].securityContext.capabilities.add = ['NET_ADMIN'];
        },
        (s: any) => {
          s.containers[0].securityContext.readOnlyRootFilesystem = false;
        },
        (s: any) => {
          s.containers[0].securityContext.runAsUser = 0;
        },
        (s: any) => {
          s.hostNetwork = true;
        },
        (s: any) => {
          s.hostPID = true;
        },
        (s: any) => {
          s.hostIPC = true;
        },
        (s: any) => {
          s.hostAliases = [{ ip: '1.2.3.4', hostnames: ['storage-module'] }];
        },
        (s: any) => {
          s.dnsConfig = { nameservers: ['1.1.1.1'] };
        },
        (s: any) => {
          s.dnsPolicy = 'Default';
        },
        (s: any) => {
          s.nodeName = 'untrusted-node';
        },
        (s: any) => {
          s.imagePullSecrets = [{ name: 'untrusted-secret' }];
        },
        (s: any) => {
          s.containers[0].ports = [{ containerPort: 8080, hostPort: 8080 }];
        },
        (s: any) => {
          s.restartPolicy = 'Always';
        },
        (s: any) => {
          s.terminationGracePeriodSeconds = 30;
        },
      ])
        reject(kind, (o) => mutate(spec(o)), 'security');
    }
  );
  it.each(['Job', 'Pod'] as const)(
    '%s permits only the ten literal launch-configuration environment names',
    (kind) => {
      const names = [
        'LIFEMODEL_STORAGE_ENDPOINT',
        'LIFEMODEL_STORAGE_SPACE',
        'LIFEMODEL_STORAGE_TOKEN_FILE',
        'LIFEMODEL_STORAGE_CA_FILE',
        'LIFEMODEL_TASK_CHANNEL_ENDPOINT',
        'LIFEMODEL_TASK_CHANNEL_TOKEN_FILE',
        'LIFEMODEL_TASK_CHANNEL_CA_FILE',
        'LIFEMODEL_TASK_MODEL_ENDPOINT',
        'LIFEMODEL_TASK_MODEL_TOKEN_FILE',
        'LIFEMODEL_TASK_MODEL_CA_FILE',
      ];
      for (const name of names) {
        const object = kind === 'Job' ? job() : pod();
        const c = (kind === 'Job' ? object.spec.template.spec : object.spec).containers[0];
        c.env = [{ name, value: 'literal-configuration' }];
        expect(outcomes(kind, object)).toEqual([]);
      }
      const object = kind === 'Job' ? job() : pod();
      const c = (kind === 'Job' ? object.spec.template.spec : object.spec).containers[0];
      c.env = names.map((name) => ({ name, value: 'literal-configuration' }));
      c.envFrom = [];
      expect(outcomes(kind, object)).toEqual([]);
      c.env = [];
      expect(outcomes(kind, object)).toEqual([]);
    }
  );
  it.each(['Job', 'Pod'] as const)(
    '%s rejects unlisted or nonliteral env configuration and every envFrom source',
    (kind) => {
      for (const name of [
        'KEY',
        'NODE_OPTIONS',
        'LD_PRELOAD',
        'PATH',
        'LIFEMODEL_STORAGE_ENDPOINT_EXTRA',
        'LIFEMODEL_TASK_CHANNEL_TOKEN',
        'LIFEMODEL_TASK_MODEL_TOKEN',
        'lifemodel_storage_endpoint',
      ])
        reject(
          kind,
          (o) => {
            const c = (kind === 'Job' ? o.spec.template.spec : o.spec).containers[0];
            c.env = [
              { name: 'LIFEMODEL_STORAGE_SPACE', value: 'space-1' },
              { name, value: 'unlisted' },
            ];
          },
          'environment'
        );
      for (const valueFrom of [
        { secretKeyRef: { name: 'key', key: 'value' } },
        { configMapKeyRef: { name: 'config', key: 'value' } },
        { fieldRef: { fieldPath: 'metadata.name' } },
        { resourceFieldRef: { resource: 'limits.cpu' } },
      ])
        for (const literal of [false, true])
          reject(
            kind,
            (o) => {
              const c = (kind === 'Job' ? o.spec.template.spec : o.spec).containers[0];
              c.env = [
                {
                  name: 'LIFEMODEL_STORAGE_ENDPOINT',
                  ...(literal ? { value: 'literal' } : {}),
                  valueFrom,
                },
              ];
            },
            'environment'
          );
      reject(
        kind,
        (o) => {
          const c = (kind === 'Job' ? o.spec.template.spec : o.spec).containers[0];
          c.env = [{ name: 'LIFEMODEL_STORAGE_ENDPOINT' }];
        },
        'environment'
      );
      for (const source of [{ secretRef: { name: 'key' } }, { configMapRef: { name: 'config' } }])
        reject(
          kind,
          (o) => {
            const c = (kind === 'Job' ? o.spec.template.spec : o.spec).containers[0];
            c.env = [{ name: 'LIFEMODEL_STORAGE_SPACE', value: 'space-1' }];
            c.envFrom = [source];
          },
          'environment'
        );
    }
  );
  it.each(['Job', 'Pod'] as const)('%s closes volume sources and token audience sets', (kind) => {
    const spec = (o: any) => (kind === 'Job' ? o.spec.template.spec : o.spec);
    for (const volume of [
      { name: 'bad', hostPath: { path: '/' } },
      { name: 'bad', secret: { secretName: 'key' } },
      { name: 'bad', persistentVolumeClaim: { claimName: 'another-task' } },
      { name: 'bad', configMap: { name: 'another-config' } },
      { name: 'bad', projected: { sources: [{ secret: { name: 'key' } }] } },
      {
        name: 'bad',
        projected: {
          sources: [
            { serviceAccountToken: { audience: 'https://kubernetes.default.svc', path: 'token' } },
          ],
        },
      },
      { name: 'bad', projected: { sources: [{ configMap: { name: 'other' } }] } },
    ])
      reject(
        kind,
        (o) => {
          spec(o).volumes.push(volume);
        },
        'volumes'
      );
    for (const audience of [
      'lifemodel-task-model',
      'lifemodel-task-storage',
      'lifemodel-task-channel',
    ]) {
      const o = kind === 'Job' ? job() : pod();
      spec(o).volumes[2].projected.sources = [
        { serviceAccountToken: { audience, path: 'token', expirationSeconds: 600 } },
      ];
      expect(outcomes(kind, o)).toEqual([]);
    }
    reject(
      kind,
      (o) => {
        spec(o).volumes[2].projected.sources[0].serviceAccountToken.audience = 'fourth';
      },
      'volumes'
    );
  });

  it.each(['Job', 'Pod'] as const)(
    '%s permits rotating CA/identity directory mounts and private work subpaths',
    (kind) => {
      const object = kind === 'Job' ? job() : pod();
      const spec = kind === 'Job' ? object.spec.template.spec : object.spec;
      spec.containers[0].volumeMounts.push(
        { name: 'identity', mountPath: '/var/run/task-identity', readOnly: true },
        { name: 'work', mountPath: '/work', subPath: 'workspace' },
        { name: 'work', mountPath: '/scratch', subPathExpr: 'scratch' }
      );
      expect(outcomes(kind, object)).toEqual([]);
      spec.volumes[1] = {
        name: 'ca',
        projected: { sources: [{ configMap: { name: 'lifemodel-ca' } }] },
      };
      expect(outcomes(kind, object)).toEqual([]);
    }
  );
  it.each(
    (['Job', 'Pod'] as const).flatMap((kind) =>
      ['token', 'CA', 'projected CA'].flatMap((source) =>
        ['subPath', 'subPathExpr'].map((field) => [kind, source, field] as const)
      )
    )
  )('%s rejects %s %s mounts that freeze rotation', (kind, source, field) => {
    reject(
      kind,
      (object) => {
        const spec = kind === 'Job' ? object.spec.template.spec : object.spec;
        if (source === 'projected CA')
          spec.volumes[1] = {
            name: 'ca',
            projected: { sources: [{ configMap: { name: 'lifemodel-ca' } }] },
          };
        spec.containers[0].volumeMounts = [
          {
            name: source === 'token' ? 'identity' : 'ca',
            mountPath: '/var/run/task-file',
            readOnly: true,
            [field]: source === 'token' ? 'model' : 'ca.crt',
          },
        ];
      },
      'volumes'
    );
  });

  it('does not exempt Pod UPDATE or debug ephemeral-container subresources', () => {
    const old = pod();
    expect(outcomes('Pod', pod(), 'UPDATE', old)).toEqual([]);
    for (const mutate of [
      (p: any) => {
        p.metadata.labels[launch] = 'new-launch';
      },
      (p: any) => {
        p.metadata.ownerReferences[0].uid = '22222222-2222-2222-2222-222222222222';
      },
      (p: any) => {
        p.spec.containers[0].image = `zot.lifemodel-system.svc:5001/lifemodel/workbench@sha256:${'b'.repeat(64)}`;
      },
      (p: any) => {
        p.spec.ephemeralContainers = [
          { ...structuredClone(p.spec.containers[0]), name: 'task-debug' },
        ];
      },
    ]) {
      const changed = pod();
      mutate(changed);
      expect(outcomes('Pod', changed, 'UPDATE', old).length).toBeGreaterThan(0);
    }
    expect(policy('Pod').spec.matchConstraints.resourceRules[0].resources).toContain(
      'pods/ephemeralcontainers'
    );
  });
  it.each(['Job', 'Pod'] as const)(
    '%s cannot load code through env, mount CA writable, or clone another workspace',
    (kind) => {
      const spec = (o: any) => (kind === 'Job' ? o.spec.template.spec : o.spec);
      reject(
        kind,
        (o) => {
          spec(o).containers[0].env = [
            { name: 'NODE_OPTIONS', value: '--import=/work/bypass.mjs' },
          ];
        },
        'environment'
      );
      reject(
        kind,
        (o) => {
          spec(o).containers[0].volumeMounts[0].readOnly = false;
        },
        'volumes'
      );
      const fresh = {
        name: 'fresh',
        ephemeral: {
          volumeClaimTemplate: {
            spec: {
              accessModes: ['ReadWriteOnce'],
              storageClassName: 'local-path',
              resources: { requests: { storage: '1Gi' } },
            },
          },
        },
      };
      const good = kind === 'Job' ? job() : pod();
      spec(good).volumes.push(structuredClone(fresh));
      expect(outcomes(kind, good)).toEqual([]);
      for (const extra of [
        { volumeName: 'other-task-pv' },
        { selector: { matchLabels: { task: 'other' } } },
        { dataSource: { kind: 'PersistentVolumeClaim', name: 'other-task' } },
        { dataSourceRef: { kind: 'PersistentVolumeClaim', name: 'other-task' } },
        { storageClassName: 'unreviewed-class' },
        { accessModes: ['ReadWriteMany'] },
      ])
        reject(
          kind,
          (o) => {
            const bad = structuredClone(fresh);
            Object.assign(bad.ephemeral.volumeClaimTemplate.spec, extra);
            spec(o).volumes.push(bad);
          },
          'volumes'
        );
      const projectedCa = kind === 'Job' ? job() : pod();
      spec(projectedCa).volumes[1] = {
        name: 'ca',
        projected: { sources: [{ configMap: { name: 'lifemodel-ca' } }] },
      };
      expect(outcomes(kind, projectedCa)).toEqual([]);
    }
  );
});
