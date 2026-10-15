import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(root, 'deploy/cli/lifemodel.mjs');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(responses: Record<string, unknown>, history?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'lifemodel-doctor-'));
  dirs.push(dir);
  const data = join(dir, 'responses'); mkdirSync(data);
  for (const [name, body] of Object.entries(responses)) writeFileSync(join(data, `${name}.json`), JSON.stringify(body));
  const calls = join(dir, 'calls');
  const input = join(dir, 'input');
  const fake = join(dir, 'kubectl');
  writeFileSync(fake, `#!/bin/sh
if [ "$1" = --kubeconfig ]; then shift 2; fi
printf '<%s>' "$@" >> "$FAKE_KUBECTL_CALLS"
printf '\n' >> "$FAKE_KUBECTL_CALLS"
if [ "$1" = apply ]; then cat > "$FAKE_KUBECTL_INPUT"; exit 0; fi
if [ "$1" = exec ]; then
  cat "$FAKE_KUBECTL_RESPONSES/bao-status.json"
  exit "\${FAKE_BAO_EXIT:-0}"
fi
if [ "$1" = get ]; then
  case "$2" in *' '*) echo 'malformed resource token' >&2; exit 8;; esac
  case "$2:$3" in
    ocirepositories:*) file=ocirepositories;; ocirepository:*) file=ocirepository;; gitrepositories:*) file=gitrepositories;; kustomizations:*) file=kustomizations;; deployments:*) file=deployments;; statefulsets:*) file=statefulset;; pods:*) file=pods;; events:*) file=events;; secrets:loader-bootstrap-state) file=secret;; secret:*) file=secret;; *) exit 9;;
  esac
  case "$*" in *"-n lifemodel-system "*) :;; *"-n lifemodel-motor "*) file=$file-lifemodel-motor;; *"-n lifemodel-git "*) file=$file-lifemodel-git;; *"-n lifemodel "*) file=$file-lifemodel;; esac
  cat "$FAKE_KUBECTL_RESPONSES/$file.json"
fi
`);
  chmodSync(fake, 0o755);
  const historyPath = join(dir, 'history');
  if (history !== undefined) writeFileSync(historyPath, history);
  const env = { ...process.env, LIFEMODEL_KUBECTL: 'kubectl', LIFEMODEL_HISTORY: historyPath, LIFEMODEL_STATE_DIR: dir, LIFEMODEL_CONFIGURED_REF: 'tag=v2.0.0', LIFEMODEL_APPLY_SCRIPT: '/bin/true', LIFEMODEL_APPLY_ARGS: '[]', PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
    FAKE_KUBECTL_CALLS: calls, FAKE_KUBECTL_INPUT: input, FAKE_KUBECTL_RESPONSES: data };
  return { dir, calls, input, env };
}

