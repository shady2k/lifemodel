# Storage-set recovery and coordinator VM walk

Task: lifemodel-653.7.4. See [the design](../../docs/features/motor/storage-restore.md)
and [ADR-015 S-D7/S09](../../docs/adr/015-storage-module.md).
This is an **operator procedure**, not an automatic backup or an acceptance record.
The worker has not run it on a VM. Run it first on disposable source/destination
instances. Do not run it against a production catalog that contains task output.

## Safety contract and stop points

- This set contains the `storage` schema and a sanitized, **cold** Seaweed tree.
  It does not contain `task_access`, core Postgres, Valkey, Bao, Gitea, task Jobs,
  tokens, platform Secrets or source S3 credentials. Use fresh destination custody.
- Disable task launch for the entire maintenance window. Stop the core and any
  other task lifecycle writer before catalog import. The storage hold is not a
  whole-instance fence. Record their previous replica/suspend state privately.
- A0 → A → B → C → D remains the install order. These operator Jobs are not part
  of bootstrap, and add no Role, RoleBinding or standing cluster mutation RBAC.
  Only the operator's kubeconfig scales workloads or creates/removes helpers.
- Backup hold blocks new writes and **all** retention passes. It does not itself
  block authorized reads. Cold backend stop does interrupt reads. Restore hold
  stays fail-closed until reconcile and explicit release.
- Reconcile inventories private residue and expired attempts, validates state,
  and accounts orphan debt. It **does not DELETE under hold**. Existing GC runs
  after release with its ownership checks and at least two days' grace. Do not
  edit timestamps to make this drill finish sooner.
- A missing/corrupt version retains marks and charges and remains unavailable.
  Never force-release an unverified restore. Clean release refuses unavailable
  versions. Explicit degraded acceptance is
  `lifemodel-storage-recovery release-degraded GENERATION EXACT_UNAVAILABLE_COUNT`.
  Use only the exact completed reconcile count. A mismatch refuses. This is not
  a clean S09 success.
- No disk-loss RPO/RTO promise. Copy the verified artifact outside the node's
  failure domain, over authenticated encrypted transport to owner-controlled
  encrypted storage. Record backup age and restore duration, not an SLA.
- Use a private operator directory, `umask 077`, no `set -x`, and no CI upload.
  Payloads and evidence contain personal data. User object content can itself
  contain secrets. “Secret-free” means no platform custody material is added.
  Never print a Secret, environment, response body, SQL error, backend key or
  connection string. Logs below go to private files. Publish only safe counts,
  codes, generations and exit statuses. Layout proof is names/type/action only.

### Tested pinned layout and required independent Seaweed proof

The repository ships [storage-seaweed-layout.json](storage-seaweed-layout.json),
with layout/compatibility only, for
`chrislusf/seaweedfs@sha256:aba492e2a4e4c90bff795745e8e660affa1f09e7650f5981bd7bccd1a06cd931`.
Its exact paths and fully anchored patterns are checked against the coordinator's
125-entry names-only fresh-install inventory in
`tests/fixtures/seaweed-mini-layout-names.txt` and the 128-entry seeded inventory in
`tests/fixtures/seaweed-mini-layout-names-seeded.txt`.
Collection volumes such as `lifemodel-storage_2.dat`, `.idx` and `.vif` appear at the
volume root once data is written.
This is a tested names policy, not
proof of arbitrary PVC history or a completed restore walk. Do not broaden it to
`^.*$`. An unexpected path still stops the copy.

After the operator shell setup below defines `WORK`, `POLICY` and `record`,
create private `policy.json` from this tracked file. Set `moduleBuild` to the
verified installed build; verify `schemaVersion` against the installed migration
version (0016 or the matching approved revision). Add your own attestation only
after independent history and metadata checks. Never take policy from an archive:

```bash
python3 - <<'PY'
import json,os
from pathlib import Path
p=json.loads(Path('deploy/platform/storage-seaweed-layout.json').read_text())
p['compatibility']['moduleBuild']=os.environ['MODULE_BUILD']
p['attestation']=json.loads(Path(os.environ['ATTESTATION_FILE']).read_text())
with Path(os.environ['POLICY']).open('x') as f: json.dump(p,f,indent=2)
PY
rc=$?; record trusted-policy "$rc"; test "$rc" = 0 || return 1
```

Set `MODULE_BUILD` and `ATTESTATION_FILE` privately before this step. The latter
contains exactly this shape, with a private evidence reference and booleans backed
by the checks, not values copied just to bypass the gate:

```json
{
  "evidence": "PRIVATE_PROOF_RECORD_ID",
  "coldStopped": true,
  "freshModuleOnlyNeverIamNeverSse": true,
  "filerKekAbsent": true,
  "dynamicIamAbsent": true,
  "bucketEncryptionAbsent": true,
  "encryptedObjectsAbsent": true
}
```

A names-only inventory cannot prove credential absence in old database logs or
volume bytes. Establish never-IAM/never-SSE, no filer KEK, no bucket default
encryption, no encrypted object dependency and no dynamic IAM before stopping
the source, with reviewed tooling. There is no built-in `prove-no-secrets`
command. If that evidence cannot be established, **stop**.

`layout` emits names/type/action only. `sanitize` never opens or copies excluded
files. It excludes `.mini_kek_passphrase`, `.mini_sse_kek`, `mini.options` and the
entire `admin/` subtree (including secret `admin/.session_key` and plugin job
state). Destination Seaweed regenerates these on startup from its own custody
and configuration. The destination does not inherit admin sessions or plugin
schedules/history. The coordinator's destination walk must verify regeneration.
Only the audited exact top-level `admin` subtree may be excluded by policy;
required/copied paths and volume/filer/master data cannot be excluded. The session
key can never be copied, even under an attempted allowlist. Links and special
files still fail closed. Unknown config, IAM/KEK/SSE dependency or reused-history
ambiguity means **unsupported**, not permission to copy keys.

## Instance TLS profile and existing test installs

The loader's CA already had Subject Key Identifier (SKI). Both edge and storage
leaves now include SKI and Authority Key Identifier (AKI), with AKI equal to that
CA's SKI, so strict RFC 5280 clients (including Python 3.13 defaults) accept them.
Loader bootstrap reissues old leaves missing identifiers under the same valid CA;
restart/reload the serving workloads to use the updated Secrets before the walk.
An installed CA missing SKI fails closed as an invalid required profile. It is not
automatically rotated or accepted through a compatibility shim. Reprovision a
disposable test VM with fresh custody if it has such a CA; do not delete identity
or CA files on a live instance to force rotation. CA/identity replacement for live
instances is outside this storage-set procedure.

## Operator shell and temporary helpers

Commands in this runbook use Bash, Python 3, kubectl and a checkout of this
revision. The Python API driver uses only the standard library (Python 3.12+ for the
operator archive extraction below). Its SQL checks
need PostgreSQL 17 `psql` and fixed `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`
and private `PGPASSFILE`; never put passwords in argv. Run the driver on a
coordinator VM with a reviewed TLS route to each listener and database access
(or private port forwards). `kubectl port-forward` can exit after a connection
reset; each closed psql connection did so in the VM walk. Run each database,
task/control/read and S3 forward in a restarting loop (see the S3 example below),
wait for its listening message before a request, and stop the loop with Ctrl-C
after the walk. A restarted forward does not retry a failed write: inspect its
receipt before explicitly retrying. It must reach source task/control/read listeners
using their actual live identities, not a helper token claimed to be a task.

Use one context at a time. Substitute only the operator paths/context names:

```bash
umask 077
export KUBECONFIG=/owner-private/source.kubeconfig
export WORK=/owner-private/storage-s09
mkdir -m 700 "$WORK"
# Save the coordinator-approved policy here; never construct it from the archive.
export POLICY="$WORK/policy.json"
# All helper commands' stderr is private. Do not cat these logs on failure.
exec 3>>"$WORK/command-status.jsonl"
record() { printf '{"step":"%s","exit":%s}\n' "$1" "$2" >&3; }
# Do not use a pipeline to report a gate's status. Each status is the command's own.
```

