import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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
  const env = { ...process.env, LIFEMODEL_KUBECTL: 'kubectl', LIFEMODEL_HISTORY: historyPath, PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
    FAKE_KUBECTL_CALLS: calls, FAKE_KUBECTL_INPUT: input, FAKE_KUBECTL_RESPONSES: data };
  return { dir, calls, input, env };
}

const healthy = {
  ocirepositories: { items: [{ metadata: { name: 'platform' }, status: { conditions: [{ type: 'Ready', status: 'True', reason: 'Succeeded', message: 'stored artifact' }], artifact: { revision: 'sha256:root' } } }] },
  gitrepositories: { items: [{ metadata: { name: 'apps' }, status: { conditions: [{ type: 'Ready', status: 'True', reason: 'Succeeded', message: 'stored source' }], artifact: { revision: 'main@sha1:abc' } } }] },
  kustomizations: { items: [{ metadata: { name: 'platform', namespace: 'flux-system' }, status: { conditions: [{ type: 'Ready', status: 'True', reason: 'ReconciliationSucceeded', message: 'Applied revision' }], lastAppliedRevision: 'sha256:root' } }] },
  deployments: { items: [{ metadata: { name: 'loader' }, status: { readyReplicas: 1, replicas: 1 } }] },
  pods: { items: [{ metadata: { name: 'loader-abc', labels: { app: 'loader' } }, status: { phase: 'Running', containerStatuses: [{ restartCount: 0, ready: true }] } }] },
  events: { items: [] },
};

describe('lifemodel doctor', () => {
  it('reports ready Flux resources and loader state with exit zero', () => {
    const env = setup(healthy);
    const run = spawnSync(process.execPath, [cli, 'doctor'], { env: env.env, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('OCIRepository/platform Ready=True reason=Succeeded message=stored artifact revision=sha256:root');
    expect(run.stdout).toContain('GitRepository/apps Ready=True');
    expect(run.stdout).toContain('Kustomization/platform Ready=True');
    expect(run.stdout).toContain('Pod/loader-abc phase=Running ready=yes restarts=0');
    expect(run.stdout).toContain('Deployment/loader ready=yes restarts=0 lastEventReason=none');
  });

  it('allows no GitRepository before the first loader start', () => {
    const beforeFirstStart = structuredClone(healthy);
    beforeFirstStart.gitrepositories.items = [];
    const env = setup(beforeFirstStart);
    const run = spawnSync(process.execPath, [cli, 'doctor'], { env: env.env, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('GitRepository: none (expected before the first start)');
    expect(run.stderr).toBe('');
  });

  it('names an existing non-ready GitRepository and exits non-zero', () => {
    const bad = structuredClone(healthy);
    bad.gitrepositories.items[0].status.conditions[0] = { type: 'Ready', status: 'False', reason: 'FetchFailed', message: 'source unavailable' };
    const env = setup(bad);
    const run = spawnSync(process.execPath, [cli, 'doctor'], { env: env.env, encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('GitRepository/apps Ready=False reason=FetchFailed message=source unavailable');
    expect(run.stderr).toContain('Not ready: GitRepository/apps');
  });

  it('names a failing Kustomization and exits non-zero', () => {
    const bad = structuredClone(healthy);
    bad.kustomizations.items[0].status.conditions[0] = { type: 'Ready', status: 'False', reason: 'BuildFailed', message: 'bad path' };
    const env = setup(bad);
    const run = spawnSync(process.execPath, [cli, 'doctor'], { env: env.env, encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('Kustomization/platform Ready=False reason=BuildFailed message=bad path');
    expect(run.stderr).toContain('Not ready: Kustomization/platform');
  });

  it('re-pins exactly the recorded previous ref and requests a Flux reconcile', () => {
    const env = setup(healthy, 'tag=v2.0.0\ntag=v1.0.0\n');
    const run = spawnSync(process.execPath, [cli, 'doctor', '--repin', 'previous'], { env: env.env, encoding: 'utf8' });
    expect(run.status).toBe(0);
    const calls = readFileSync(env.calls, 'utf8').trim().split('\n');
    expect(calls).toContain('apply --server-side --field-manager=lifemodel-doctor --force-conflicts -f -');
    expect(readFileSync(env.input, 'utf8')).toContain('\"ref\":{\"tag\":\"v1.0.0\"}');
    expect(calls.some((call) => call.startsWith('patch '))).toBe(false);
    expect(calls.some((call) => call.startsWith('annotate ocirepository platform -n flux-system reconcile.fluxcd.io/requestedAt='))).toBe(true);
  });

  it('records each successfully applied ref and keeps the prior distinct ref', () => {
    const env = setup(healthy);
    for (const ref of ['tag=v1.0.0', 'digest=sha256:two', 'digest=sha256:two']) {
      const run = spawnSync(process.execPath, [cli, 'record-applied', ref], { env: env.env, encoding: 'utf8' });
      expect(run.status).toBe(0);
    }
    expect(readFileSync(join(env.dir, 'history'), 'utf8')).toBe('digest=sha256:two\ntag=v1.0.0\n');
  });

  it('refuses re-pin when history has no previous release', () => {
    const env = setup(healthy, 'tag=v1.0.0\n');
    const run = spawnSync(process.execPath, [cli, 'doctor', '--repin', 'previous'], { env: env.env, encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('No previous platform release is recorded');
    expect(existsSync(env.calls) ? readFileSync(env.calls, 'utf8') : '').not.toContain('patch ');
  });
});
