# Storage allocation, binding and seal

Task: lifemodel-653.7.6. Implements ADR-015 S-D4; not a deployed acceptance record.

## Routes

All control operations use TLS 8444 and the existing
`lifemodel-core-storage-control` audience / `lifemodel:core` service account.
Task and web identities cannot call them. Requests reject unknown or missing fields.

- `POST /allocate {taskId,launchId,effectKey,retentionRevision}` returns
  `{id,space,effectKey}`. The retention revision is an opaque stored policy
  reference. Same key and request replay the receipt; changed request conflicts.
  Another key for the same launch returns the same space. Changed task or
  retention reference for that launch conflicts. No key or credential is returned.
- `POST /bind {space,taskId,attemptId,launchId,effectKey}` returns
  `{id,space,effectKey,revision}`. Core supplies neither UIDs nor names. The module
  uses the gateway-verified projection locators and its own live Kubernetes
  GET checks. Missing names/projection, stale access revision, revoked intent,
  hard deadline or non-live/mismatched resources fail closed. A second attempt
  or launch conflicts. A saved receipt replays even after later Pod death; it
  does not grant access. Stage 3 owns the verified projection writer.
- `POST /seal {space,effectKey,expectedRevision,outcome}` accepts `completed`,
  `failed`, or `stopped`. Access revisions are nonnegative decimal strings.
  A stale revision or changed keyed request conflicts. A new key cannot replace
  an existing seal operation.
- Existing `POST /revoke` remains keyed. New revoke operations cannot replace a
  frozen/sealed space; an old receipt still replays without changing mode.

Read TLS 8445 exposes `GET /spaces/:space/objects?limit=100&cursor=...` and
`GET /spaces/:space/objects/:objectId` only to the
`lifemodel-core-storage-read` audience / `lifemodel:core` identity. The existing
object pagination/range/chunk limits apply. Only marked, non-tombstoned objects
can be listed/read, including during a running task. Each chunk re-verifies the
core Pod and current catalog object; web gets no object route permission here.
Owner download authorization is later S08 work. `/identity` is unchanged.

## Durable state and receipt

Migration `20261015000014_create_storage_seals.sql` expands the catalog with
`allocations`, `allocate_receipts`, `bindings`, `bind_receipts`,
`seal_operations`, `seal_manifests`, `seal_gc`, `object_tombstones`, and
`seal_receipts`. All writes are fixed module-owned parameterized statements.
No new SQL function, dependency, external endpoint or bootstrap dependency is
introduced. The module uses a bounded reusable catalog pool and the existing
signed keep-alive S3 adapter. Empty tables are ready; missing schema is not.

1. Normal completion/failure first waits for the current local handler snapshot
   to settle, bounded to five seconds (`quiescence_pending` on timeout). This
   lets admitted mark acknowledgements finish. Hard Stop (`stopped`) skips that
   pre-freeze wait. Freeze then locks the space, increments access revision,
   sets `frozen` and saves an immutable candidate set of marks. Existing
   mark/publication share locks serialize before freeze, with a five-second SQL
   lock bound. No task write, mark or read authorizes after freeze commits.
2. Freeze aborts registered local task streams and awaits their handler
   settlement, bounded to five seconds. Failure stays read-only and returns
   `cleanup_pending`. The one-replica/Recreate topology makes this process's
   local registry complete. The S3 adapter also retains actual ClientRequest
   close promises across operation disposal and settlement timeouts. Seal waits
   that snapshot with its own five-second bound before cleanup. This global
   conservative check can defer a new seal behind another space's active
   transport; reserved/fair worker admission remains .7.7. Already saved seal
   receipts replay before transfer barriers. Startup closes the previous
   process's sockets.
3. Checksum-enabled S3 HEAD validates length and SHA-256 of every frozen marked
   immutable version. This reuses PUT's backend persistence contract, avoids
   unbounded byte rereads, and fails visibly on mismatch/absence. It does not
   silently discard a corrupt mark. A completed outcome without a marked result
   returns `missing_result`; it cannot fabricate success.
4. Commit manifest version 1, ID, content hash and exact marked object IDs,
   names, sizes, hashes and roles before any cleanup DELETE. Canonical digest
   is SHA-256 of UTF-8 JSON `{version:1,objects:[...]}`, objects sorted by UUID,
   each object field ordered `id,name,size,sha256,mark`. Replay uses persisted
   candidates/manifest, never scans a changing workspace to redefine output.
5. `manifest-committed → cleanup`: persist all non-retained attempt keys in
   `seal_gc`, DELETE each through the module's S3 custody (200/204/404 are
   idempotent confirmation), persist confirmation. DELETE failure returns
   `503 cleanup_pending`, keeps read-only state, and retries on seal replay.
   Reservations are released and quota becomes retained manifest bytes only.
   Object/version/upload identities remain as tombstones; removed objects are
   not visible. Manifest membership, not a later mark scan, selects survivors.
6. Only confirmed cleanup sets `sealed`. Save one immutable receipt. Crash
   after sealed but before receipt commit recreates the receipt from saved
   IDs/revision/manifest, never generates new identity or content.

Receipt shape: `{id,space,effectKey,revision,outcome,state:"sealed",reason,
manifest:{id,version:1,sha256,objects}}`. `completed` has a result and null reason;
`failed` uses `partial_output` / `missing_result`; `stopped` uses
`stopped_partial_output` / `stopped_missing_result`. Sealed means retained marked
output, not semantic harness success. Core owns its terminal outcome/outbox and
must record the returned receipt ID and manifest hash.

## Accepted backend residual and later work

A full PUT body accepted by SeaweedFS before a module crash can finish after
cleanup. It may leave an unreferenced `private/<uuid>` object even though DELETE
previously confirmed absence. The same remote-finalization ambiguity is not a
catalog publication: freeze forbids publication, so these bytes are never
listed, never in a manifest, and never readable through the module. This is
capacity-only residue, not retained task output. Local transfer settlement is
not a cross-process/backend transaction or a proof of remote rollback.
The coordinator explicitly accepted this residual in decision 2 for this task.
`lifemodel-653.7.3` owns orphan reconciliation/sweep; it is not built here.
Do not infer backend quiescence from an upload lease, local cancellation or 404.

Retention/pins/notices and global quota policy remain .7.3; consistent backup
and restore remain .7.4; admission/fairness/reserved workers/RSS remain .7.7.
No NetworkPolicy, RBAC, TLS projection, image context or A0→A→B→C→D chain changes
are needed. New TypeScript runtime files are already admitted by the loader
build-context allowlist. The gateway writer and core terminal integration are
stage 3; module binding is acknowledgement of verified gateway authority, not
an independent authority to start a harness.
