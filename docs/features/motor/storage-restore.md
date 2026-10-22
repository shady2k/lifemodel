# Storage-set backup and restore

Task: lifemodel-653.7.4. Approved storage-set recovery design. Serves motor-1
outcome 2, “nothing is lost”, and [ADR-015](../../adr/015-storage-module.md)
S-D7 / S09. Local checks do not replace the coordinator's deployed S09 walk.
The operator procedure is [storage recovery](../../../deploy/platform/storage-recovery.md).

## Outcome and existing boundaries

The owner can recover acknowledged task output and its catalog into an empty
storage instance as one set. Marks, immutable receipts, access revisions,
seal manifests, deletion intents and tombstones retain their meaning. Missing
bytes are unavailable, never healthy output. A stopped backend makes reads
unavailable temporarily; entering a hold itself does not deny authorized reads.
There is no disk-loss RPO/RTO promise. Record backup age and measured restore
time; copy the finished artifact outside the node's failure domain for disk-loss
safety.

The module is a single replica with Recreate deployment. SeaweedFS is the
pinned single-process `weed mini` on `data-seaweedfs-0`, a 10Gi PVC.
[Object publication](storage-objects.md), [seal](storage-seal.md) and
[retention](storage-retention.md) each cross SQL and S3 in several steps.
`loader/src/storage-access.ts` and `loader/src/storage-object-s3.ts` have local
per-space settlement barriers, not a global recovery cut. A canceled socket,
expired upload lease or confirmed DELETE does not prove that an accepted
remote PUT cannot finish. `loader/src/storage-module.ts` wires durable maintenance admission into mutation
and retention operations. Restore preparation seeds per-version availability
before startup; reads exclude every unverified/missing/corrupt version.

## Decisions and rejected alternatives

- **Quiescence plus cold copy (Release It! bulkhead / maintenance barrier):**
  pause mutations durably, drain or abort writers, stop SeaweedFS, then capture
  SQL and the PVC. Reject live filesystem copies, mirror-only recovery and an
  S3 export alone: none proves the filer/catalog/volume cut.
- **Core-only control route on existing TLS 8444:** reuse fresh Pod-bound
  `lifemodel-core-storage-control` identity, not task/web tokens. Operator
  commands use this route from the core Pod. Reject a new loader identity and
  loader-to-control network route for now: loader has health-only connectivity,
  and neither is needed for this offline operator procedure. An offline admin
  subcommand with the module's existing scoped-purpose SQL configuration handles
  pre-start restore and crash recovery when core is absent; no public admin API.
- **SQL-backed maintenance state and transaction-local barrier:** every mutating
  SQL transaction takes the shared transaction advisory fence and checks durable
  state before its first write. Reject a separate admission session: losing it
  can release a fence while another session commits catalog changes.
- **Storage-only archive:** preserve the complete `storage` schema, not selected
  tables. Exclude `task_access`, core SQL, Valkey, Bao and Gitea. Reject restoring
  Pod bindings as live authority: the destination must independently authorize
  any new task. Stored binding receipts remain historical, not launch grants.
- **Sanitized offline Seaweed tree, not blindly all of `/data`:** exclude unused
  generated key files and environment-specific mini configuration, with an
  explicit pinned-layout policy and dependency checks described below. Reject
  calling a raw PVC archive secret-free.
- **Explicit version unavailability (quarantine):** preserve hashes, marks,
  receipts, quota charges and manifests when bytes are missing/corrupt. Reject
  silently deleting their catalog rows, clearing charges or resealing them as
  successful output.
- **Checkpointed restore reconciliation:** verify versions independently of seal
  replay; retain deletion-plan IDs, notice receipts and warning windows. Reject
  rebuilding plans with new IDs or resetting their clocks: that loses evidence
  and can shorten protection or repeat notices.

## Durable hold and consistent cut

