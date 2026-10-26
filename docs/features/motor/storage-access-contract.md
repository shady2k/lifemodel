# Storage authorization contract

Task: lifemodel-653.7.2. Historical leaf scope: ADR-015 S-D2 and check S02's
authorization core. The current module also serves the [object API](storage-objects.md),
[allocation/seal](storage-seal.md) and [retention](storage-retention.md) routes.
This is not a deployed acceptance record.

## Durable read contract

Migration `20261015000012_create_task_access.sql` adds these tables:

- `task_access.intents`: stable canonical access authority for one
  `(task_id, attempt_id, launch_id)`. The fenced registry in
  `src/storage/postgres-task-registry.ts` initializes it before verified binding,
  then **UPDATEs in place**. It never deletes/reinserts it or appends a new
  authority row to evade its lock. Revisions increase, terminal revoke never
  reopens, and deadlines are finite canonical absolute timestamps. The storage
  module reads this authority; it does not write it.
- `task_access.projections`: gateway-verified immutable binding from those IDs
  to actual Job UID, Pod UID and space. `intent_revision` orders the lifecycle
  projection; `access_revision` is the independent storage catalog fence. The
  projection also carries mode and deadline fields. Migration
  `20261015000014_create_storage_seals.sql` adds nullable `pod_name` and
  `job_name` locators. The gateway writer in `loader/src/task-identity.ts`
  persists both together with the verified UIDs from
  `loader/src/task-kubernetes-identity.ts`: Pod name comes from its TokenReview
  `authentication.kubernetes.io/pod-name` claim; Job name is deterministic from
  launch ID under ADR-014 D3 and must match the actual controller reference.
  Both names must be Kubernetes DNS names. Namespace is fixed to
  `lifemodel-motor`. Missing names fail bind closed. Core supplies no names or
  UIDs. The storage module independently GETs the named Pod and Job with existing
  GET-only RBAC, verifies non-deletion, task service account, exact UIDs and
  controller ownership. No list/watch right or label lookup is added.
  Only canonical intent
  deadlines authorize; lagging projection fields cannot extend them. A future
  projection revision, absent authority/binding/space or storage-revision
  mismatch denies. A stale active projection cannot defeat a committed intent.
- `storage.revoke_receipts`: globally keyed durable request/receipt with space,
  expected revision, resulting revision and receipt ID. Reusing a key for any
  different request conflicts. Original requests replay the original receipt.

`storage.spaces` remains the existing module catalog. No launch registry,
briefing, secret, grant or outcome is copied here. The interim core-owner SQL
login is unchanged, per ADR-015's owner amendment; scoped leased roles remain
lifemodel-2t5. The module does not migrate its own schema. Core's existing
migration initContainer applies expanding dbmate migrations.

### Persisted owner-notice read contract

Migration `20261015000018_create_storage_owner_notices.sql` adds
`core.storage_owner_notices(message_id, committed_at)`. Like the task-access
projection, this is a narrow SQL read contract, not ownership of core's tables.
It exposes only permanent nonempty assistant/web message rows with canonical
storage-warning IDs and matching channel keys; no text, recipient, briefing,
secret or grant is exposed. `committed_at` is the row's insertion timestamp,
visible after commit, not the database's exact commit wall time. No data copy or
runtime schema creation is involved.

