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
printf '%s\n' "$*" >> "$FAKE_KUBECTL_CALLS"
if [ "$1" = apply ]; then cat > "$FAKE_KUBECTL_INPUT"; exit 0; fi
if [ "$1" = get ]; then
  case "$2" in
    ocirepositories) file=ocirepositories;; gitrepositories) file=gitrepositories;; kustomizations) file=kustomizations;; deployments) file=deployments;; pods) file=pods;; events) file=events;; *) exit 9;;
  esac
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
  events: { items: [] },
};

function runAsync(args: string[], env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', resolve);
  });
}

describe('lifemodel doctor', () => {
  it('reports ready Flux resources and loader state with exit zero', () => {
    const env = setup(healthy);
    const run = spawnSync(process.execPath, [cli, 'doctor'], { env: env.env, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('OCIRepository/platform Ready=True generationCurrent=yes reason=Succeeded message=stored artifact revision=sha256:root');
    expect(run.stdout).toContain('GitRepository/apps Ready=True');
    expect(run.stdout).toContain('Kustomization/platform Ready=True');
    expect(run.stdout).toContain('Pod/loader-abc phase=Running ready=yes restarts=0');
    expect(run.stdout).toContain('Deployment/loader ready=yes generationCurrent=yes desiredReplicas=1 restarts=0 lastEventReason=none');
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

  it('persists the previous ref as an override and reruns bootstrap without writing the cluster', () => {
    const env = setup(healthy, 'tag=v2.0.0\ntag=v1.0.0\n');
    const run = spawnSync(process.execPath, [cli, 'doctor', '--repin', 'previous'], { env: env.env, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(JSON.parse(readFileSync(join(env.dir, 'platform-override'), 'utf8'))).toEqual({ ref: 'tag=v1.0.0', configuredRef: 'tag=v2.0.0' });
    expect(existsSync(env.calls) ? readFileSync(env.calls, 'utf8') : '').toBe('');
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
