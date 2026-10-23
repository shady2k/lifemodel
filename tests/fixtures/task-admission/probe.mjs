// Static admission probes only. Fake digest prevents the baseline Job from running.
// No dependency, no token/secret input. Prints a single JSON Kubernetes object.
// node tests/fixtures/task-admission/probe.mjs <case> [Job|Pod]
const [variant = 'valid', kind = 'Job'] = process.argv.slice(2);
if (variant.startsWith('update-')) {
  const { readFileSync } = await import('node:fs');
  const current = JSON.parse(readFileSync(0, 'utf8'));
  const patch = { metadata: { resourceVersion: current.metadata.resourceVersion } };
  if (variant === 'update-deadline')
    patch.spec = { activeDeadlineSeconds: current.spec.activeDeadlineSeconds + 1 };
  else if (variant === 'update-remove-deadline') patch.spec = { activeDeadlineSeconds: null };
  else if (variant === 'update-launch')
    patch.metadata.labels = { 'lifemodel.dev/launch-id': 'mutated' };
  else if (variant === 'update-template') {
    const containers = structuredClone(current.spec.template.spec.containers);
    containers[0].workingDir = '/tmp';
    patch.spec = { template: { spec: { containers } } };
  } else if (variant === 'update-suspend') patch.spec = { suspend: true };
  else if (variant === 'update-shorten') patch.spec = { activeDeadlineSeconds: 300 };
  else throw new Error('unknown update probe');
  console.log(JSON.stringify(patch, null, 2));
  process.exit(0);
}
const label = 'lifemodel.dev/launch-id';
const labels = { [label]: 'admission-probe', 'app.kubernetes.io/name': 'task' };
const podSpec = {
  serviceAccountName: 'task',
  automountServiceAccountToken: false,
  restartPolicy: 'Never',
  terminationGracePeriodSeconds: 0,
  enableServiceLinks: false,
  dnsPolicy: 'ClusterFirst',
  securityContext: {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    fsGroup: 1000,
    seccompProfile: { type: 'RuntimeDefault' },
  },
  containers: [
    {
      name: 'task',
      image: `ghcr.io/shady2k/lifemodel-workbench@sha256:${'0'.repeat(64)}`,
      securityContext: {
        allowPrivilegeEscalation: false,
        privileged: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ['ALL'] },
      },
      volumeMounts: [
        { name: 'work', mountPath: '/work' },
        { name: 'ca', mountPath: '/var/run/task-ca', readOnly: true },
      ],
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
};
const object =
  kind === 'Job'
    ? {
        apiVersion: 'batch/v1',
        kind,
        metadata: {
          name: 'task-admission-probe',
          namespace: 'lifemodel-motor',
          labels: { ...labels },
        },
        spec: {
          parallelism: 1,
          completions: 1,
          backoffLimit: 0,
          activeDeadlineSeconds: 600,
          podReplacementPolicy: 'Failed',
          podFailurePolicy: {
            rules: [
              {
                action: 'FailJob',
                onPodConditions: [{ type: 'DisruptionTarget', status: 'True' }],
              },
              { action: 'FailJob', onExitCodes: { operator: 'NotIn', values: [0] } },
            ],
          },
          template: { metadata: { labels: { ...labels } }, spec: podSpec },
        },
      }
    : {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
          name: 'task-admission-probe-pod',
          namespace: 'lifemodel-motor',
          labels: { ...labels },
          ownerReferences: [
            {
              apiVersion: 'batch/v1',
              kind: 'Job',
              name: 'task-admission-probe',
              uid: '11111111-1111-1111-1111-111111111111',
              controller: true,
            },
          ],
        },
        spec: podSpec,
      };
const variants = {
  valid() {},
  creator() {},
  execution() {
    object.spec.backoffLimit = 1;
  },
  deadline() {
    delete object.spec.activeDeadlineSeconds;
  },
  suspend() {
    object.spec.suspend = true;
  },
  failure() {
    object.spec.podFailurePolicy.rules[0].action = 'Ignore';
  },
  launch() {
    delete object.metadata.labels[label];
  },
  identity() {
    podSpec.serviceAccountName = 'default';
  },
  launcher() {
    podSpec.containers[0].command = ['/bin/sh'];
  },
  image() {
    podSpec.containers[0].image = 'ghcr.io/shady2k/lifemodel-workbench:latest';
  },
  sidecar() {
    podSpec.initContainers = [structuredClone(podSpec.containers[0])];
  },
  security() {
    podSpec.containers[0].securityContext.readOnlyRootFilesystem = false;
  },
  environment() {
    podSpec.containers[0].env = [
      { name: 'KEY', valueFrom: { secretKeyRef: { name: 'not-read', key: 'key' } } },
    ];
  },
  volumes() {
    podSpec.volumes.push({ name: 'other', hostPath: { path: '/' } });
  },
  'ca-reference'() {
    podSpec.volumes[1].configMap.name = 'other-task-ca';
  },
  audience() {
    podSpec.volumes[2].projected.sources[0].serviceAccountToken.audience = 'fourth';
  },
  owner() {
    delete object.metadata.ownerReferences;
  },
};
if (!(variant in variants) || !['Job', 'Pod'].includes(kind))
  throw new Error('unknown probe variant or kind');
if (kind === 'Pod' && ['execution', 'deadline', 'suspend', 'failure'].includes(variant))
  throw new Error('Job-only variant');
if (kind === 'Job' && variant === 'owner') throw new Error('Pod-only variant');
variants[variant]();
console.log(JSON.stringify(object, null, 2));