Save these reusable checks as `$WORK/cold-guard.py` and
`$WORK/storage-endpoints.py`. The cold guard waits for two matching
observations with no active/unknown `Reconciling` condition; the complete status
(including `lastAttemptedRevision`) and generation must stay stable. Suspension
alone is not evidence of a finished reconcile. A resumed parent/child, an active
reconcile or any unexpected PVC user stops the procedure. Use exclusive operator
control throughout: no other actor may resume Flux, scale workloads or create
PVC users during copy/promotion. The guard is an observed controller cut, not a
PVC lock. A `ReadWriteOnce` claim permits multiple Pods on the same node.

```bash
cat >"$WORK/cold-guard.py" <<'PY'
import json, subprocess, time
FLUX=['platform','platform-a','platform-d']
NAMESPACE='lifemodel-system'
CLAIM='data-seaweedfs-0'
def k(*args, data=None):
    r=subprocess.run(['kubectl',*args],input=data,capture_output=True,check=False,timeout=180)
    if r.returncode: raise RuntimeError('quiescence_kubectl_failed')
    return r.stdout
def get(kind,name,ns=NAMESPACE):
    return json.loads(k('-n',ns,'get',kind,name,'-o','json'))
def flux_observation(name):
    obj=get('kustomization.kustomize.toolkit.fluxcd.io',name,'flux-system')
    if obj['spec'].get('suspend') is not True: raise RuntimeError('flux_not_suspended')
    status=obj.get('status',{})
    if any(c['type']=='Reconciling' and c['status']!='False' for c in status.get('conditions',[])):
        return None
    return (obj['metadata']['uid'],obj['metadata']['generation'],
            json.dumps(status,sort_keys=True))
def await_flux(names):
    deadline=time.monotonic()+180
    previous=None
    while time.monotonic()<deadline:
        current=[flux_observation(name) for name in names]
        if all(x is not None for x in current) and current==previous: return
        previous=current
        time.sleep(2)
    raise RuntimeError('flux_not_quiescent')
def no_pvc_users(allowed_job=None):
    # Check all Pods, including Pending/Terminating/terminal ones: RWO is not a fence.
    pods=json.loads(k('-n',NAMESPACE,'get','pods','-o','json'))['items']
    allowed_count=0
    for pod in pods:
        if not any(v.get('persistentVolumeClaim',{}).get('claimName')==CLAIM
                   for v in pod['spec'].get('volumes',[])): continue
        owners=pod['metadata'].get('ownerReferences',[])
        allowed=(allowed_job is not None and len(owners)==1 and owners[0]['kind']=='Job'
                 and owners[0]['name']==allowed_job['metadata']['name']
                 and owners[0]['uid']==allowed_job['metadata']['uid']
                 and not pod['metadata'].get('deletionTimestamp'))
        if not allowed: raise RuntimeError('pvc_has_unexpected_user')
        allowed_count+=1
    if allowed_job is not None and allowed_count!=1: raise RuntimeError('pvc_helper_not_exclusive')
def cold_guard(allowed_job=None):
    await_flux(FLUX)
    if get('statefulset','seaweedfs')['spec'].get('replicas',1)!=0:
        raise RuntimeError('backend_not_stopped')
    no_pvc_users(allowed_job)
    # Re-read after Pod inventory; a racing parent must not silently resume a child.
    if any(flux_observation(name) is None for name in FLUX):
        raise RuntimeError('flux_not_quiescent')
if __name__=='__main__':
    import sys
    if len(sys.argv)!=2 or sys.argv[1] not in ['none','fs']: raise RuntimeError('invalid_guard_mode')
    cold_guard(get('job','storage-recovery-fs') if sys.argv[1]=='fs' else None)
PY
# EndpointSlice membership is checked before/after the offline Job and real start.
cat >"$WORK/storage-endpoints.py" <<'PY'
import json,subprocess,sys,time
mode=sys.argv[1]
if mode not in ['empty','serving']: raise RuntimeError('invalid_endpoint_mode')
def get(kind,*args):
    r=subprocess.run(['kubectl','-n','lifemodel-system','get',kind,*args,'-o','json'],
                     capture_output=True,timeout=30)
    if r.returncode: raise RuntimeError('endpoint_query_failed')
    return json.loads(r.stdout)
def check():
    deployment=get('deployment','storage-module')
    replicasets=get('replicasets')['items']; allowed_rs={r['metadata']['uid'] for r in replicasets
        if any(o['uid']==deployment['metadata']['uid'] and o['kind']=='Deployment'
               for o in r['metadata'].get('ownerReferences',[]))}
    pods=get('pods')['items']; allowed={p['metadata']['uid'] for p in pods
        if any(o['uid'] in allowed_rs and o['kind']=='ReplicaSet'
               for o in p['metadata'].get('ownerReferences',[]))
        and not p['metadata'].get('deletionTimestamp')
        and any(c['type']=='Ready' and c['status']=='True' for c in p.get('status',{}).get('conditions',[]))}
    slices=get('endpointslices','-l','kubernetes.io/service-name=storage-module')['items']
    targets=set()
    for item in slices:
        for e in item.get('endpoints',[]):
            target=e.get('targetRef',{})
            if mode=='empty': return False
            # Even an unready/non-serving helper endpoint must not be advertised.
            if target.get('kind')!='Pod' or target.get('uid') not in allowed:
                raise RuntimeError('unexpected_storage_endpoint')
            if e.get('conditions',{}).get('ready') is not True or e.get('conditions',{}).get('terminating'):
                return False
            targets.add(target['uid'])
    return not targets if mode=='empty' else bool(targets) and targets==allowed
deadline=time.monotonic()+120
while time.monotonic()<deadline:
    if check(): break
    time.sleep(2)
else: raise RuntimeError('storage_endpoints_not_settled')
PY
```

Use the following Python block in the operator shell to save prior state,
suspend and await the parent **before** suspending/awaiting A and D, stop
Seaweed, confirm no Pod mounts the claim, create two bounded helper Jobs and
open the **two sides** of only the SQL route. It refuses an existing helper.
The fs helper mounts no Secret or service account token. The SQL helper mounts
only `username` and `password` as env refs from
`storage-module-db-credentials`; it mounts no Seaweed PVC or S3 identity.
The pinned PostgreSQL 17 image is the platform's CNPG pin. The loader image is
resolved from the running deployment, must be digest-pinned, and must carry
`lifemodel-storage-recovery` from this change. Jobs die after one hour; no
TTL auto-deletes failure evidence.

**Before this block:** begin the hold while the module still runs:

```bash
kubectl -n lifemodel-system exec deploy/storage-module -- \
  lifemodel-storage-recovery begin s09-backup >"$WORK/hold.json" 2>"$WORK/hold.err"
rc=$?; record begin "$rc"; test "$rc" = 0 || return 1
# In a non-interactive script use exit, not return, at every stop below.
python3 -c 'import json,os; from pathlib import Path; p=Path(os.environ["WORK"]); h=json.loads((p/"hold.json").read_text()); assert h["state"]=="held"; (p/"generation").write_text(h["generation"]+"\n")'
rc=$?; record hold-receipt "$rc"; test "$rc" = 0 || return 1
```