const healthy = {
  ocirepositories: { items: [{ metadata: { name: 'platform', generation: 1 }, status: { observedGeneration: 1, conditions: [{ type: 'Ready', status: 'True', reason: 'Succeeded', message: 'stored artifact' }], artifact: { revision: 'sha256:root' } } }] },
  gitrepositories: { items: [{ metadata: { name: 'apps', generation: 1 }, status: { observedGeneration: 1, conditions: [{ type: 'Ready', status: 'True', reason: 'Succeeded', message: 'stored source' }], artifact: { revision: 'main@sha1:abc' } } }] },
  kustomizations: { items: [{ metadata: { name: 'platform', namespace: 'flux-system', generation: 1 }, status: { observedGeneration: 1, conditions: [{ type: 'Ready', status: 'True', reason: 'ReconciliationSucceeded', message: 'Applied revision' }], lastAppliedRevision: 'sha256:root' } }] },
  deployments: { items: [{ metadata: { name: 'loader', generation: 1 }, spec: { replicas: 1 }, status: { observedGeneration: 1, readyReplicas: 1, replicas: 1 } }] },
  pods: { items: [{ metadata: { name: 'loader-abc', labels: { app: 'loader' } }, status: { phase: 'Running', containerStatuses: [{ restartCount: 0, ready: true }] } }] },
  'pods-lifemodel': { items: [{ metadata: { name: 'core-0', labels: { 'app.kubernetes.io/name': 'core', 'controller-revision-hash': 'core-abc' } }, status: { phase: 'Running', containerStatuses: [{ restartCount: 2, ready: true }] } }] },
  'statefulset-lifemodel': { metadata: { name: 'core', generation: 1 }, spec: { replicas: 1 }, status: { observedGeneration: 1, readyReplicas: 1, currentRevision: 'core-abc' } },
  events: { items: [] },
  'gitrepositories-lifemodel': { items: [{ metadata: { name: 'lifemodel', namespace: 'lifemodel', generation: 1 }, status: { observedGeneration: 1, conditions: [{ type: 'Ready', status: 'True', reason: 'Succeeded' }] } }] },
  'gitrepositories-lifemodel-motor': { items: [{ metadata: { name: 'lifemodel-motor', namespace: 'lifemodel-motor', generation: 1 }, status: { observedGeneration: 1, conditions: [{ type: 'Ready', status: 'True', reason: 'Succeeded' }] } }] },
  'kustomizations-lifemodel': { items: [{ metadata: { name: 'lifemodel', namespace: 'lifemodel', generation: 1 }, status: { observedGeneration: 1, conditions: [{ type: 'Ready', status: 'True', reason: 'Succeeded' }] } }] },
  'kustomizations-lifemodel-motor': { items: [{ metadata: { name: 'lifemodel-motor', namespace: 'lifemodel-motor', generation: 1 }, status: { observedGeneration: 1, conditions: [{ type: 'Ready', status: 'True', reason: 'Succeeded' }] } }] },
  'deployments-lifemodel-git': { items: [{ metadata: { name: 'gitea', generation: 1 }, spec: { replicas: 1 }, status: { observedGeneration: 1, readyReplicas: 1 } }] },
  secret: { data: { phase: Buffer.from(JSON.stringify({ phase: 'gitea-application-kustomizations', status: 'complete' })).toString('base64'), custody: Buffer.from('DOCTOR_SECRET_CANARY_CUSTODY').toString('base64'), 'gitea-admin': Buffer.from('DOCTOR_SECRET_CANARY_GITEA_ADMIN').toString('base64'), credentials: Buffer.from('DOCTOR_SECRET_CANARY_CREDENTIALS').toString('base64') } },
  'bao-status': { initialized: true, sealed: false },
};

function runAsync(args: string[], env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', resolve);
  });
}

