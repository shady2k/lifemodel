/** Operator snippets are reviewed instructions, not a cluster simulation.
 * These contract checks protect ordering and fail-closed guards in the shipped walk.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runbook = readFileSync('deploy/platform/storage-recovery.md', 'utf8');
function section(start: string, end: string): string {
  const from = runbook.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const to = runbook.indexOf(end, from + start.length);
  expect(to, end).toBeGreaterThan(from);
  return runbook.slice(from, to);
}
function ordered(text: string, ...steps: string[]): void {
  let previous = -1;
  for (const step of steps) {
    const at = text.indexOf(step, previous + 1);
    expect(at, step).toBeGreaterThan(previous);
    previous = at;
  }
}
const guard = section('cat >"$WORK/cold-guard.py"', '# EndpointSlice membership');
const endpoints = section('cat >"$WORK/storage-endpoints.py"', 'Use the following Python block');
const helpers = section(`python3 - <<'PY' 2>"$WORK/helpers.err"`, 'If a Job/image cannot run');
const recovery = section(`python3 - <<'PY' 2>"$WORK/recovery-job.err"`, 'RECOVERY_POD=$(');

describe('storage recovery runbook safety contracts', () => {
  it('copies destination policy into the fresh helper before artifact verification', () => {
    const destination = section('Stage the trusted archive', 'record trusted-manifest-hash');
    ordered(
      destination,
      'cat >/work/policy.json',
      'record destination-policy-copy',
      'test "$rc" = 0 || return 1',
      'lifemodel-storage-recovery verify /work/artifact /work/policy.json'
    );
    expect(destination).toContain('<"$WORK/policy.json"');
  });
  it('observes the suspended parent idle before suspending children, then checks all reconcilers', () => {
    expect(guard).toContain("obj['spec'].get('suspend') is not True");
    expect(guard).toContain("c['type']=='Reconciling' and c['status']!='False'");
    expect(guard).toContain("obj['metadata']['generation']");
    expect(guard).toContain('json.dumps(status,sort_keys=True)');
    expect(guard).toContain('current==previous');
    expect(guard).toContain("raise RuntimeError('flux_not_quiescent')");
    ordered(
      helpers,
      "with (w/'prior.json').open('x')",
      "for names in [['platform'],['platform-a','platform-d']]",
      "'patch','kustomization'",
      "guard['await_flux'](names)",
      "guard['await_flux'](guard['FLUX'])",
      "'scale','statefulset/seaweedfs','--replicas=0'",
      "'wait','--for=delete','pod'",
      "guard['cold_guard']()",
      "job('storage-recovery-fs'",
      "guard['cold_guard'](get('job','storage-recovery-fs'))"
    );
  });

  it('refuses every unexpected PVC user and permits only the exact single helper owner UID', () => {
    expect(guard).toContain("'get','pods','-o','json'");
    expect(guard).toContain("get('claimName')==CLAIM");
    expect(guard).toContain("owners[0]['uid']==allowed_job['metadata']['uid']");
    expect(guard).toContain("not pod['metadata'].get('deletionTimestamp')");
    expect(guard).toContain("raise RuntimeError('pvc_has_unexpected_user')");
    expect(guard).toContain('allowed_count!=1');
    expect(guard).not.toContain("get('phase')");
    ordered(
      guard,
      'def cold_guard(',
      'await_flux(FLUX)',
      "get('statefulset','seaweedfs')['spec'].get('replicas',1)!=0",
      'no_pvc_users(allowed_job)',
      'flux_observation(name)'
    );
  });

  it('rechecks the cold cut around backup and immediately before destructive promotion', () => {
    ordered(
      runbook,
      'record backup-cold-guard',
      'lifemodel-storage-recovery sanitize',
      'lifemodel-storage-recovery build',
      'record backup-cut-recheck',
      'fs tar -C /work/artifact'
    );
    const promotion = section('record stage-cold-guard', 'All renames above remain');
    ordered(
      promotion,
      'lifemodel-storage-recovery stage',
      'python3 "$WORK/cold-guard.py" fs',
      'record promote-cold-guard',
      'test "$rc" = 0 || return 1',
      'fs node -e'
    );
    const remount = section(`python3 - <<'PY' 2>"$WORK/remount.err"`, 'record writable-remount');
    ordered(
      remount,
      "'delete','job','storage-recovery-fs','--cascade=foreground'",
      "guard['cold_guard']()",
      "k('create'"
    );
  });

  it('gives the offline Job no Service-selected labels, listener ports, probes or inbound route', () => {
    expect(recovery).toContain(
      "template['metadata']={'labels':{'lifemodel-recovery':'storage-recovery-module'}}"
    );
    expect(recovery).toContain("container.pop('ports',None)");
    expect(recovery).toContain("container['command']=['sleep','3600']");
    for (const probe of ['readinessProbe', 'livenessProbe', 'startupProbe']) {
      expect(recovery).toContain(`container.pop('${probe}',None)`);
    }
    expect(recovery).toContain(
      "policy('storage-recovery-module-egress','lifemodel-system',selector,ingress=[],egress=egress)"
    );
    expect(recovery).toContain(
      "ingress=[{'from':[peer('lifemodel-system',selector['matchLabels'])],'ports':[tcp(port)]}]"
    );
    expect(recovery).toContain("('lifemodel-state',{'cnpg.io/cluster':'lifemodel'},5432)");
    expect(recovery).not.toContain("'port':6443");
    expect(recovery).not.toContain("'app.kubernetes.io/name':'storage-module'");
  });

  it('removes and waits for the offline Job before starting the real module and API checks', () => {
    const release = section('record release-restore', 'For degraded release');
    ordered(
      release,
      'delete job storage-recovery-module --cascade=foreground --wait=true',
      'record recovery-remove',
      'test "$rc" = 0 || return 1',
      'wait --for=delete pod -l job-name=storage-recovery-module',
      'record recovery-pods-removed',
      'test "$rc" = 0 || return 1',
      'python3 "$WORK/storage-endpoints.py" empty',
      'scale deploy/storage-module --replicas=1',
      'rollout status deploy/storage-module',
      'python3 "$WORK/storage-endpoints.py" serving',
      'record serving-endpoints'
    );
    expect(recovery).toContain('python3 "$WORK/storage-endpoints.py" empty');
  });

  it('checks EndpointSlices against ready Pods owned by the actual Deployment, not labels alone', () => {
    expect(endpoints).toContain(
      "get('endpointslices','-l','kubernetes.io/service-name=storage-module')"
    );
    expect(endpoints).toContain(
      "o['uid']==deployment['metadata']['uid'] and o['kind']=='Deployment'"
    );
    expect(endpoints).toContain("o['uid'] in allowed_rs and o['kind']=='ReplicaSet'");
    expect(endpoints).toContain("if mode=='empty': return False");
    expect(endpoints).toContain("target.get('uid') not in allowed");
    expect(endpoints).toContain("raise RuntimeError('unexpected_storage_endpoint')");
    expect(endpoints).toContain("get('ready') is not True");
    expect(endpoints).toContain('bool(targets) and targets==allowed');
  });
});