```bash
python3 - <<'PY' 2>"$WORK/helpers.err"
import json, os, re, runpy
from pathlib import Path
w=Path(os.environ['WORK'])
guard=runpy.run_path(str(w/'cold-guard.py'))
k=guard['k']; get=guard['get']
def apply(obj): k('apply','-f','-',data=json.dumps(obj).encode())
prior={'flux':{},'replicas':{}}
for name in guard['FLUX']:
    prior['flux'][name]=get('kustomization.kustomize.toolkit.fluxcd.io',name,'flux-system')['spec'].get('suspend',False)
for kind,name in [('statefulset','seaweedfs'),('deployment','storage-module')]:
    prior['replicas'][kind+'/'+name]=get(kind,name)['spec'].get('replicas',1)
# Save before the first mutation so interrupted suspension remains recoverable.
with (w/'prior.json').open('x') as f: json.dump(prior,f)
for names in [['platform'],['platform-a','platform-d']]:
    for name in names:
        k('-n','flux-system','patch','kustomization',name,'--type=merge','-p','{"spec":{"suspend":true}}')
    guard['await_flux'](names)
guard['await_flux'](guard['FLUX'])
image=get('deployment','storage-module')['spec']['template']['spec']['containers'][0]['image']
assert re.search(r'@sha256:[0-9a-f]{64}$',image)
(w/'module-image').write_text(image+'\n')
k('-n','lifemodel-system','scale','statefulset/seaweedfs','--replicas=0')
k('-n','lifemodel-system','wait','--for=delete','pod','-l','app.kubernetes.io/name=seaweedfs','--timeout=120s')
guard['cold_guard']()
# All Flux reconcilers are observed idle; no Pod mounts the PVC before admission.
base={'automountServiceAccountToken':False,'restartPolicy':'Never',
      'securityContext':{'runAsNonRoot':True,'runAsUser':1000,'runAsGroup':1000,'fsGroup':1000,
                         'seccompProfile':{'type':'RuntimeDefault'}}}
security={'readOnlyRootFilesystem':True,'allowPrivilegeEscalation':False,'capabilities':{'drop':['ALL']}}
def job(name,container,volumes):
    pod={**base,'containers':[{**container,'securityContext':security}], 'volumes':volumes}
    obj={'apiVersion':'batch/v1','kind':'Job','metadata':{'name':name,'namespace':'lifemodel-system'},
         'spec':{'backoffLimit':0,'activeDeadlineSeconds':3600,
                 'template':{'metadata':{'labels':{'lifemodel-recovery':name}},'spec':pod}}}
    # create, not apply: never adopt a leftover import or erase its evidence.
    k('create','-f','-',data=json.dumps(obj).encode())
job('storage-recovery-fs',{'name':'tool','image':image,'command':['sleep','3600'],
    'resources':{'requests':{'cpu':'50m','memory':'128Mi'},'limits':{'cpu':'1','memory':'512Mi'}},
    'volumeMounts':[{'name':'data','mountPath':'/data','readOnly':True},{'name':'work','mountPath':'/work'},
                    {'name':'tmp','mountPath':'/tmp'}]},
    [{'name':'data','persistentVolumeClaim':{'claimName':'data-seaweedfs-0','readOnly':True}},
     {'name':'work','emptyDir':{'sizeLimit':'16Gi'}},{'name':'tmp','emptyDir':{'sizeLimit':'32Mi'}}])
pg='ghcr.io/cloudnative-pg/postgresql:17-standard-bookworm@sha256:fe22b9fcd038dcd08c2019b17d95f517f137801e5f39d857a895d65e8c63033b'
job('storage-recovery-sql',{'name':'tool','image':pg,'command':['sleep','3600'],
    'env':[{'name':'PGHOST','value':'lifemodel-rw.lifemodel-state.svc.cluster.local'},
           {'name':'PGPORT','value':'5432'},{'name':'PGDATABASE','value':'lifemodel'},
           *[{'name':env,'valueFrom':{'secretKeyRef':{'name':'storage-module-db-credentials','key':key}}}
             for env,key in [('PGUSER','username'),('PGPASSWORD','password')]]],
    'resources':{'requests':{'cpu':'50m','memory':'128Mi'},'limits':{'cpu':'1','memory':'512Mi'}},
    'volumeMounts':[{'name':'work','mountPath':'/work'},{'name':'tmp','mountPath':'/tmp'}]},
    [{'name':'work','emptyDir':{'sizeLimit':'2Gi'}},{'name':'tmp','emptyDir':{'sizeLimit':'32Mi'}}])
selector={'matchLabels':{'lifemodel-recovery':'storage-recovery-sql'}}
apply({'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy',
       'metadata':{'name':'storage-recovery-sql-egress','namespace':'lifemodel-system'},
       'spec':{'podSelector':selector,'policyTypes':['Ingress','Egress'],'ingress':[],
               'egress':[{'to':[{'namespaceSelector':{'matchLabels':{'kubernetes.io/metadata.name':'lifemodel-state'}},
                                  'podSelector':{'matchLabels':{'cnpg.io/cluster':'lifemodel'}}}],
                          'ports':[{'protocol':'TCP','port':5432}]},
                         {'to':[{'namespaceSelector':{'matchLabels':{'kubernetes.io/metadata.name':'kube-system'}},
                                  'podSelector':{'matchLabels':{'k8s-app':'kube-dns'}}}],
                          'ports':[{'protocol':'UDP','port':53},{'protocol':'TCP','port':53}]}]}})
apply({'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy',
       'metadata':{'name':'storage-recovery-sql-ingress','namespace':'lifemodel-state'},
       'spec':{'podSelector':{'matchLabels':{'cnpg.io/cluster':'lifemodel'}},'policyTypes':['Ingress'],
               'ingress':[{'from':[{'namespaceSelector':{'matchLabels':{'kubernetes.io/metadata.name':'lifemodel-system'}},
                                    'podSelector':selector}], 'ports':[{'protocol':'TCP','port':5432}]}]}})
for name in ['storage-recovery-fs','storage-recovery-sql']:
    k('-n','lifemodel-system','wait','--for=condition=Ready','pod','-l','job-name='+name,'--timeout=120s')
guard['cold_guard'](get('job','storage-recovery-fs'))
PY
rc=$?; record helpers "$rc"; test "$rc" = 0 || return 1
fs() { kubectl -n lifemodel-system exec job/storage-recovery-fs -- "$@"; }
sql() { kubectl -n lifemodel-system exec job/storage-recovery-sql -- "$@"; }
fsi() { kubectl -n lifemodel-system exec -i job/storage-recovery-fs -- "$@"; }
sqli() { kubectl -n lifemodel-system exec -i job/storage-recovery-sql -- "$@"; }
```

If a Job/image cannot run under restricted Pod security, or the scratch budget
is insufficient, stop and record it. Do not make it privileged, mount a host
path, copy source credentials, or fall back to live PVC copy. The fs helper
inherits namespace default-deny; it needs no network route. Its `emptyDir` is
not a durable backup: export the verified set before deleting the Job.

## Backup at one exported SQL snapshot

Copy trusted policy to the fs helper, take the names-only verdict, then sanitize.
Do not archive raw `/data`. Stderr stays private even on an unsupported layout.

```bash
python3 "$WORK/cold-guard.py" fs 2>"$WORK/backup-cold-guard.err"
rc=$?; record backup-cold-guard "$rc"; test "$rc" = 0 || return 1
fsi sh -c 'umask 077; cat > /work/policy.json' <"$POLICY" 2>"$WORK/policy-copy.err"
rc=$?; record policy-copy "$rc"; test "$rc" = 0 || return 1
fs lifemodel-storage-recovery layout /data /work/policy.json >"$WORK/layout.json" 2>"$WORK/layout.err"
rc=$?; record layout "$rc"; test "$rc" = 0 || return 1
# layout.json is the names/type/action proof. Inspect privately; no file contents/hashes.
fs sh -c 'umask 077; mkdir -m 700 /work/artifact' 2>"$WORK/mkdir.err"
rc=$?; record artifact-directory "$rc"; test "$rc" = 0 || return 1
fs lifemodel-storage-recovery sanitize /data /work/artifact/seaweed /work/policy.json >"$WORK/sanitize.json" 2>"$WORK/sanitize.err"
rc=$?; record sanitize "$rc"; test "$rc" = 0 || return 1
```

Create this **local** SQL file at `$WORK/backup.sql` (not inside the artifact):

```sql
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT pg_export_snapshot() \g /work/snapshot
SELECT json_build_object(
  'sqlCutAt',to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'schemaVersion',(SELECT max(version) FROM public.schema_migrations),
  'generation',(SELECT generation FROM storage.maintenance WHERE id AND state='held' AND purpose='backup'),
  'counts',json_build_object(
    'liveObjects',(SELECT count(*) FROM storage.objects o WHERE NOT EXISTS(SELECT 1 FROM storage.object_tombstones t WHERE t.object_id=o.id) AND NOT EXISTS(SELECT 1 FROM storage.retention_tombstones t WHERE t.object_id=o.id)),
    'liveLogicalBytes',(SELECT COALESCE(sum(size),0) FROM storage.objects o WHERE NOT EXISTS(SELECT 1 FROM storage.object_tombstones t WHERE t.object_id=o.id) AND NOT EXISTS(SELECT 1 FROM storage.retention_tombstones t WHERE t.object_id=o.id)),
    'tombstonedVersions',(SELECT count(*) FROM storage.objects o WHERE EXISTS(SELECT 1 FROM storage.object_tombstones t WHERE t.object_id=o.id) OR EXISTS(SELECT 1 FROM storage.retention_tombstones t WHERE t.object_id=o.id)),
    'unavailableVersions',(SELECT count(*) FROM storage.version_availability WHERE status<>'available')))
\g /work/cut.json
-- pg_dump exits independently of psql's \!; save its OWN status, do not trust psql.
\! pg_dump --snapshot="$(tr -d '[:space:]' < /work/snapshot)" --format=custom --schema=storage --no-owner --no-acl --file=/work/catalog.dump 2>/work/dump.err; rc=$?; printf '%s\n' "$rc" > /work/dump.exit
COMMIT;
```

