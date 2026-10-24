# Task admission API-server walk

These are coordinator-only commands for the disposable k3s VM. They are not run
by unit tests. Unit tests evaluate the **actual** CEL expressions using the
existing `@marcbachmann/cel-js` dependency. They do not prove Kubernetes CEL type
checking, API defaulting, PSA ordering or the actual controller identity.

Run from the repository root with the platform installed. Do not use `--validate=false`.
First check both policies' status (empty/missing expressionWarnings required):

```sh
kubectl get validatingadmissionpolicy task-job-admission task-pod-admission -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{.status.typeChecking.expressionWarnings}{"\n"}{end}'
```

Core and Job controller requests use exact impersonation. Admin credentials must
have impersonate rights. RBAC refusal is NOT admission proof. The pinned k3s
source `pkg/daemons/control/server.go` enables
`use-service-account-credentials=true`, selecting
`system:serviceaccount:kube-system:job-controller`. Confirm a real controller
created Pod after the workbench leaf pins its image; no broad controller-group
exception is allowed.

Baseline CREATEs must succeed (dry run; fake image never executes). First confirm
that `task-admission-probe` Job and `task-admission-probe-pod` Pod are absent in
`lifemodel-motor`; if either exists, clean up that previous probe before continuing.
Keep the Job absent throughout the CREATE probes so `apply` never becomes UPDATE.
The controller Pod probes use `create`, because the Job controller has no Pod `get`
right and `apply` would fail its preliminary GET before admission:

```sh
node tests/fixtures/task-admission/probe.mjs valid Job | kubectl --as=system:serviceaccount:lifemodel:core apply --dry-run=server -f -
node tests/fixtures/task-admission/probe.mjs valid Pod | kubectl --as=system:serviceaccount:kube-system:job-controller create --dry-run=server -f -
```

Each command below must fail. The error must name `task-job-admission` or
`task-pod-admission` and the corresponding `task <family>:` message. Commands are
separate so one refusal does not hide a missing family. `creator` deliberately
uses admin, which has RBAC but must NOT bypass the policy.

```sh
node tests/fixtures/task-admission/probe.mjs creator Job | kubectl apply --dry-run=server -f -
node tests/fixtures/task-admission/probe.mjs creator Pod | kubectl apply --dry-run=server -f -
node tests/fixtures/task-admission/probe.mjs execution Job | kubectl --as=system:serviceaccount:lifemodel:core apply --dry-run=server -f -
node tests/fixtures/task-admission/probe.mjs deadline Job | kubectl --as=system:serviceaccount:lifemodel:core apply --dry-run=server -f -
node tests/fixtures/task-admission/probe.mjs suspend Job | kubectl --as=system:serviceaccount:lifemodel:core apply --dry-run=server -f -
node tests/fixtures/task-admission/probe.mjs failure Job | kubectl --as=system:serviceaccount:lifemodel:core apply --dry-run=server -f -
node tests/fixtures/task-admission/probe.mjs launch Job | kubectl --as=system:serviceaccount:lifemodel:core apply --dry-run=server -f -
node tests/fixtures/task-admission/probe.mjs identity Job | kubectl --as=system:serviceaccount:lifemodel:core apply --dry-run=server -f -
node tests/fixtures/task-admission/probe.mjs image Job | kubectl --as=system:serviceaccount:lifemodel:core apply --dry-run=server -f -
node tests/fixtures/task-admission/probe.mjs launcher Job | kubectl --as=system:serviceaccount:lifemodel:core apply --dry-run=server -f -
node tests/fixtures/task-admission/probe.mjs sidecar Job | kubectl --as=system:serviceaccount:lifemodel:core apply --dry-run=server -f -
node tests/fixtures/task-admission/probe.mjs security Job | kubectl --as=system:serviceaccount:lifemodel:core apply --dry-run=server -f -
node tests/fixtures/task-admission/probe.mjs environment Job | kubectl --as=system:serviceaccount:lifemodel:core apply --dry-run=server -f -
node tests/fixtures/task-admission/probe.mjs volumes Job | kubectl --as=system:serviceaccount:lifemodel:core apply --dry-run=server -f -
# hostPath may be caught by PSA first; this CA-reference variant isolates CEL:
node tests/fixtures/task-admission/probe.mjs ca-reference Job | kubectl --as=system:serviceaccount:lifemodel:core apply --dry-run=server -f -
node tests/fixtures/task-admission/probe.mjs audience Job | kubectl --as=system:serviceaccount:lifemodel:core apply --dry-run=server -f -
node tests/fixtures/task-admission/probe.mjs owner Pod | kubectl --as=system:serviceaccount:kube-system:job-controller create --dry-run=server -f -
```

The `image` variant uses a local mutable tag. The `image-ghcr`,
`image-repository` and `image-registry` variants test a digest at the public
origin, a different local repository and a different registry. Run each variant
for both Job and Pod, using the corresponding core/controller CREATE command
above. All must fail with `task launcher:`. Only the local zot repository by
full digest is admitted.

PSA may reject privileged/hostPath violations before this policy. Such a refusal
proves the combined boundary, but not that a CEL expression compiled or ran.
Run the baseline and inspect policy status; use the safe `security` variant
(read-only filesystem false) to isolate the CEL security family.

## UPDATE cases

A dry-run CREATE does not persist oldObject. Persist one never-executing fake
image Job first **only in the disposable VM**. It may leave a Pending Pod/PVC
until cleanup. Do not substitute a real executable image.

```sh
node tests/fixtures/task-admission/probe.mjs valid Job | kubectl --as=system:serviceaccount:lifemodel:core create -f -
kubectl get job task-admission-probe -n lifemodel-motor -o json > /tmp/task-admission-old.json
```

