# Task launch

The core Job path is separate from the legacy Docker Motor Cortex loop.
`src/core/task-executor.ts` is an infrastructure port, not a plugin primitive.
`src/core/kubernetes-task-executor.ts` implements it without another dependency.
The second, in-memory executor is a caller-contract test double, never durable
application authority. No code under `src/runtime/motor-cortex/` changes.

## Authority and order

The platform mode core uses its raw Postgres pool, active snapshot epoch and
platform settings reader to construct the fenced task registry. Acceptance
snapshots the digest from the validated `LIFEMODEL_TASK_WORKBENCH_IMAGE` only on
first acceptance. It stores the caller image digest separately for payload-conflict
checks; identical replay returns the original selected image after deployment.
The repository is the fixed admission-policy repository
`ghcr.io/shady2k/lifemodel-workbench`; repository plus persisted digest therefore
reconstructs the same immutable image after restart. Missing, tagged or malformed
configuration refuses startup. A later repository change needs a reviewed policy
and storage-contract change, not an environment-only override.

For each admitted `starting` row:

1. Replay `/allocate` with `allocate_<launchId>` and the accepted settings revision
   as `retentionRevision`. Save `{id,space,effectKey}` in the fenced registry.
2. Re-read the current registry fence/tombstone before calling `ensureStarted`.
3. GET the exact deterministic Job name. Create only if absent and the launch has
   never bound a Job UID. On an unknown create reply or AlreadyExists, GET and
   adopt that name, never a second name or attempt.
4. Verify the launch labels, immutable template hash and actual normalized Job
   template, plus the already-bound UID if any. Save UID and template hash.
5. Once the Job has `status.startTime`, initialize canonical access intent from
   that timestamp. No verified Pod binding or start permission exists yet.

Storage allocation failure leaves the same reserved task pending. Retry uses the
same effect key. A crash after allocation but before saving its receipt replays
the storage receipt. A crash after create but before UID persistence adopts the
same object. A missing previously bound Job is a visible failure, never a rerun.
Job status is an observation, not a task outcome or proof of sealed output.

## Restricted Job

The launcher image ENTRYPOINT is the only command. One generic ephemeral claim
mounts at `/work`. Pod uid, gid and fsGroup are 1000. The Job is Never/1/1/0/Failed,
with disruption and nonzero-exit FailJob rules, zero termination grace and native
`activeDeadlineSeconds = floor(timeout + accepted wrap grace)` (at most the platform's
86400-second ceiling). Fractional platform grace is rounded down only for the
native integer deadline, so it never extends the accepted hard bound. No TTL, suspend, owner workspace, credential Secret,
private key, token value or briefing is in the Job spec.

Three explicitly projected service audiences (`lifemodel-task-model`,
`lifemodel-task-storage`, `lifemodel-task-channel`) mount as a read-only directory.
A separate read-only `lifemodel-ca` ConfigMap supplies only the public CA.
Default API token mounting is off. The task SA has no API bindings.

The launch label is the deterministic Job name's 58-hex-character suffix, not the
longer `launch_` ID: Kubernetes labels allow at most 63 characters. The full ID
remains in Postgres. Matching that label alone grants no runtime rights.

The narrow A0 policy extension permits exactly these literal string env names:

- `LIFEMODEL_STORAGE_ENDPOINT`, `LIFEMODEL_STORAGE_SPACE`,
  `LIFEMODEL_STORAGE_TOKEN_FILE`, `LIFEMODEL_STORAGE_CA_FILE`;
- `LIFEMODEL_TASK_CHANNEL_ENDPOINT`, `LIFEMODEL_TASK_CHANNEL_TOKEN_FILE`,
  `LIFEMODEL_TASK_CHANNEL_CA_FILE`;
- `LIFEMODEL_TASK_MODEL_ENDPOINT`, `LIFEMODEL_TASK_MODEL_TOKEN_FILE`,
  `LIFEMODEL_TASK_MODEL_CA_FILE`.

These carry endpoints, public CA paths, identity paths and space ID, never token
bytes. `valueFrom`, `envFrom`, `NODE_OPTIONS`, `LD_PRELOAD`, `PATH` and all other
names remain forbidden. This resolves the earlier blanket-env ban without a
new per-launch configuration volume or bootstrap dependency. The A0→A→B→C→D
order stays unchanged; both Job and Pod policies use the same closed list.

## Recovery and shutdown

Startup and watch-resync reconciliation reads registry authority before dispatch.
Unknown labelled Jobs and tombstoned launches are removed by observed exact UID
and resourceVersion preconditions. Known deletion first persists irreversible
cleanup/tombstone intent. Delayed old-epoch creates remain the explicit ADR-014
D3 residual: they may consume bounded startup resources but the gateway's live
canonical-intent and once-only binding gate must keep the launcher inert.

Deletion never clears identities/tombstones, changes outcome or releases a slot.
A Job DELETE reply is not proof that every owned Pod has terminated. Finalization
must confirm compute termination before `releaseSlot`; seal and terminal outbox
are now the [finalizer's job](task-finalize.md). Cleanup stays pending until that confirmation.

Each HTTPS client has one keep-alive agent, a deadline per call and rereads the
projected token and CA for every call. Errors/logs contain safe codes, IDs and
counts, not response bodies or transport causes. LIST is capped at 100 pages,
10,000 matched Jobs, 4096-byte continuation tokens and one 30-second overall
deadline, in addition to per-request limits. Empty filtered pages cannot keep a
pass alive indefinitely. Stop cancels retry/watch I/O, closes both HTTP clients,
and discards only the worker registry's checked-out SQL clients. The worker drains
inside the core's shared shutdown deadline before pool close. Unrelated service
and core clients remain available for the drained turn's commit.

`requestSoftStop` records durable intent only in stage 3. It does not claim wrap,
revocation or a shortened native deadline. Stage 5 owns that complete operation.

## Evidence and next seams

`tests/integration/task-launch-fence.test.ts` uses real isolated Postgres and a
local HTTPS fake Kubernetes API that verifies the bearer token and request
bodies. The Kubernetes and fake executors share the caller contract. Tests also
evaluate the rendered Job against the actual A0 CEL expressions; this is not a
claim of a deployed API-server admission test.

- .8.6 verifies live Pod/Job identity and grants the durable once-only start.
- .8.7 supplies the launcher handshake and harness implementation; today's
  launcher remains inert.
- .8.8 supplies the durable live channel.
- .8.9 owns sealing, terminal outcome, exact-UID final deletion, confirmed Pod
  termination and reservation release. The [finalizer](task-finalize.md) now owns these steps. No terminal outcome is inferred here.