describe('lifemodel doctor', () => {
  it('warns when cpuinfo lacks x86-64-v2 flags', () => {
    const env = setup(healthy);
    env.env.LIFEMODEL_CPUINFO = join(root, 'tests/fixtures/cpuinfo-x86-64-v1.txt');
    const run = spawnSync(process.execPath, [cli, 'doctor'], { env: env.env, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stderr).toContain('CPU lacks x86-64-v2 flags (sse4_2, popcnt)');
    expect(run.stderr).toContain('core image memory search may fail to load');
    expect(run.stderr).toContain('set the vCPU type to host or an x86-64-v2 model');
  });

  it('reports ready Flux resources and loader state with exit zero', () => {
    const env = setup(healthy);
    const run = spawnSync(process.execPath, [cli, 'doctor'], { env: env.env, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('OCIRepository/platform Ready=True generationCurrent=yes reason=Succeeded message=stored artifact revision=sha256:root');
    expect(run.stdout).toContain('GitRepository/apps Ready=True');
    expect(run.stdout).toContain('Kustomization/platform Ready=True');
    expect(run.stdout).toContain('GitRepository/lifemodel/lifemodel Ready=True generationCurrent=yes');
    expect(run.stdout).toContain('Kustomization/lifemodel-motor/lifemodel-motor Ready=True generationCurrent=yes');
    expect(run.stdout).toContain('Pod/loader-abc phase=Running ready=yes restarts=0');
    expect(run.stdout).toContain('Deployment/loader ready=yes generationCurrent=yes desiredReplicas=1 restarts=0 lastEventReason=none');
    expect(run.stdout).toContain('StatefulSet/core ready=yes generationCurrent=yes desiredReplicas=1 restarts=2 revision=core-abc snapshotCommitAge=not-queried');
    expect(run.stdout).toContain('Pod/core-0 phase=Running ready=yes restarts=2');
    expect(readFileSync(env.calls, 'utf8').trim().split('\n')).toEqual([
      '<exec><-n><openbao><openbao-0><--><bao><status><-format=json>',
      '<get><ocirepositories><-n><flux-system><-o><json>',
      '<get><gitrepositories><-n><flux-system><-o><json>',
      '<get><kustomizations><-n><flux-system><-o><json>',
      '<get><secrets><loader-bootstrap-state><-n><lifemodel-system><-o><json>',
      '<get><gitrepositories><-n><lifemodel><-o><json>',
      '<get><gitrepositories><-n><lifemodel-motor><-o><json>',
      '<get><kustomizations><-n><lifemodel><-o><json>',
      '<get><kustomizations><-n><lifemodel-motor><-o><json>',
      '<get><deployments><-n><lifemodel-git><-o><json>',
      '<get><deployments><-n><lifemodel-system><-o><json>',
      '<get><pods><-n><lifemodel-system><-o><json>',
      '<get><events><-n><lifemodel-system><-o><json>',
      '<get><statefulsets><core><-n><lifemodel><-o><json>',
      '<get><pods><-n><lifemodel><-o><json>',
    ]);
  });

  it('never prints values from custody, gitea-admin, or credentials Secrets', () => {
    const env = setup(healthy);
    const run = spawnSync(process.execPath, [cli, 'doctor'], { env: env.env, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(`${run.stdout}${run.stderr}`).not.toContain('DOCTOR_SECRET_CANARY');
  });

  it.each([
    ['sealed OpenBao', (data: any) => { data['bao-status'] = { initialized: true, sealed: true }; }, 2, 'OpenBao (sealed)'],
    ['uninitialised OpenBao', (data: any) => { data['bao-status'] = { initialized: false, sealed: false }; }, 0, 'OpenBao (uninitialised)'],
    ['unready Gitea', (data: any) => { data['deployments-lifemodel-git'].items[0].status.readyReplicas = 0; }, 0, 'Deployment/gitea'],
    ['a failing application source', (data: any) => { data['gitrepositories-lifemodel'].items[0].status.conditions[0].status = 'False'; }, 0, 'GitRepository/lifemodel/lifemodel'],
    ['a stale application Kustomization', (data: any) => { data['kustomizations-lifemodel'].items[0].status.observedGeneration = 0; }, 0, 'Kustomization/lifemodel/lifemodel'],
    ['an unready core pod', (data: any) => { data['pods-lifemodel'].items[0].status.containerStatuses[0].ready = false; }, 0, 'StatefulSet/core'],
  ])('names %s', (_name, alter, baoExit, expected) => {
    const data = structuredClone(healthy) as Record<string, any>;
    alter(data);
    const env = setup(data);
    env.env.FAKE_BAO_EXIT = String(baoExit);
    const run = spawnSync(process.execPath, [cli, 'doctor'], { env: env.env, encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(`${run.stdout}${run.stderr}`).toContain(expected);
  });

  it('reports a missing source as expected while first start is incomplete', () => {
    const data = structuredClone(healthy) as Record<string, any>;
    data.secret.data.phase = Buffer.from(JSON.stringify({ phase: 'gitea-ready', status: 'running' })).toString('base64');
    data['gitrepositories-lifemodel'].items = [];
    const env = setup(data);
    const run = spawnSync(process.execPath, [cli, 'doctor'], { env: env.env, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('first start in progress at gitea-ready');
  });

  it('treats the platform-created empty phase Secret as not started and continues checks', () => {
    const data = structuredClone(healthy) as Record<string, any>;
    data.secret = { data: { custody: Buffer.from('DOCTOR_SECRET_CANARY_CUSTODY').toString('base64'), 'gitea-admin': Buffer.from('DOCTOR_SECRET_CANARY_GITEA_ADMIN').toString('base64'), credentials: Buffer.from('DOCTOR_SECRET_CANARY_CREDENTIALS').toString('base64') } };
    data['gitrepositories-lifemodel'].items = [];
    const env = setup(data);
    const run = spawnSync(process.execPath, [cli, 'doctor'], { env: env.env, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Loader first start not started');
    expect(run.stdout).toContain('GitRepository/lifemodel/lifemodel: missing (expected; first start not started)');
    expect(run.stdout).toContain('Deployment/loader ready=yes');
    expect(`${run.stdout}${run.stderr}`).not.toContain('DOCTOR_SECRET_CANARY');
  });

  it('reports a malformed phase record and continues reporting independent failures', () => {
    const data = structuredClone(healthy) as Record<string, any>;
    data.secret.data.phase = Buffer.from('{bad json').toString('base64');
    data['gitrepositories-lifemodel'].items = [];
    const env = setup(data);
    const run = spawnSync(process.execPath, [cli, 'doctor'], { env: env.env, encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Secret loader-bootstrap-state (invalid phase record)');
    expect(run.stderr).toContain('GitRepository/lifemodel/lifemodel (missing)');
    expect(run.stdout).toContain('Deployment/loader ready=yes');
  });

  it('fails a persisted failed phase and does not waive missing application resources', () => {
    const data = structuredClone(healthy) as Record<string, any>;
    data.secret.data.phase = Buffer.from(JSON.stringify({ phase: 'source-credentials', status: 'failed' })).toString('base64');
    data['gitrepositories-lifemodel'].items = [];
    const env = setup(data);
    const run = spawnSync(process.execPath, [cli, 'doctor'], { env: env.env, encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('Loader first start phase=source-credentials status=failed');
    expect(run.stderr).toContain('Loader bootstrap phase source-credentials (failed)');
    expect(run.stderr).toContain('GitRepository/lifemodel/lifemodel (missing)');
  });

  it('prints a completed phase and status without exposing secret data', () => {
    const env = setup(healthy);
    const run = spawnSync(process.execPath, [cli, 'doctor'], { env: env.env, encoding: 'utf8' });
    expect(run.stdout).toContain('Loader first start phase=gitea-application-kustomizations status=complete');
    expect(`${run.stdout}${run.stderr}`).not.toContain('DOCTOR_SECRET_CANARY');
  });

  it.each([
    ['running', 'gitea-ready'],
    ['complete', 'gitea-ready'],
  ])('keeps %s at non-final phase non-fatal for missing application objects', (status, phase) => {
    const data = structuredClone(healthy) as Record<string, any>;
    data.secret.data.phase = Buffer.from(JSON.stringify({ phase, status })).toString('base64');
    data['gitrepositories-lifemodel'].items = [];
    const env = setup(data);
    const run = spawnSync(process.execPath, [cli, 'doctor'], { env: env.env, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`Loader first start phase=${phase} status=${status}`);
    expect(run.stdout).toContain('missing (expected; first start');
  });

  it('reports missing application resources as failures after first start completes', () => {
    const data = structuredClone(healthy) as Record<string, any>;
    data['gitrepositories-lifemodel'].items = [];
    data['kustomizations-lifemodel-motor'].items = [];
    const env = setup(data);
    const run = spawnSync(process.execPath, [cli, 'doctor'], { env: env.env, encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('GitRepository/lifemodel/lifemodel (missing)');
    expect(run.stderr).toContain('Kustomization/lifemodel-motor/lifemodel-motor (missing)');
  });

  it('allows no GitRepository before the first loader start', () => {
    const beforeFirstStart = structuredClone(healthy);
    beforeFirstStart.gitrepositories.items = [];
    const env = setup(beforeFirstStart);
    const run = spawnSync(process.execPath, [cli, 'doctor'], { env: env.env, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('GitRepository: none (expected before the first loader start)');
    expect(run.stderr).toBe('');
  });

  it('names an existing non-ready GitRepository and exits non-zero', () => {
    const bad = structuredClone(healthy);
    bad.gitrepositories.items[0].status.conditions[0] = { type: 'Ready', status: 'False', reason: 'FetchFailed', message: 'source unavailable' };
    const env = setup(bad);
    const run = spawnSync(process.execPath, [cli, 'doctor'], { env: env.env, encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('GitRepository/apps Ready=False generationCurrent=yes reason=FetchFailed message=source unavailable');
    expect(run.stderr).toContain('Not ready: GitRepository/apps');
  });

  it('names a failing Kustomization and exits non-zero', () => {
    const bad = structuredClone(healthy);
    bad.kustomizations.items[0].status.conditions[0] = { type: 'Ready', status: 'False', reason: 'BuildFailed', message: 'bad path' };
    const env = setup(bad);
    const run = spawnSync(process.execPath, [cli, 'doctor'], { env: env.env, encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('Kustomization/platform Ready=False generationCurrent=yes reason=BuildFailed message=bad path');
    expect(run.stderr).toContain('Not ready: Kustomization/platform');
  });

  it('rejects competing managedFields ownership with a reset command before success', () => {
    const competing = structuredClone(healthy);
    competing.ocirepositories.items[0].metadata.managedFields = [{ manager: 'kubectl-patch', fieldsV1: { 'f:spec': { 'f:ref': { 'f:digest': {} } } } }];
    competing.ocirepository = competing.ocirepositories.items[0];
    const env = setup(competing);
    const run = spawnSync(process.execPath, [cli, 'assert-root-ownership'], { env: env.env, encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('owned by kubectl-patch');
    expect(run.stderr).toContain('delete ocirepository platform');
    expect(readFileSync(env.calls, 'utf8')).toContain('<get><ocirepository><platform><-n><flux-system><-o><json><--show-managed-fields>');
  });

  it('persists the previous ref as an override and reruns bootstrap without writing the cluster', () => {
    const env = setup(healthy, 'tag=v2.0.0\ntag=v1.0.0\n');
    const run = spawnSync(process.execPath, [cli, 'doctor', '--repin', 'previous'], { env: env.env, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(JSON.parse(readFileSync(join(env.dir, 'platform-override'), 'utf8'))).toEqual({ ref: 'tag=v1.0.0', configuredRef: 'tag=v2.0.0' });
    expect(existsSync(env.calls) ? readFileSync(env.calls, 'utf8') : '').toBe('');
  });

  it('keeps the writer lock through doctor recovery when an installer overlaps', async () => {
    const env = setup(healthy, 'tag=v2.0.0\ntag=v1.0.0\n');
    const apply = join(env.dir, 'apply.sh');
    const applied = join(env.dir, 'reapplied');
    writeFileSync(apply, `#!/bin/sh\nflock -n "$LIFEMODEL_LOCK_FD" || exit 17\nprintf locked > '${applied}'\n`);
    chmodSync(apply, 0o755);
    env.env.LIFEMODEL_APPLY_SCRIPT = apply;
    const installer = spawn('flock', ['-x', join(env.dir, 'lock'), 'sh', '-c', 'printf locked; sleep 0.2'], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise<void>((resolve, reject) => {
      installer.once('error', reject);
      installer.stdout?.once('data', () => resolve());
    });
    const recovery = runAsync([cli, 'doctor', '--repin', 'previous'], env.env);
    const [installerStatus, recoveryStatus] = await Promise.all([
      new Promise<number | null>((resolve, reject) => { installer.once('error', reject); installer.once('close', resolve); }),
      recovery,
    ]);
    expect(installerStatus).toBe(0);
    expect(recoveryStatus).toBe(0);
    expect(readFileSync(applied, 'utf8')).toBe('locked');
    expect(JSON.parse(readFileSync(join(env.dir, 'platform-override'), 'utf8')).ref).toBe('tag=v1.0.0');
  });

  it('records each successfully applied ref and keeps the prior distinct ref', () => {
    const env = setup(healthy);
    for (const ref of ['tag=v1.0.0', 'digest=sha256:' + 'a'.repeat(64), 'digest=sha256:' + 'a'.repeat(64)]) {
      const run = spawnSync(process.execPath, [cli, 'record-applied', ref], { env: env.env, encoding: 'utf8' });
      expect(run.status).toBe(0);
    }
    expect(readFileSync(join(env.dir, 'history'), 'utf8')).toBe(`digest=sha256:${'a'.repeat(64)}\ntag=v1.0.0\n`);
  });

  it('serializes overlapping history writers without losing either apply', async () => {
    const env = setup(healthy);
    const results = await Promise.all([
      runAsync([cli, 'record-applied', 'tag=v1.0.0'], env.env),
      runAsync([cli, 'record-applied', 'tag=v2.0.0'], env.env),
    ]);
    expect(results).toEqual([0, 0]);
    expect(readFileSync(join(env.dir, 'history'), 'utf8').split('\n').filter(Boolean).sort()).toEqual(['tag=v1.0.0', 'tag=v2.0.0']);
  });

  it.each([
    [`digest=sha256:${'2'.repeat(64)}`, `tag=v1.0.0`, `    tag: "v1.0.0"`],
    [`tag=v2.0.0`, `digest=sha256:${'1'.repeat(64)}`, `    digest: sha256:${'1'.repeat(64)}`],
  ])('renders one complete ref selector for mixed configured and override refs', (configuredRef, ref, expected) => {
    const env = setup(healthy);
    const source = join(env.dir, 'oci.yaml');
    writeFileSync(source, "spec:\n  ref:\n    tag: 'old'\n  verify: {}\n");
    writeFileSync(join(env.dir, 'platform-override'), JSON.stringify({ ref, configuredRef }));
    const run = spawnSync(process.execPath, [cli, 'render-ref', source, configuredRef], { env: env.env, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect((run.stdout.match(/^    (?:tag|digest):.*$/gm) || []).map((line) => line.trim())).toEqual([expected.trim()]);
  });


  it.each([
    ['fresh configured digest', `digest=sha256:${'a'.repeat(64)}`, undefined],
    ['unchanged digest override', `digest=sha256:${'a'.repeat(64)}`, `digest=sha256:${'a'.repeat(64)}`],
    ['clear back to configured digest', `digest=sha256:${'a'.repeat(64)}`, `tag=v1.0.0`],
  ])('renders %s even when the complete ref block is textually unchanged', (_name, configuredRef, overrideRef) => {
    const env = setup(healthy);
    const source = join(env.dir, 'oci.yaml');
    writeFileSync(source, `spec:\n  ref:\n    digest: sha256:${'a'.repeat(64)}\n  verify: {}\n`);
    if (overrideRef) writeFileSync(join(env.dir, 'platform-override'), JSON.stringify({ ref: overrideRef, configuredRef: _name.startsWith('clear') ? 'tag=v0.9.0' : configuredRef }));
    const run = spawnSync(process.execPath, [cli, 'render-ref', source, configuredRef], { env: env.env, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(`    digest: sha256:${'a'.repeat(64)}`);
  });

  it('supports digest pins in a previous-release override', () => {
    const digest = `digest=sha256:${'b'.repeat(64)}`;
    const env = setup(healthy, `tag=v2.0.0\n${digest}\n`);
    const run = spawnSync(process.execPath, [cli, 'doctor', '--repin', 'previous'], { env: env.env, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(JSON.parse(readFileSync(join(env.dir, 'platform-override'), 'utf8')).ref).toBe(digest);
  });

  it('refuses a failed durable override write before invoking bootstrap', () => {
    const env = setup(healthy, 'tag=v2.0.0\ntag=v1.0.0\n');
    mkdirSync(join(env.dir, 'platform-override'));
    const run = spawnSync(process.execPath, [cli, 'doctor', '--repin', 'previous'], { env: env.env, encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(existsSync(env.calls) ? readFileSync(env.calls, 'utf8') : '').toBe('');
  });

  it('refuses malformed history before any cluster mutation', () => {
    const env = setup(healthy, 'tag=v2.0.0\nwhatever\n');
    const run = spawnSync(process.execPath, [cli, 'doctor', '--repin', 'previous'], { env: env.env, encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Corrupt platform history');
    expect(existsSync(env.calls) ? readFileSync(env.calls, 'utf8') : '').toBe('');
  });

  it('rejects stale Flux and Deployment generations and a zero-replica loader', () => {
    const stale = structuredClone(healthy);
    stale.ocirepositories.items[0].status.observedGeneration = 0;
    stale.deployments.items[0].status.observedGeneration = 0;
    const env = setup(stale);
    const run = spawnSync(process.execPath, [cli, 'doctor'], { env: env.env, encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('generationCurrent=no');
    const zero = structuredClone(healthy);
    zero.deployments.items[0].spec.replicas = 0;
    zero.deployments.items[0].status.readyReplicas = 0;
    zero.pods.items = [];
    const zeroEnv = setup(zero);
    const zeroRun = spawnSync(process.execPath, [cli, 'doctor'], { env: zeroEnv.env, encoding: 'utf8' });
    expect(zeroRun.status).not.toBe(0);
    expect(zeroRun.stdout).toContain('desiredReplicas=0');
  });

  it('refuses re-pin when history has no previous release', () => {
    const env = setup(healthy, 'tag=v1.0.0\n');
    const run = spawnSync(process.execPath, [cli, 'doctor', '--repin', 'previous'], { env: env.env, encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('No previous platform release is recorded');
    expect(existsSync(env.calls) ? readFileSync(env.calls, 'utf8') : '').toBe('');
  });
});