An expanding migration adds a singleton maintenance record with generation,
purpose (`backup` / `restore`), state (`normal`, `draining`, `held`,
`reconciling`), cut timestamp, admission-reopened timestamp and effect key. It also adds durable
restore progress and version availability. No runtime schema creation or local
state-file fallback. Migration statements use `IF NOT EXISTS`; any new SQL
function pins `search_path` and revokes PUBLIC execute.

The new control family provides begin, status and generation-checked release.
A repeated begin with the same key returns its generation; a conflicting key
cannot steal it. A failed drain remains held/draining and retryable. No TTL or
restart automatically releases a hold. Backup release is explicit, including
crash-left holds. A restore release additionally requires a completed reconcile
receipt for that exact generation. Stale release/reconcile cannot reopen writes.

Admission and drain have a shared ordering point in Postgres. Every catalog
write transaction (access/publication, revoke, seal, retention, orphan/attempt
collection, ledger, lease cleanup and owner heartbeat) takes
`pg_advisory_xact_lock_shared(653740016)` in that same transaction, then reads
maintenance state before its first write. Only `normal` admits writes; otherwise
it refuses with `503 maintenance_unavailable`. The persisted name `normal`
means open admission. No transaction spans S3 work. Session loss rolls back
that session's own writes; there is no separate admission session to lose.

Begin first commits `draining`, which refuses each subsequent write/chunk
transaction in every process. It then obtains `pg_advisory_xact_lock(653740016)`
and records `held` in that exclusive transaction. Already admitted transactions
must commit or roll back before held. The 20-second hold-request SQL budget
bounds waiting, not an entire remote transfer. A timeout leaves durable
`draining`; retry can complete it. Reads still work. Shared/exclusive ordering
is identical across subsystem instances and module processes; no in-memory
live-operation set or signal is a correctness fence.

A long PUT stops at its next chunk/completion transaction; a GC or seal pass
stops at its next delete-intent/accounting transaction. S3 calls already in
flight may finish after held, but cannot publish catalog changes. A refused PUT
commit can therefore leave a private orphan, which normal orphan/attempt
sweeps account and remove after release and their grace/ownership checks.
An ambiguous DELETE leaves its existing intent for idempotent retry after
release. **SeaweedFS must still be stopped before cold copy**: held is a SQL
cut, not proof of remote quiescence. The control/restore writers take exclusive
transaction locks and validate generation; restore reconcile is the explicit
held-only administrative writer.

| While held | Behavior |
| --- | --- |
| PUT/reservation, attempt begin, publication, mark, allocate/bind/seal, revoke | Refuse at the next transaction; no later catalog write can commit |
| Retention, seal cleanup, orphan/attempt discovery/deletion/pruning | Refuse the next intent/accounting transaction; already dispatched S3 may settle |
| Retention plan listing, warning confirmation, policy/pin/unpin/reclaim | Refuse; plan GET writes `exposed_at` |
| Authorized object GET/list/range, identity/access checks | Continue unchanged identity/revision/tombstone checks, without lease writes |
| Read-lease cleanup and upload-owner heartbeat | Skip writes while held; expiry remains authoritative and owner freshness recovers after release |
| Hold/status/liveness and explicit generation-checked restore tools | Continue through their administrative transaction fences |

Task reads explicitly use read admission. Core reads check policy even when
lease renewal is skipped. GC cannot advance during that interval.
Release records `reopened_at` once (idempotent release does not extend it).
Every byte-deletion intent, including seal cleanup and orphan/expired-attempt
sweeps, stays pending until `now >= reopened_at + STORAGE_REOPEN_GRACE_MS`.
That grace is `max(STORAGE_READ_LEASE_MS, STORAGE_CORE_READ_PROGRESS_MS)`:
30 seconds, at least both the 30-second lease TTL and the core read's 10-second
per-chunk progress deadline. The first writable core chunk UPSERTs its lease,
even if the read started while held or its old row expired and was pruned.
Normal space-row/lease serialization then protects the active read beyond grace.
No lease/catalog write is allowed while held. Owner rows
are never revived after staleness; a new boot identity is registered after
release using the existing stale-owner checks. The artifact is a historical
cut, not a claim to preserve later revocations.