Before recording a new warning, the module checks the plan's canonical message
ID and its presence in this view in the same maintenance-fenced transaction.
Missing or wrong-plan receipts return `503 warning_receipt_pending` without
starting the deletion clock; the plan stays pending and retryable. See
[retention](storage-retention.md#persisted-owner-notice-receipt) for timing and
replay semantics. Lifemodel-2t5 must grant module `SELECT` on exactly
`core.storage_owner_notices`, not core conversation tables or all core relations.
The existing task-access read contract is unchanged.

## Each chunk and publication

`createStorageAccess` in `loader/src/storage-access.ts` creates the authority.
The shipped object adapters use this contract:

1. `openTaskStream({ token, space, signal? })` **before** asynchronous transfer
   work. The caller reads its projected service token afresh for each request.
2. `stream.chunk(bytes, dispatch)` for each bounded chunk (maximum 4 MiB).
   It performs audience-specific TokenReview, current non-deleting Pod and
   controller Job GETs, then a bounded SQL transaction. It locks exactly one
   stable intent plus verified projection, then exactly one catalog space,
   then performs one joined authoritative read with one database wall-clock
   instant after lock waits. No positive identity/mode cache is used.
3. The trusted module-only callback dispatches that one chunk **synchronously**.
   It returns `undefined`, never a Promise, a reusable permit or scheduled
   transfer. Await socket drain or backend I/O **outside** the guard. Async
   callbacks are rejected before invocation; arbitrary trusted closures cannot
   be sandboxed, so deferred dispatch must reenter the guard instead of retaining
   its decision. SQL locks never span a network transfer/drain.
4. `stream.publish({ text, values })` for immutable-object publication or mark.
   Supply one fixed, parameterized **module-owned metadata SQL statement**, not
   request SQL or transaction-control SQL. It repeats identity and authorization,
   executes that statement under the same locks and resolves only after COMMIT.
   It returns only the committed statement rows to the trusted module, so object completion statuses can be checked. No Client or mutable SQL permission escapes. Write private immutable S3 bytes
   outside the transaction first; ACK durable metadata only after publication
   resolves. A transient chunk callback is not a durable metadata operation.
5. Observe `stream.signal` to cancel transfer resources immediately, and call
   `stream.close()` in `finally`. Close is idempotent and cannot unregister a
   newer stream. A closed or revoked stream never authorizes again.

Canonical lifecycle UPDATEs and catalog revoke/freeze UPDATEs conflict with the
short share locks. Thus an already-authorized chunk can finish, but a committed
intent cannot be bypassed by an old joined snapshot. Missing lock targets deny
before a later first binding/space can appear. No SQL lock waits on byte I/O.

## Revoke and topology

`revoke(space, expectedRevision, effectKey)` uses a global per-effect SQL
advisory transaction lock, checks the receipt before the revision CAS, increments
storage revision, stores the receipt and commits. Before returning/ACK it aborts
all registered local streams for that space, including receipt replay. A second
process's fresh decisions are denied by the SQL fence, not by local maps.

Active-stream cancellation at ACK depends on the declared **one replica,
Recreate** deployment. Never scale it or overlap rolling instances without a
distributed cancellation barrier. Process restart closes its old sockets; SQL
revision and receipt survive. Bytes authorized before revoke cannot be recalled.
There is no cross-service zero-time revoke claim under partition.

## Listeners and identity

- Health HTTP 8081: `/status`, `/livez`, loader namespace AND Pod peer only.
  Readiness includes authorization DDL in the existing `checkStore` sequence;
  empty projection tables are ready, missing tables are not.
- Task TLS 8443: `GET /spaces/:space/access` proves current own-space access;
  `GET /ping` is an unauthenticated transport check, never data authority.
  Audience `lifemodel-task-storage`, SA `lifemodel-motor:task`, bound live Pod
  and its exact controller Job. The [object routes](storage-objects.md) serve
  own-space PUT/GET/list/mark on this listener.
- Control TLS 8444: `POST /revoke` with exactly
  `{ space, expectedRevision, effectKey }`; revision is a decimal string.
  Audience `lifemodel-core-storage-control`, SA `lifemodel:core`. [Storage seal](storage-seal.md) also adds keyed allocate/bind/seal on this listener.
- Read TLS 8445: `GET /identity` proves either core or web identity, audiences
  `lifemodel-core-storage-read` / `lifemodel-web-storage-read` respectively.
  SA must be `lifemodel:core` / `lifemodel:web`. Core-only marked-object reads are now implemented by [storage seal](storage-seal.md); that adapter must repeat identity verification on
  every read chunk. No control route exists on this listener.

All three TLS listeners share the existing instance-CA leaf and reload path.
Core/web prove their current bound Pod too. Namespace alone, labels, claimed
IDs and SA-only tokens never authorize. Each listener peer combines namespace
AND Pod selectors on both ingress and reverse caller egress. The inherited
namespace-only OpenBao egress peer is an explicit exception: TCP 8200 to the
`openbao` namespace; OpenBao's own default deny and server ingress restrict the
receiving side. The Kubernetes API is the separate port-6443 ipBlock exception,
not a Pod-selector peer. Cluster RBAC permits only
TokenReview creation; namespaced RBAC permits Pod GET in the two caller namespaces
and Job GET only in `lifemodel-motor`. No list/watch, Secret or mutation rights.
The k3s API egress follows the platform's port-6443 exception; it grants no API
right. Task SA has zero RBAC; `src/core/kubernetes-task-executor.ts` projects
separate model, storage and channel audience tokens into each Job.

Core/web service-audience token projections and rotating read-only mounts define
the integration contract. The wired core retention reconciler already uses the
control token and public CA through `src/core/storage-control-client.ts` (see
[core warnings](storage-retention.md#core-side)). `src/web/server.ts` authorizes
owner attachment downloads; `src/storage/task-artifact-reader.ts` reads each
artifact through the web-only artifact route with fresh projected tokens and
CA-only trust. Web has no generic object GET/list permission. Core object-read
consumers remain later integration work. Every consumer must load fresh tokens
and verify TLS against CA-only instance trust, not disable verification or mount
the module's private key.

Identity API 5xx, transport and timeout failures are `503 identity_unavailable`;
TokenReview unauthenticated, audience/SA/binding mismatch, missing/deleting bound
resources and API 401/403 refusals remain `403 identity_denied`. Each listener
request denial and each successful revoke (including replay) emits one line with
only `{ id, code, status, space }`. Revoke uses its saved receipt ID; denial uses
the returned error ID. A validated opaque space ID is logged when known,
otherwise null. Tokens, effect keys, bodies, paths and connection strings never
enter these diagnostics. A missing revoke space is `404 space_not_found`, distinct
from `409 revision_conflict`. Readiness still proves stores/DDL, not API RBAC.

No first-start phase or A0→A→B→C→D dependency changes. D needs SQL schema,
Bao and SeaweedFS, never task Jobs or nonempty authorization rows. Historically,
this authorization leaf did not implement pressure controls. The current module
wires [bounded admission, reserved workers and fair scheduling](storage-objects.md#transfer-bounds)
from lifemodel-653.7.7. Repository pressure checks do not replace deployed RSS
and network acceptance.