Each widening must be refused. Core has `patch`, not `update`: these use
merge patches (never `replace`). The template case may also be rejected by
native Job immutability; the unit test separately evaluates our equality rule.
Use the original full Job JSON for patch input generation; merge patch null is
required to remove a deadline. `resourceVersion` supplies a CAS precondition.

```sh
node tests/fixtures/task-admission/probe.mjs update-deadline < /tmp/task-admission-old.json > /tmp/task-admission-patch.json
kubectl --as=system:serviceaccount:lifemodel:core patch job task-admission-probe -n lifemodel-motor --type=merge --dry-run=server --patch-file=/tmp/task-admission-patch.json
node tests/fixtures/task-admission/probe.mjs update-remove-deadline < /tmp/task-admission-old.json > /tmp/task-admission-patch.json
kubectl --as=system:serviceaccount:lifemodel:core patch job task-admission-probe -n lifemodel-motor --type=merge --dry-run=server --patch-file=/tmp/task-admission-patch.json
node tests/fixtures/task-admission/probe.mjs update-launch < /tmp/task-admission-old.json > /tmp/task-admission-patch.json
kubectl --as=system:serviceaccount:lifemodel:core patch job task-admission-probe -n lifemodel-motor --type=merge --dry-run=server --patch-file=/tmp/task-admission-patch.json
node tests/fixtures/task-admission/probe.mjs update-template < /tmp/task-admission-old.json > /tmp/task-admission-patch.json
kubectl --as=system:serviceaccount:lifemodel:core patch job task-admission-probe -n lifemodel-motor --type=merge --dry-run=server --patch-file=/tmp/task-admission-patch.json
node tests/fixtures/task-admission/probe.mjs update-suspend < /tmp/task-admission-old.json > /tmp/task-admission-patch.json
kubectl --as=system:serviceaccount:lifemodel:core patch job task-admission-probe -n lifemodel-motor --type=merge --dry-run=server --patch-file=/tmp/task-admission-patch.json
```

Shortening must succeed; cleanup must succeed despite creator restrictions:

```sh
node tests/fixtures/task-admission/probe.mjs update-shorten < /tmp/task-admission-old.json > /tmp/task-admission-patch.json
kubectl --as=system:serviceaccount:lifemodel:core patch job task-admission-probe -n lifemodel-motor --type=merge --dry-run=server --patch-file=/tmp/task-admission-patch.json
kubectl --as=system:serviceaccount:lifemodel:core delete job task-admission-probe -n lifemodel-motor --wait=true
rm /tmp/task-admission-old.json /tmp/task-admission-patch.json
```

No token value, Secret body, live intent or harness authorization is inspected by
these probes. Fake Pod owner references demonstrate exactly why CEL cannot
resolve live ownership: the gateway's live UID/intent/claim check remains required.


## Network walk (after the workbench image is available)

Run in the disposable VM with an admin context. This uses an admitted Job's
probe Pod, not an admission exemption or a privileged debug Pod. The launcher
must stay inert while waiting for the live binding; this probe never grants a
start claim. Set WORKBENCH_IMAGE to the actual signed release digest from
653.8.3, never a mutable tag. Node must be present in that workbench.

```sh
export WORKBENCH_IMAGE=zot.lifemodel-system.svc:5001/lifemodel/workbench@sha256:REPLACE_WITH_RELEASE_DIGEST
node tests/fixtures/task-admission/probe.mjs valid Job | node --input-type=module -e '
import {readFileSync} from "node:fs";
const job=JSON.parse(readFileSync(0,"utf8"));
const image=process.env.WORKBENCH_IMAGE;
if (!/^zot[.]lifemodel-system[.]svc:5001\/lifemodel\/workbench@sha256:[0-9a-f]{64}$/.test(image ?? "")) throw Error("released workbench digest required");
job.spec.template.spec.containers[0].image=image;
console.log(JSON.stringify(job));' > /tmp/task-network-probe.json
kubectl --as=system:serviceaccount:lifemodel:core create -f /tmp/task-network-probe.json
kubectl -n lifemodel-motor wait --for=condition=Ready pod -l job-name=task-admission-probe --timeout=120s
TASK_POD=$(kubectl -n lifemodel-motor get pod -l job-name=task-admission-probe -o jsonpath='{.items[0].metadata.name}')
API_SERVICE=$(kubectl -n default get svc kubernetes -o jsonpath='{.spec.clusterIP}')
API_NODE=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')
POSTGRES=$(kubectl -n lifemodel-state get svc lifemodel-rw -o jsonpath='{.spec.clusterIP}')
VALKEY=$(kubectl -n lifemodel-state get svc valkey -o jsonpath='{.spec.clusterIP}')
SEAWEED=$(kubectl -n lifemodel-system get svc seaweedfs -o jsonpath='{.spec.clusterIP}')
kubectl -n lifemodel-motor exec -i "$TASK_POD" -c task -- node --input-type=module - "$API_SERVICE" "$API_NODE" "$POSTGRES" "$VALKEY" "$SEAWEED" < tests/fixtures/task-admission/network-probe.mjs
kubectl --as=system:serviceaccount:lifemodel:core delete job task-admission-probe -n lifemodel-motor --wait=true
rm /tmp/task-network-probe.json
```

The probe must print PASS for storage DNS and its permitted TCP listener, then
PASS denied for internet, API Service/node, Postgres, Valkey and SeaweedFS.
A transport denial alone can also mean an absent listener. Before this walk,
confirm each target is healthy from its authorized platform caller. Run cleanup
even when the probe fails. This is L3/L4 evidence only; runtime audience/live
binding/own-space checks have their own stage acceptance walks.