Backup operator sequence:

1. Suspend the relevant Flux reconcilers (parent platform plus A/D) so they
   cannot undo replica changes. Record their prior suspend/replica state in
   private operator state, not in a platform Secret dump. Keep application task
   launch disabled for the maintenance window. Begin the durable hold; await its
   held receipt. Reads continue while SeaweedFS is serving.
2. Scale SeaweedFS to zero and wait for Pod termination/PVC writer release under
   a bounded operator deadline. No hot-copy fallback. Any late accepted backend
   work is now either on disk or abandoned; it cannot mutate the copied tree.
   A helper mounts only that stopped PVC, never the S3 identity Secret.
3. Dump `storage` alone with PostgreSQL 17 `pg_dump --format=custom
   --schema=storage --no-owner --no-acl`. Keep schema/functions/sequences and
   all tables, including the durable held generation, pending operations,
   leases and upload-owner rows. Use the dump's repeatable-read snapshot also
   for object counts/bytes and cut time (exported SQL snapshot); no separately
   timed totals. Record the applied dbmate version as metadata, not a dump of
   the global migration-history table. Held service skips heartbeat and lease
   writes and refuses revoke until release; the dump captures the SQL cut.
4. Copy the cold PVC through the sanitized-tree policy below. Finalize and
   verify the manifest only after both payloads are complete. A temporary
   artifact is never a successful backup. Failure retains the hold and the
   partial artifact separately for diagnosis; a recovery command can restart
   SeaweedFS and explicitly release the hold without accepting that artifact.
5. After dump/cut copies and verified artifact export, delete SQL and filesystem
   helpers and await termination before restarting SeaweedFS (small-node resource
   requests otherwise prevent scheduling). Verify authenticated backend health, release the matching
   source backup hold, and restore the previous Flux/task-launch state. Always
   print the recovery instruction if interrupted; never silently leave a normal
   source with only half an artifact. Copy and independently verify the finished
   artifact outside the node before claiming disk-loss safety.

## Artifact and credential boundary

One owner-private directory (optional tar transport) contains only
`manifest.json`, `catalog.dump`, and the sanitized `seaweed/` tree. Manifest
version 1 records backup UUID/generation, SQL cut time, dbmate/schema version,
module build identity, Seaweed image digest and sanitized-layout version, exact
relative payload file list with lengths and SHA-256, and live/non-tombstoned
catalog object count and logical bytes. It separately counts tombstoned and
unavailable versions; those are not healthy bytes. The manifest is written last
by atomic rename. The file list excludes the manifest itself; the operator
records its hash separately. Hashes detect damage, not a malicious replacement
of both manifest and contents. Accept archives only from trusted owner custody.

Builder/verifier reject absolute/dot/duplicate paths, links, special files,
unlisted extras, missing files, altered lengths/hashes and unsupported format,
schema or image versions before import. Stream hashing with bounded buffers;
never interpolate display names into paths. Extraction does not follow links or
overwrite destination files. Verify the staged copy again before promotion.
Directory permissions are 0700, files 0600, umask 077. Copy over authenticated,
encrypted transport to owner-controlled encrypted storage; do not upload to Git,
CI artifacts or public buckets. Payloads contain personal data and may contain
user-uploaded secrets; “no secrets” here means no platform signing/login/custody
material is added by the backup machinery, not content inspection of user files.