The exporter session stays open until `pg_dump` finishes. Counts and schema
version use **that same snapshot**, not a later `psql` connection. Live count
includes non-tombstoned unavailable objects; the separate unavailable count
prevents calling these healthy. The clean walk expects unavailable zero.

```bash
sqli sh -c 'umask 077; cat >/work/backup.sql' <"$WORK/backup.sql" 2>"$WORK/sql-copy.err"
rc=$?; record sql-copy "$rc"; test "$rc" = 0 || return 1
sql psql --no-psqlrc --quiet --tuples-only --no-align --file=/work/backup.sql >"$WORK/export.out" 2>"$WORK/export.err"
rc=$?; record exporter-psql "$rc"; test "$rc" = 0 || return 1
sql cat /work/dump.exit >"$WORK/dump.exit" 2>"$WORK/dump-status.err"
rc=$?; record dump-status-copy "$rc"; test "$rc" = 0 || return 1
read -r dump_rc <"$WORK/dump.exit"; record pg-dump "$dump_rc"; test "$dump_rc" = 0 || return 1
sql cat /work/catalog.dump >"$WORK/catalog.dump" 2>"$WORK/dump-copy.err"
rc=$?; record dump-copy "$rc"; test "$rc" = 0 || return 1
sql cat /work/cut.json >"$WORK/cut.json" 2>"$WORK/cut-copy.err"
rc=$?; record cut-copy "$rc"; test "$rc" = 0 || return 1
python3 - <<'PY' 2>"$WORK/metadata.err"
import json,os,uuid
from pathlib import Path
w=Path(os.environ['WORK']); policy=json.loads((w/'policy.json').read_text()); cut=json.loads((w/'cut.json').read_text())
assert cut['generation']==(w/'generation').read_text().strip()
assert cut['schemaVersion']==policy['compatibility']['schemaVersion']
assert cut['counts']['unavailableVersions']==0
metadata={**policy['compatibility'],**cut,'backupId':str(uuid.uuid4())}
with (w/'metadata.json').open('x') as f: json.dump(metadata,f)
PY
rc=$?; record metadata "$rc"; test "$rc" = 0 || return 1
fsi sh -c 'umask 077; cat >/work/artifact/catalog.dump' <"$WORK/catalog.dump" 2>"$WORK/dump-stage.err"
rc=$?; record dump-stage "$rc"; test "$rc" = 0 || return 1
fsi sh -c 'umask 077; cat >/work/metadata.json' <"$WORK/metadata.json" 2>"$WORK/metadata-copy.err"
rc=$?; record metadata-copy "$rc"; test "$rc" = 0 || return 1
fs lifemodel-storage-recovery build /work/artifact /work/metadata.json /work/policy.json >"$WORK/build.json" 2>"$WORK/build.err"
rc=$?; record build "$rc"; test "$rc" = 0 || return 1
fs lifemodel-storage-recovery verify /work/artifact /work/policy.json >"$WORK/verify-source.json" 2>"$WORK/verify-source.err"
rc=$?; record verify-source "$rc"; test "$rc" = 0 || return 1
# Recheck after hashing/copy as well: an unexpected user invalidates the cut.
python3 "$WORK/cold-guard.py" fs 2>"$WORK/backup-cut-recheck.err"
rc=$?; record backup-cut-recheck "$rc"; test "$rc" = 0 || return 1
fs tar -C /work/artifact -cf - . >"$WORK/storage-set.tar" 2>"$WORK/export-tar.err"
rc=$?; record export-tar "$rc"; test "$rc" = 0 || return 1
```

Export only the just-built verified tree, **not** `/work`, raw `/data`, SQL helper
env or the policy proof. The archive is trusted owner transport, not a generic
untrusted tar import. Preserve the separate manifest SHA-256 from `build.json`
in trusted owner custody. Independently verify after off-node copying.

Restart source while hold remains. Check authenticated `/status` through the
loader's existing health route/Pod, then release this generation:

On a small node, helper resource requests can leave Seaweed Pending. After all
dump/cut copies and artifact export, remove both helpers **before** backend start.

```bash
kubectl -n lifemodel-system delete job storage-recovery-sql --cascade=foreground --wait=true --timeout=120s >"$WORK/sql-remove.out" 2>"$WORK/sql-remove.err"
rc=$?; record sql-remove "$rc"; test "$rc" = 0 || return 1
kubectl -n lifemodel-system delete job storage-recovery-fs --cascade=foreground --wait=true --timeout=120s >"$WORK/fs-remove.out" 2>"$WORK/fs-remove.err"
rc=$?; record fs-remove "$rc"; test "$rc" = 0 || return 1
kubectl -n lifemodel-system scale statefulset/seaweedfs --replicas=1 >"$WORK/seaweed-start.out" 2>"$WORK/seaweed-start.err"
rc=$?; record seaweed-start "$rc"; test "$rc" = 0 || return 1
kubectl -n lifemodel-system rollout status statefulset/seaweedfs --timeout=180s >"$WORK/seaweed-ready.out" 2>"$WORK/seaweed-ready.err"
rc=$?; record seaweed-ready "$rc"; test "$rc" = 0 || return 1
kubectl -n lifemodel-system rollout status deploy/storage-module --timeout=180s >"$WORK/source-ready.out" 2>"$WORK/source-ready.err"
rc=$?; record source-ready "$rc"; test "$rc" = 0 || return 1
read -r GENERATION <"$WORK/generation"
kubectl -n lifemodel-system exec deploy/storage-module -- lifemodel-storage-recovery release "$GENERATION" >"$WORK/release-source.json" 2>"$WORK/release-source.err"
rc=$?; record release-source "$rc"; test "$rc" = 0 || return 1
```

Use the saved prior replicas, rather than `1`, outside this single-replica drill.
Keep the source stopped/isolated before destination task identity checks. Source
backup success does not authorize stopping a real owner's running Jobs.

## Empty destination, verify before import and promotion

Install the **same signed schema/module/Seaweed versions** into a fresh
instance, through its normal installer. Let A0→A→B→C→D establish fresh Bao
custody and migrations. Do not import Bao or S3 identity. Do not run this against
a reused target. Disable task launch, stop core/lifecycle writers, then switch
`KUBECONFIG` and use a **new** `$WORK` directory. Preserve source evidence elsewhere.
Copy trusted `policy.json`, trusted manifest hash and the verified archive over
authenticated encrypted transport. Run `begin`, helper setup and cold stop above
on the destination. Its freshly installed empty bucket is the only allowed
preexisting layout. Keep the module stopped after this hold:

```bash
kubectl -n lifemodel-system scale deploy/storage-module --replicas=0 >"$WORK/stop-module.out" 2>"$WORK/stop-module.err"
rc=$?; record stop-module "$rc"; test "$rc" = 0 || return 1
kubectl -n lifemodel-system wait --for=delete pod -l app.kubernetes.io/name=storage-module --timeout=120s >"$WORK/stop-module-wait.out" 2>"$WORK/stop-module-wait.err"
rc=$?; record stop-module-wait "$rc"; test "$rc" = 0 || return 1
```

There is no empty-merge import mode in the CLI. Verify SQL emptiness explicitly:
all catalog/user tables must be empty. Only validated boot-only upload-owner
heartbeats, held maintenance and the zero instance ledger are allowed. The shared
SQL gate below is also exercised after a fresh module boot/stop in integration
tests. Run that exact tracked file through the SQL helper (stderr stays private):

```bash
sqli psql --no-psqlrc --set=ON_ERROR_STOP=1 >"$WORK/empty-check.out" 2>"$WORK/empty-check.err" < deploy/platform/storage-empty-target.sql
rc=$?; record empty-check "$rc"; test "$rc" = 0 || return 1
```

The coordinator must also establish pristine install-created PVC history and
names-only layout before replacement. An empty S3 listing is not sufficient
proof of an empty reusable PVC. Retain that attestation privately. If either
emptiness check fails, stop; never delete someone else's catalog/data to pass it.

Stage the trusted archive in fs-helper `/work/artifact`. Extraction below is
operator-side Python's `filter='data'`, with an explicit directory/file-only
check, path traversal rejection, new destination and no links. Python 3.12+ is
needed for that filter. It never extracts onto the live PVC. Then transfer only
the safe extracted tree; verify hashes **before SQL import and PVC promotion**:

```bash
python3 - <<'PY' 2>"$WORK/extract.err"
import os,tarfile
from pathlib import Path,PurePosixPath
w=Path(os.environ['WORK']); target=w/'artifact'; target.mkdir(mode=0o700)
with tarfile.open(w/'storage-set.tar') as tar:
    members=tar.getmembers(); seen=set()
    for m in members:
        p=PurePosixPath(m.name)
        assert not p.is_absolute() and '..' not in p.parts and (m.isdir() or m.isfile())
        assert m.name not in seen; seen.add(m.name)
    tar.extractall(target,filter='data')
for base,dirs,files in os.walk(target):
    os.chmod(base,0o700)
    for name in files: os.chmod(Path(base)/name,0o600)
PY
rc=$?; record extract "$rc"; test "$rc" = 0 || return 1
# Locally create a transport tar from this checked tree, never from arbitrary input.
tar -C "$WORK/artifact" -cf "$WORK/checked.tar" . 2>"$WORK/checked-tar.err"
rc=$?; record checked-tar "$rc"; test "$rc" = 0 || return 1
fs mkdir -m 700 /work/artifact 2>"$WORK/stage-mkdir.err"
rc=$?; record stage-mkdir "$rc"; test "$rc" = 0 || return 1
fsi tar -C /work/artifact -xf - <"$WORK/checked.tar" 2>"$WORK/stage-transfer.err"
rc=$?; record stage-transfer "$rc"; test "$rc" = 0 || return 1
# This destination helper has a fresh /work emptyDir; the source copy is not present.
fsi sh -c 'umask 077; cat >/work/policy.json' <"$WORK/policy.json" 2>"$WORK/destination-policy-copy.err"
rc=$?; record destination-policy-copy "$rc"; test "$rc" = 0 || return 1
fs lifemodel-storage-recovery verify /work/artifact /work/policy.json >"$WORK/verify-destination.json" 2>"$WORK/verify-destination.err"
rc=$?; record verify-destination "$rc"; test "$rc" = 0 || return 1
python3 - <<'PY' 2>"$WORK/trusted-hash.err"
import json,os
from pathlib import Path
w=Path(os.environ['WORK'])
assert json.loads((w/'verify-destination.json').read_text())['manifestSha256']==(w/'trusted-manifest-sha256').read_text().strip()
PY
rc=$?; record trusted-manifest-hash "$rc"; test "$rc" = 0 || return 1
sqli sh -c 'umask 077; cat >/work/catalog.dump' <"$WORK/artifact/catalog.dump" 2>"$WORK/import-copy.err"
rc=$?; record import-copy "$rc"; test "$rc" = 0 || return 1
sql pg_restore --single-transaction --exit-on-error --no-owner --no-acl --clean --if-exists --dbname=lifemodel /work/catalog.dump >"$WORK/import.out" 2>"$WORK/import.err"
rc=$?; record pg-restore "$rc"; test "$rc" = 0 || return 1
```

`--clean --if-exists` replaces only objects in this storage-only archive,
**after** verified emptiness. Do not drop unrelated schemas, change roles or
restore the global migration table. A single full DDL/data/post-data restore
avoids firing accounting triggers over data-only inserts. A failed restore rolls
back its transaction. Leave the target stopped and retain failed staging.

The fs helper above mounted `/data` read-only. Recreate it writable only on
the independently verified empty destination. Save its exact spec, stop it,
remove only API-owned create fields, and change the two mount flags. Do not
change image, Secrets, labels or RBAC. The original artifact remains in owner
custody and is transferred/verified again in the new helper:

```bash
python3 - <<'PY' 2>"$WORK/remount.err"
import json,os,subprocess
from pathlib import Path
w=Path(os.environ['WORK'])
def k(*args,data=None):
    r=subprocess.run(['kubectl',*args],input=data,capture_output=True,timeout=180)
    if r.returncode: raise RuntimeError('remount_failed')
    return r.stdout
job=json.loads(k('-n','lifemodel-system','get','job','storage-recovery-fs','-o','json'))
with (w/'readonly-fs-job.json').open('x') as f: json.dump(job,f)
k('-n','lifemodel-system','delete','job','storage-recovery-fs','--cascade=foreground','--wait=true','--timeout=120s')
import runpy
guard=runpy.run_path(str(w/'cold-guard.py')); guard['cold_guard']()
spec=job['spec']; template=spec['template']
spec.pop('selector',None); spec.pop('manualSelector',None)
template['metadata']={'labels':{'lifemodel-recovery':'storage-recovery-fs'}}
for volume in template['spec']['volumes']:
    if volume['name']=='data': volume['persistentVolumeClaim']['readOnly']=False
for mount in template['spec']['containers'][0]['volumeMounts']:
    if mount['name']=='data': mount['readOnly']=False
new={'apiVersion':'batch/v1','kind':'Job','metadata':{'name':'storage-recovery-fs','namespace':'lifemodel-system'},'spec':spec}
k('create','-f','-',data=json.dumps(new).encode())
k('-n','lifemodel-system','wait','--for=condition=Ready','pod','-l','job-name=storage-recovery-fs','--timeout=120s')
PY
rc=$?; record writable-remount "$rc"; test "$rc" = 0 || return 1
fsi sh -c 'umask 077; cat > /work/policy.json' <"$POLICY" 2>"$WORK/writable-policy.err"
rc=$?; record writable-policy "$rc"; test "$rc" = 0 || return 1
fs mkdir -m 700 /work/artifact 2>"$WORK/writable-stage-mkdir.err"
rc=$?; record writable-stage-mkdir "$rc"; test "$rc" = 0 || return 1
fsi tar -C /work/artifact -xf - <"$WORK/checked.tar" 2>"$WORK/writable-transfer.err"
rc=$?; record writable-transfer "$rc"; test "$rc" = 0 || return 1
fs lifemodel-storage-recovery verify /work/artifact /work/policy.json >"$WORK/verify-writable.json" 2>"$WORK/verify-writable.err"
rc=$?; record verify-writable "$rc"; test "$rc" = 0 || return 1
python3 -c 'import json,os; from pathlib import Path; w=Path(os.environ["WORK"]); assert json.loads((w/"verify-writable.json").read_text())["manifestSha256"]==(w/"trusted-manifest-sha256").read_text().strip()' 2>"$WORK/writable-hash.err"
rc=$?; record writable-hash "$rc"; test "$rc" = 0 || return 1
```

Promote into the stopped target PVC using a new sibling tree. This is a
**verified-empty destination replacement**, not a generic atomic full-root swap.
A mounted PVC root cannot be renamed atomically. Before the command, confirm
that destination SQL/PVC emptiness evidence is saved and trusted artifact has
been verified. If interrupted, retain the hold and rebuild the disposable empty
target or use a coordinator-reviewed resume plan; do not call it empty again.
Only this explicit empty-target import step removes pristine install-created
files. Reconcile itself never deletes under hold.