**Important correction to the starting premise:** the S3 identity is indeed
outside `/data`, but the pinned Seaweed image's OCI revision is
`530be3e37337488ecc34d58441e0bc476e121c93`.
Its [mini source](https://github.com/seaweedfs/seaweedfs/blob/530be3e37337488ecc34d58441e0bc476e121c93/weed/command/mini.go)
creates `.mini_kek_passphrase` and `.mini_sse_kek` under the data directory at
startup (`ensureMiniDevSSES3Keys`), independently of `-s3.iam=false`.
Do not print, hash into diagnostic output or copy those keys. Exclude both and
`mini.options` from the staged tree; startup regenerates these from destination
configuration/custody. The coordinator's fresh pinned-image names inventory also
contains `admin/.session_key` and `admin/plugin/**` job state. The trusted
`layout.excludedDirectories` field excludes the entire audited top-level `admin`
subtree by names/types only, never opening its files. Only `admin` is currently
approved: validation refuses data roots, nested exclusions, overlapping required
paths or copied patterns. `admin/.session_key` is never copyable under any policy.
Destination Seaweed regenerates the admin session and plugin state on start; old
sessions, schedules and job history are deliberately not restored. The coordinator
must verify this regeneration in its destination walk. The tracked
`deploy/platform/storage-seaweed-layout.json` policy is tested against all 125 names
in `tests/fixtures/seaweed-mini-layout-names.txt` and all 128 seeded names in
`tests/fixtures/seaweed-mini-layout-names-seeded.txt`, with narrow anchored dynamic
volume/LevelDB/master-snapshot patterns. Collection volumes such as
`lifemodel-storage_2.dat`, `.idx` and `.vif` appear at the volume root once data is
written. The policy carries no operator attestation. Preserve volume/master/filer
metadata and object data,
including hidden database files, using a pinned layout policy rather than a
broad “skip hidden files” rule.

This exclusion is valid only for this module's current unencrypted S3 PUTs:
`loader/src/storage-object-s3.ts` forwards no SSE headers, clients cannot choose
backend headers, embedded IAM/admin are disabled, and static identities stay
in memory (upstream
[credential manager](https://github.com/seaweedfs/seaweedfs/blob/530be3e37337488ecc34d58441e0bc476e121c93/weed/credential/credential_manager.go),
`SetStaticIdentities`). The upstream
[SSE manager](https://github.com/seaweedfs/seaweedfs/blob/530be3e37337488ecc34d58441e0bc476e121c93/weed/s3api/s3_sse_s3.go)
checks for an existing filer KEK even when given a generated local key.
Phase 2 must establish the supported fresh layout with the pinned image and
reject an existing filer KEK, encrypted object dependency, dynamic IAM state or
unexpected config/secret file rather than stripping required recovery material.
Check bucket default encryption as well as individual PUT behavior. Restrict
this format to a fresh, module-only, never-IAM/never-SSE history; checking only
current logical metadata cannot prove removed credentials absent from database
logs or old volume bytes. A names-only inventory and absence assertions for
filer KEK/IAM locations are necessary but not sufficient for arbitrary reused
PVCs. **Coordinator-approved scope:** this narrow sanitized cold-copy format requires
the coordinator's pinned-image proof; arbitrary reused PVCs remain unsupported.
If the fresh-layout exclusion cannot be proven, stop; do not ship a sanitized
archive that loses encrypted bytes or claims credential absence without evidence.
A raw encrypted full-PVC backup needs a different custody contract and is not
approved here.

Never copy `seaweed-s3-identity`, projected tokens, TLS keys, SQL passwords,
OpenBao records or loader volumes. The destination uses its own fresh Bao/S3
identity and CA. The loader validates the CA's noncritical SKI and issues both
edge and storage leaves with SKI and AKI equal to the issuer's SKI. Bootstrap
reissues old missing-identifier leaves under the existing valid CA; an installed
CA missing SKI fails closed without automatic rotation or a compatibility shim.
Such a disposable test VM must be reprovisioned. The runbook must verify that source credentials cannot read
restored storage and destination credentials can. A generic Secret backup is
neither needed nor allowed.

## Restore into an empty storage instance

1. Install the same signed platform/schema/image versions and let A0→A→B→C→D
   establish fresh custody and migrations. Disable task launch and suspend the
   relevant Flux reconciles before stopping workloads. Stop storage-module and
   SeaweedFS; confirm no Pod uses the PVC. The helper has no automatic startup
   relationship to A0 or D.
2. Verify artifact and compatibility completely before destructive work. Refuse
   a nonempty destination `storage` catalog or non-pristine Seaweed data; only
   the install-created empty bucket/layout may be replaced. No merge/overwrite
   mode. Keep failed staged imports quarantined and retryable, not “empty”.
3. Stage and verify the Seaweed tree on the destination PVC without source
   secrets or mini options. Restore only `storage` using `pg_restore
   --single-transaction --exit-on-error --no-owner --no-acl`, replacing its
   verified-empty schema. Restore DDL/post-data triggers around the dump data,
   not trigger-driven row inserts that double-count `instance_ledger`. Do not
   change core migrations, `task_access` or global roles. A failed import never
   enables the module. Record `restore` purpose/new generation and artifact
   identity durably before starting any module process. The dump itself already
   contains a hold, so accidental early startup still cannot enable writes/GC.
4. Start SeaweedFS with destination custody. Start storage-module; its first
   action checks the maintenance record. No `retention.start()` or mutation
   intake is enabled while held/reconciling. Liveness stays available. Status
   exposes safe hold/generation/progress/unavailable counts, not filenames or
   credentials. Read readiness returns 503 `restore_pending` until safety
   classification completes; ordinary backup holds leave readiness usable for
   reads. Restore verification never depends on live historical task Pods.
5. Run/retry bounded reconciliation pages (100 rows, request-owned SQL/S3
   deadlines), checkpointed by generation. Inventory every referenced immutable
   version, including previously sealed and manifest-committed spaces; validate
   actual bytes with streaming SHA-256 and length in at most 4 MiB chunks.
   HEAD checksum alone and replayed seal receipts are not rehash evidence.
   Validate empty objects against the backend too. Confirmed 404 is `missing`;
   hash/length mismatch is `corrupt`; auth/network/timeouts remain retryable
   store failures, never classified as data loss. Start every version as
   unverified for the restore generation; only successful validation makes it
   available. GET/list, same-upload-ID receipt replay and core read authorization
   must not report an unavailable version healthy (including zero-byte GET).
6. Validate manifest hashes/membership, seal states, tombstones, deletion-plan
   membership/revisions/receipts and original warning deadlines without new
   identities. Clear old read leases only after confirming the stopped source
   cannot serve the destination; never revive its upload-owner heartbeats.
   Inventory private backend-only keys as accounted orphan debt; retire abandoned
   attempts through the existing ownership/publication fencing rules. Validate
   per-space quota against surviving intents, retained versions and confirmed
   deletions, and instance quota against space totals plus outstanding orphan
   debt. Missing bytes retain their logical charges. Repair only derivable totals
   transactionally; structural inconsistency leaves restore pending.
7. Inventory backend-only private residue and abandoned attempts without
   deleting anything under the restore hold. Charge orphan bytes that are not
   already owned by a reservation or retained version as instance ledger debt.
   Reserved expired attempts retain their reservation charge. Ordinary retention
   GC removes eligible residue only after release, using its existing owner,
   publication and two-day grace checks. No recovery-only deletion bypass exists.
   Deleting candidates retain their tombstones and retry intents; validate,
   do not resurrect or prematurely complete them. Inventory pages are retryable
   from the saved backend cursor.
8. Complete the reconcile receipt. If missing/corrupt versions exist, expose
   degraded/unavailable status and require explicit operator acceptance of that
   recorded count before generation-checked release; no successful clean-restore
   claim. Otherwise release normally, start ordinary collection, and restore
   Flux/task-launch state. Read checks always honor availability, even after a
   degraded release. An interrupted restore stays held and can be resumed; an
   operator can discard the stopped empty-target attempt and repeat import,
   never force-release unverified restored rows.

Restoring storage alone does not restore running Jobs, core task history or
core's Valkey notice receipts. Old task tokens/Pod bindings remain denied on a
fresh cluster; a surviving core still enforces current canonical intent and live
Pod checks. Existing warned storage plans keep their notice receipt/window. A
pending plan re-listed from an older cut is suppressed by core's permanent
Postgres owner-message row if core survived. With fresh core state it is warned
again, which is safe; this is not whole-instance exactly-once recovery.

## Checks, operator walk and limits

These are **phase 2 obligations**, not passing evidence. Proposed new test files
stay under `tests/`; reuse `tests/helpers/storage-retention-harness.ts`, the
SigV4 fake S3 and real isolated Postgres, not fake catalog behavior.

| Constraint / origin | Planned check |
| --- | --- |
| Consistent cut and resumable hold (brief / S-D7) | Hold refuses PUT/mark/seal/allocation and plan mutations; pause candidate/attempt/orphan GC already poised at S3 dispatch; active operations settle or return hold pending; restart preserves hold; stale release fails; later valid release works |
| Read safety and availability (S-D2 / S-D7) | Authorized task/core GET/list/range continue while held without lease writes; revoke refuses; cross-space/revoked/tombstoned reads remain denied; missing and corrupt versions, including empty GET and completed upload replay, never pass healthy |
| Artifact integrity and credential exclusion (brief / S09) | Builder/verifier tests alter one byte, omit/add a file, introduce traversal/symlink and secret-canary files; all fail import; pinned-layout sanitized copy excludes mini keys/options and unsupported dependencies fail closed |
| Restart-safe reconcile (S-D4 / S-D5 / S-D7) | Kill/retry between pages; preserve marks/manifests/receipts/tombstones/warning windows; correct quota totals including orphan debt; infrastructure failures remain pending; wrong generation never releases |
| Full storage-set recovery (S09) | Coordinator VM walk below, not claimed by the fake S3 tests |

Phase 2 supplies an exact operator runbook/script beside `deploy/platform/`,
using the loader image's administrative CLI plus explicit operator-created,
bounded PVC helper commands/Jobs. It must include interruption recovery and
cleanup, pinned tool images, fixed Secret-key projections (never dumps), and
matching reverse NetworkPolicy permissions where needed. No standing cluster
mutation RBAC is added to the loader/module; privileged scaling, suspension and
helper creation use the operator's kubeconfig. PostgreSQL dump/restore tools
come from the existing pinned PostgreSQL image/helper, not a new npm dependency.
New CLI runtime TypeScript is covered by `.dockerignore`'s existing
`!loader/src/**/*.ts`; a new executable wrapper needs its own explicit entry.
A/D remain after A0 and stores; no Job becomes a prerequisite of normal bootstrap.

The coordinator's WALK-STORAGE-RESTORE script must seed **32 deterministic
4 MiB objects across two spaces plus two interrupted uploads**, with marked,
unmarked, sealed, revoked and tombstoned examples; save a private expected
inventory; restart; backup; restore on a fresh empty install with different
custody; compare actual downloaded hashes/lengths, marks, manifests/receipts,
read denials and tombstones; confirm partial uploads remain unpublished and
are reclaimed/accounted by policy. Record generation, backup age, unavailable
count (zero for the clean drill), object count, checked bytes, elapsed restore
time and each command's own exit status. Read through module identities; only
the custody negative test uses direct signed S3 as an operator. The worker does
not touch the VM or claim this evidence in advance.

Development uses TDD and only `lifemodel-heavy node scripts/test-isolated.mjs`
for tests/checks. Before final submission merge `origin/main`, run the full
isolated `check` on the final tree and report its own exit status. Mutation
checks must catch GC running through hold, a changed-byte artifact being
accepted, missing bytes returning healthy, reads blocked solely by hold and
platform secret material entering the artifact.

Deliberately out: lifemodel-zir8 whole-instance backup (core SQL, Valkey, Bao,
Gitea), multi-node/online snapshots, new IAM or SSE support, disk-loss objectives,
key rotation, task resurrection, upstream image upgrades and publishing or
running the VM walk. Existing hold/status infrastructure must not introduce
LLM polling or a file-backed durable state path. This note extends ADR-015's
recovery mechanism; it does not weaken its custody/isolation principles.