```bash
python3 "$WORK/cold-guard.py" fs 2>"$WORK/stage-cold-guard.err"
rc=$?; record stage-cold-guard "$rc"; test "$rc" = 0 || return 1
fs lifemodel-storage-recovery stage /work/artifact /data/recovery-stage /work/policy.json >"$WORK/stage.json" 2>"$WORK/stage.err"
rc=$?; record stage-tree "$rc"; test "$rc" = 0 || return 1
# The prepared stage has already been copied and independently hashed by stage.
# All other root entries must still be the previously attested pristine layout.
# Recheck immediately before destructive promotion. The sole allowed PVC user is
# this helper Job's exact UID, not a label that a racing Seaweed Pod might share.
python3 "$WORK/cold-guard.py" fs 2>"$WORK/promote-cold-guard.err"
rc=$?; record promote-cold-guard "$rc"; test "$rc" = 0 || return 1
# Explicitly approved destruction of EMPTY target scaffolding only, never source data.
fs node -e 'const fs=require("node:fs");const p="/data";for(const n of fs.readdirSync(p)){if(n!=="recovery-stage")fs.rmSync(p+"/"+n,{recursive:true,force:false})}for(const n of fs.readdirSync(p+"/recovery-stage"))fs.renameSync(p+"/recovery-stage/"+n,p+"/"+n);fs.rmdirSync(p+"/recovery-stage")' >"$WORK/promote.out" 2>"$WORK/promote.err"
rc=$?; record promote "$rc"; test "$rc" = 0 || return 1
fs lifemodel-storage-recovery layout /data /work/policy.json >"$WORK/promoted-layout.json" 2>"$WORK/promoted-layout.err"
rc=$?; record promoted-layout "$rc"; test "$rc" = 0 || return 1
# No source Seaweed file may mutate between stage verification and promotion.
# Keep module/backend stopped, and delete the fs helper only after this succeeds.
```

All renames above remain within `/data`. No cross-filesystem rename, copy of
mini keys or broad credential capture is needed. Failure after target replacement
begins leaves an interrupted import, not a fresh empty target. The verified
artifact outside the PVC remains authoritative; never resume workload intake
until the imported catalog and tree have reconciled together.

After promotion, release the fs helper and start Seaweed with destination
custody. Create the following bounded offline recovery Job from the installed
module template. It retains the fixed key refs and ServiceAccount identity,
but replaces all Pod labels with its own recovery label and removes every
container port and probe. It never matches the storage Service. Temporary
operator policies grant only DNS and the two sides of Bao/S3/Postgres routes;
there is no inbound listener or Kubernetes API route. This adds no RoleBinding
and mounts no source PVC. Then prepare before any module process can start:

The SQL helper is no longer needed after `pg_restore`; remove it before backend
start too. Do not create the recovery-module Job until Seaweed is Ready. That Job
needs Seaweed for reconciliation, so they must fit together; if scheduling fails,
stop and add node capacity, never weaken the hold or raise replicas. Remove the
recovery Job before starting the normal module (commands below).

```bash
kubectl -n lifemodel-system delete job storage-recovery-sql --cascade=foreground --wait=true --timeout=120s >"$WORK/import-sql-release.out" 2>"$WORK/import-sql-release.err"
rc=$?; record import-sql-release "$rc"; test "$rc" = 0 || return 1
kubectl -n lifemodel-system delete job storage-recovery-fs --cascade=foreground --wait=true --timeout=120s >"$WORK/import-fs-release.out" 2>"$WORK/import-fs-release.err"
rc=$?; record import-fs-release "$rc"; test "$rc" = 0 || return 1
kubectl -n lifemodel-system scale statefulset/seaweedfs --replicas=1 >"$WORK/import-backend.out" 2>"$WORK/import-backend.err"
rc=$?; record import-backend "$rc"; test "$rc" = 0 || return 1
kubectl -n lifemodel-system rollout status statefulset/seaweedfs --timeout=180s >"$WORK/import-backend-ready.out" 2>"$WORK/import-backend-ready.err"
rc=$?; record import-backend-ready "$rc"; test "$rc" = 0 || return 1
python3 - <<'PY' 2>"$WORK/recovery-job.err"
import json,subprocess
def k(*args,data=None):
    r=subprocess.run(['kubectl',*args],input=data,capture_output=True,timeout=180)
    if r.returncode: raise RuntimeError('recovery_job_failed')
    return r.stdout
# Clone fixed identity/custody refs, but never the Service-selected label or ports.
template=json.loads(k('-n','lifemodel-system','get','deployment','storage-module','-o','json'))['spec']['template']
template['metadata']={'labels':{'lifemodel-recovery':'storage-recovery-module'}}
pod=template['spec']; pod['restartPolicy']='Never'
assert len(pod['containers'])==1 and not pod.get('initContainers')
container=pod['containers'][0]; container['command']=['sleep','3600']; container.pop('args',None)
container.pop('readinessProbe',None); container.pop('livenessProbe',None); container.pop('startupProbe',None)
container.pop('ports',None)
selector={'matchLabels':{'lifemodel-recovery':'storage-recovery-module'}}
def peer(namespace,labels):
    return {'namespaceSelector':{'matchLabels':{'kubernetes.io/metadata.name':namespace}},
            'podSelector':{'matchLabels':labels}}
def tcp(port): return {'protocol':'TCP','port':port}
def policy(name,namespace,select,**rules):
    obj={'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy',
         'metadata':{'name':name,'namespace':namespace},
         'spec':{'podSelector':select,'policyTypes':[key.capitalize() for key in rules],**rules}}
    # create, never adopt an unrelated prior operator policy.
    k('create','-f','-',data=json.dumps(obj).encode())
backend_routes=[('openbao',{'app.kubernetes.io/name':'openbao',
                           'app.kubernetes.io/instance':'openbao','component':'server'},8200),
                ('lifemodel-system',{'app.kubernetes.io/name':'seaweedfs'},8333),
                ('lifemodel-state',{'cnpg.io/cluster':'lifemodel'},5432)]
egress=[{'to':[peer(ns,labels)],'ports':[tcp(port)]} for ns,labels,port in backend_routes]
egress.append({'to':[peer('kube-system',{'k8s-app':'kube-dns'})],
               'ports':[{'protocol':'UDP','port':53},tcp(53)]})
policy('storage-recovery-module-egress','lifemodel-system',selector,ingress=[],egress=egress)
for ns,labels,port in backend_routes:
    policy('storage-recovery-module-ingress',ns,{'matchLabels':labels},
           ingress=[{'from':[peer('lifemodel-system',selector['matchLabels'])],'ports':[tcp(port)]}])
# No data listeners, API route or inbound allow: only CLI DB/Bao/S3 access.
job={'apiVersion':'batch/v1','kind':'Job','metadata':{'name':'storage-recovery-module','namespace':'lifemodel-system'},
     'spec':{'backoffLimit':0,'activeDeadlineSeconds':3600,'template':template}}
k('create','-f','-',data=json.dumps(job).encode())
PY
rc=$?; record recovery-job "$rc"; test "$rc" = 0 || return 1
kubectl -n lifemodel-system wait --for=condition=Ready pod -l job-name=storage-recovery-module --timeout=120s >"$WORK/recovery-ready.out" 2>"$WORK/recovery-ready.err"
rc=$?; record recovery-ready "$rc"; test "$rc" = 0 || return 1
python3 "$WORK/storage-endpoints.py" empty 2>"$WORK/offline-endpoints.err"
rc=$?; record offline-endpoints "$rc"; test "$rc" = 0 || return 1
RECOVERY_POD=$(kubectl -n lifemodel-system get pod -l job-name=storage-recovery-module -o jsonpath='{.items[0].metadata.name}')
rc=$?; record recovery-pod "$rc"; test "$rc" = 0 || return 1
```

```bash
# RECOVERY_POD is the operator-created recovery Job's Pod name, not a source Pod.
# MANIFEST_SHA256 is from trusted-manifest-sha256; RESTORE_GENERATION is a NEW UUID.
read -r MANIFEST_SHA256 <"$WORK/trusted-manifest-sha256"
RESTORE_GENERATION=$(python3 -c 'import uuid; print(uuid.uuid4())')
printf '%s\n' "$RESTORE_GENERATION" >"$WORK/restore-generation"
kubectl -n lifemodel-system exec "$RECOVERY_POD" -- lifemodel-storage-recovery prepare-restore "$RESTORE_GENERATION" "$MANIFEST_SHA256" >"$WORK/prepare.json" 2>"$WORK/prepare.err"
rc=$?; record prepare-restore "$rc"; test "$rc" = 0 || return 1
# Backend must now be serving with destination custody. Keep module at zero
# until prepare succeeds. It is also valid to reconcile fully before starting it.
kubectl -n lifemodel-system exec "$RECOVERY_POD" -- lifemodel-storage-recovery reconcile "$RESTORE_GENERATION" "$MANIFEST_SHA256" >"$WORK/reconcile-page.json" 2>"$WORK/reconcile.err"
rc=$?; record reconcile-page "$rc"; test "$rc" = 0 || return 1
```

Each `reconcile` call processes one bounded page. Use this bounded coordinator
loop, which saves each page and command's own status. It stops after 30 minutes
or 10,000 pages, preserves the hold on failure, and does not reset progress:

```bash
export RECOVERY_POD RESTORE_GENERATION MANIFEST_SHA256
python3 - <<'PY' 2>"$WORK/reconcile-loop.err"
import json,os,subprocess,time
from pathlib import Path
w=Path(os.environ['WORK']); deadline=time.monotonic()+1800
for page in range(10000):
    if time.monotonic()>=deadline: raise RuntimeError('reconcile_budget_exhausted')
    r=subprocess.run(['kubectl','-n','lifemodel-system','exec',os.environ['RECOVERY_POD'],'--',
                      'lifemodel-storage-recovery','reconcile',os.environ['RESTORE_GENERATION'],
                      os.environ['MANIFEST_SHA256']],capture_output=True,timeout=45)
    (w/('reconcile-'+str(page)+'.json')).write_bytes(r.stdout)
    (w/('reconcile-'+str(page)+'.err')).write_bytes(r.stderr)
    with (w/'command-status.jsonl').open('a') as f: f.write(json.dumps({'step':'reconcile-'+str(page),'exit':r.returncode})+'\n')
    if r.returncode: raise RuntimeError('reconcile_page_failed')
    receipt=json.loads(r.stdout)
    if receipt.get('complete'):
        (w/'reconcile-page.json').write_bytes(r.stdout)
        break
else: raise RuntimeError('reconcile_page_limit')
PY
rc=$?; record reconcile-loop "$rc"; test "$rc" = 0 || return 1
```

On completed clean receipt:

```bash
python3 -c 'import json,os; from pathlib import Path; r=json.loads((Path(os.environ["WORK"])/"reconcile-page.json").read_text()); assert r["complete"] and r["unavailable"]==0' 2>"$WORK/reconcile-complete.err"
rc=$?; record reconcile-complete "$rc"; test "$rc" = 0 || return 1
kubectl -n lifemodel-system exec "$RECOVERY_POD" -- lifemodel-storage-recovery release "$RESTORE_GENERATION" >"$WORK/release-restore.json" 2>"$WORK/release-restore.err"
rc=$?; record release-restore "$rc"; test "$rc" = 0 || return 1
# Do this immediately after either clean OR degraded release, before any real start.
kubectl -n lifemodel-system delete job storage-recovery-module --cascade=foreground --wait=true --timeout=120s >"$WORK/recovery-remove.out" 2>"$WORK/recovery-remove.err"
rc=$?; record recovery-remove "$rc"; test "$rc" = 0 || return 1
kubectl -n lifemodel-system wait --for=delete pod -l job-name=storage-recovery-module --timeout=120s >"$WORK/recovery-pods-removed.out" 2>"$WORK/recovery-pods-removed.err"
rc=$?; record recovery-pods-removed "$rc"; test "$rc" = 0 || return 1
python3 "$WORK/storage-endpoints.py" empty 2>"$WORK/pre-start-endpoints.err"
rc=$?; record pre-start-endpoints "$rc"; test "$rc" = 0 || return 1
kubectl -n lifemodel-system scale deploy/storage-module --replicas=1 >"$WORK/start-module.out" 2>"$WORK/start-module.err"
rc=$?; record start-module "$rc"; test "$rc" = 0 || return 1
kubectl -n lifemodel-system rollout status deploy/storage-module --timeout=180s >"$WORK/destination-ready.out" 2>"$WORK/destination-ready.err"
rc=$?; record destination-ready "$rc"; test "$rc" = 0 || return 1
python3 "$WORK/storage-endpoints.py" serving 2>"$WORK/serving-endpoints.err"
rc=$?; record serving-endpoints "$rc"; test "$rc" = 0 || return 1
# Only now open Service-based forwards and run the restored API comparisons.
```

For degraded release, separately approve the loss and run
`lifemodel-storage-recovery release-degraded "$RESTORE_GENERATION" "$EXACT_UNAVAILABLE_COUNT"`
instead. Never mark a degraded walk clean. Reconcile does not revive source
upload-owner heartbeats, task authority or source Jobs. Reads always check
availability after release. Storage-only recovery can repeat a retention warning
with fresh core state; surviving core Postgres suppresses an already delivered
owner message. It is not whole-instance exactly-once recovery.

## Runnable S09 workload and comparisons

`storage-recovery-walk.py` drives **real** TLS routes, not fake S3. Its steps are
bounded requests and fail on unexpected status/content/hash. No credentials in
argv. It creates 32 deterministic 4 MiB objects across two spaces. It marks every
other object (first result, remaining artifacts), checks task hashes and
cross-space denials, interrupts two 8 MiB uploads after one 4 MiB chunk, seals
space 0 (8 retained objects + 8 `seal_unmarked` tombstones), and revokes space 1.
The 8 unmarked objects in the revoked space remain catalog data but are denied
to core reads. It compares 16 marked downloads (64 MiB), marks, manifests,
immutable seal/revoke receipts, SQL tombstones/retention state and task/core read
denials. The other 64 MiB was downloaded and checked before seal/revoke.

Inputs are **two task identity bundle JSON files**, supplied by the coordinator,
not minted by the script. Each has `space`, `endpoint`, `tokenFile`, `caFile`.
Each must name an allocated/bound empty space with live canonical
`task_access.intents`, verified projection including `pod_name` and `job_name`,
and a live Job/Pod bound token with `lifemodel-task-storage` audience. Prior VM
walk projection setup remains coordinator work; there is no public seed API for
it. The driver must fail rather than fake it.

Control/read identity JSON files have `endpoint`, `tokenFile`, `caFile` and use
fresh Pod-bound **core** tokens for audiences
`lifemodel-core-storage-control` and `lifemodel-core-storage-read` respectively.
Task port 8443, control 8444, read 8445. Tokens remain in private files and may
be refreshed between steps. `connectHost` is optional, for an operator loopback
port-forward while preserving TLS SNI/hostname verification against `endpoint`.
For a forward, set endpoint hostname to the module certificate name, endpoint
port to the local forward port, and `connectHost` to `127.0.0.1`. Do not disable
TLS verification. A tunnel is operator authority, never task permission.

Private `walk-source.json` example (paths must exist; no token strings):

```json
{
  "tasks": ["/owner-private/task0.json", "/owner-private/task1.json"],
  "control": "/owner-private/core-control.json",
  "read": "/owner-private/core-read.json",
  "manifest": "/owner-private/restored-artifact/manifest.json"
}
```

Run from the coordinator VM. SQL capture uses the `psql` native environment and
never prints its stdout/stderr. It asserts 32 catalog objects, 8 seal tombstones,
two pending **unpublished** interrupted intents, ledger equality (space charges
plus orphan debt), and zero unavailable. It records actual debt/attempt counts;
it does not assume a network abort left durable backend bytes.

```bash
export EVIDENCE=/owner-private/s09-evidence
python3 deploy/platform/storage-recovery-walk.py seed --config /owner-private/walk-source.json --evidence "$EVIDENCE"
rc=$?; record walk-seed "$rc"; test "$rc" = 0 || return 1
# Restart source module here, under normal platform control, before capture.
kubectl -n lifemodel-system rollout restart deployment/storage-module >"$WORK/restart.out" 2>"$WORK/restart.err"
rc=$?; record restart "$rc"; test "$rc" = 0 || return 1
kubectl -n lifemodel-system rollout status deployment/storage-module --timeout=180s >"$WORK/restart-ready.out" 2>"$WORK/restart-ready.err"
rc=$?; record restart-ready "$rc"; test "$rc" = 0 || return 1
python3 deploy/platform/storage-recovery-walk.py capture-source --config /owner-private/walk-source.json --evidence "$EVIDENCE"
rc=$?; record walk-source "$rc"; test "$rc" = 0 || return 1
# Perform source cold backup above, export it, then isolate source.
# Immediately BEFORE destination verification/import (not after it):
python3 deploy/platform/storage-recovery-walk.py start-clock --config /owner-private/walk-destination.json --evidence "$EVIDENCE"
rc=$?; record restore-clock "$rc"; test "$rc" = 0 || return 1
# Complete empty destination restore, reconcile, release and fresh-custody test.
# Switch PG environment to destination. Destination config uses source task
# tokens for negative replay only, and fresh destination core tokens for reads.
python3 deploy/platform/storage-recovery-walk.py capture-restored --config /owner-private/walk-destination.json --evidence "$EVIDENCE"
rc=$?; record walk-restored "$rc"; test "$rc" = 0 || return 1
python3 deploy/platform/storage-recovery-walk.py compare --config /owner-private/walk-destination.json --evidence "$EVIDENCE"
rc=$?; record walk-compare "$rc"; test "$rc" = 0 || return 1
```

On a fresh cluster, source task tokens may fail with `identity_denied` rather
than source `access_denied`. Comparison requires the same denied status and
object/kind; it records task-only transitions to `identity_denied` as
`freshClusterIdentityDenialChanges`. Core denial codes must remain identical.
It never accepts a successful read in place of a denial. Source cross-space
denials were separately proven during seed while both tasks were active.

### Custody negative test and partial upload observation

The API workload steps never see S3 custody. The **operator-only** `custody`
subcommand supplies an exact standard-library SigV4 test. The coordinator
provides two private JSON custody files containing exactly `accessKey` and
`secretKey`, obtained through approved fixed-key custody access, never a Secret
or environment dump. Do not add them to the artifact. Give the operator a
private local S3 port-forward, or a TLS endpoint with a trusted CA. The script
permits plaintext S3 only at localhost/127.0.0.1; cluster S3 remains restricted.
The operator's Kubernetes port-forward grants no task capability and requires
no new standing RBAC/NetworkPolicy. It is not a production endpoint.

The subcommand selects the first marked expected object, reads only that
object's immutable key through PostgreSQL 17 `psql` using the destination PG
environment, and signs its GET. No operator SQL interpolation or displayed key
is needed. Save private `custody-check.json`:

```json
{
  "endpoint": "http://127.0.0.1:18333",
  "sourceCredentialsFile": "/owner-private/source-custody.json",
  "destinationCredentialsFile": "/owner-private/destination-custody.json"
}
```

Add `"custody": "/owner-private/custody-check.json"` to destination walk config.
Start this forward in a separate operator terminal (save its log privately):

```bash
while true; do
  kubectl -n lifemodel-system port-forward --address=127.0.0.1 service/seaweedfs 18333:8333 >>"$WORK/s3-forward.log" 2>&1
  rc=$?; printf 'port-forward exit=%s\n' "$rc" >>"$WORK/s3-forward.log"
  sleep 1
done
```

With destination PG environment and core/task TLS routes available, run:

```bash
python3 deploy/platform/storage-recovery-walk.py custody --config /owner-private/walk-destination.json --evidence "$EVIDENCE"
rc=$?; record custody-check "$rc"; test "$rc" = 0 || return 1
```

The test signs the same retained key with source then destination custody.
It requires source 403, destination 200 and exact expected hash/length. Only
statuses and a hash-match boolean are saved. Neither headers, keys, names nor
response content are printed. `compare` requires this successful receipt;
custody cannot silently remain pending in a successful walk.

Reconcile receipts and SQL capture show whether interrupted uploads are private,
unpublished and correctly charged. After release, observe existing GC by
querying `attempt_gc`, `orphan_gc`, `upload_intents` and `instance_ledger` in
private read-only SQL. Respect the >=2 day grace and upload-owner fencing. A
short drill can accept accounted young residue, but cannot claim observed
reclamation until a later real GC pass confirms it. Do not manually DELETE
backend keys or reset catalog clocks. Record follow-up observation if needed.

## Interruption, retry and cleanup

- A failed `begin`/drain leaves the durable fence. Run `status`; retry the same
  effect key, or stop all mutator processes and finish the held cut. Never copy
  while state is `draining` and never infer coldness from lock release alone.
- Failed backup: keep incomplete scratch as diagnosis only. Export any needed
  scratch privately, delete SQL and fs helper Jobs with foreground wait as above
  (use `--ignore-not-found` if already removed), then restart source Seaweed.
  Establish authenticated health, explicitly release its matching
  **backup** generation, then restore prior Flux/launch state. A manifest is
  valid only when build + verify and independent export verification succeeded.
- Failed import/promotion/reconcile: keep target stopped/restore-held, retain
  staging and private errors. Retry matching generation/hash pages. A partial
  promotion is not an empty destination; do not re-import over it. Rebuild a
  disposable empty target if its previous attempt cannot safely resume.
- Helper timeout preserves the hold but deletes its running process, not its
  durable source/destination data. Export scratch before one hour. A failed Job
  is not backup success. Delete explicit helpers only after evidence is saved.

Remove operator resources in **each** context after the held procedure is
safely complete. Their names are fixed; do not delete namespace-wide resources:

```bash
kubectl -n lifemodel-system delete job storage-recovery-fs storage-recovery-sql storage-recovery-module --ignore-not-found --wait=true --timeout=120s >"$WORK/helper-cleanup.out" 2>"$WORK/helper-cleanup.err"
rc=$?; record helper-cleanup "$rc"; test "$rc" = 0 || return 1
kubectl -n lifemodel-system delete networkpolicy storage-recovery-sql-egress --ignore-not-found >"$WORK/egress-cleanup.out" 2>"$WORK/egress-cleanup.err"
rc=$?; record egress-cleanup "$rc"; test "$rc" = 0 || return 1
kubectl -n lifemodel-state delete networkpolicy storage-recovery-sql-ingress --ignore-not-found >"$WORK/ingress-cleanup.out" 2>"$WORK/ingress-cleanup.err"
rc=$?; record ingress-cleanup "$rc"; test "$rc" = 0 || return 1
kubectl -n lifemodel-system delete networkpolicy storage-recovery-module-egress storage-recovery-module-ingress --ignore-not-found >"$WORK/module-network-cleanup.out" 2>"$WORK/module-network-cleanup.err"
rc=$?; record module-network-cleanup "$rc"; test "$rc" = 0 || return 1
kubectl -n openbao delete networkpolicy storage-recovery-module-ingress --ignore-not-found >"$WORK/bao-network-cleanup.out" 2>"$WORK/bao-network-cleanup.err"
rc=$?; record bao-network-cleanup "$rc"; test "$rc" = 0 || return 1
kubectl -n lifemodel-state delete networkpolicy storage-recovery-module-ingress --ignore-not-found >"$WORK/db-network-cleanup.out" 2>"$WORK/db-network-cleanup.err"
rc=$?; record db-network-cleanup "$rc"; test "$rc" = 0 || return 1
# The offline recovery Job was already removed before the real module started.
python3 - <<'PY' 2>"$WORK/resume.err"
import json,os,subprocess
from pathlib import Path
prior=json.loads((Path(os.environ['WORK'])/'prior.json').read_text())
# Resume children first, parent last; preserve prior true rather than unsuspending all.
for name in ['platform-d','platform-a','platform']:
    r=subprocess.run(['kubectl','-n','flux-system','patch','kustomization',name,'--type=merge','-p',
                      json.dumps({'spec':{'suspend':prior['flux'][name]}})],capture_output=True,timeout=30)
    if r.returncode: raise RuntimeError('resume_failed')
PY
rc=$?; record resume-flux "$rc"; test "$rc" = 0 || return 1
```

Restore previous task-launch/core state only after hash/denial/custody checks and
health pass. Keep owner-private evidence with a retention/access policy. The
coordinator's receipt must name revision, images, layout proof ID, generation,
SQL cut, trusted manifest hash, every command's own exit status, clean/degraded
count, checked bytes, measured time, actual residue/debt and any pending proof.
A skipped layout/custody/empty-import/promotion check is never a passed S09 walk.
