# Storage authorization contract

Task: lifemodel-653.7.2. Implements ADR-015 S-D2 and check S02's authorization
core. This is not the object API or a deployed acceptance record.

## Durable read contract

Migration `20261015000012_create_task_access.sql` adds these tables:

- `task_access.intents`: stable canonical access authority for one
  `(task_id, attempt_id, launch_id)`. The future core fenced lifecycle writer
  initializes it before verified binding, then **UPDATEs in place**. It must
  never delete/reinsert it or append a new authority row to evade its lock.
  Revisions increase, terminal revoke never reopens, and deadlines are finite
  canonical absolute timestamps. Stage 3 owns that writer, not this module.
- `task_access.projections`: gateway-verified immutable binding from those IDs
  to actual Job UID, Pod UID and space. `intent_revision` orders the lifecycle
  projection; `access_revision` is the independent storage catalog fence. The
  projection also carries mode and deadline fields. Only canonical intent
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

## Each chunk and publication

`createStorageAccess` in `loader/src/storage-access.ts` creates the authority.
Object adapters in lifemodel-653.7.5 must call:

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
   No Client or mutable SQL permission escapes. Write private immutable S3 bytes
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
  and its exact controller Job. Object routes arrive in lifemodel-653.7.5.
- Control TLS 8444: `POST /revoke` with exactly
  `{ space, expectedRevision, effectKey }`; revision is a decimal string.
  Audience `lifemodel-core-storage-control`, SA `lifemodel:core`.
- Read TLS 8445: `GET /identity` proves either core or web identity, audiences
  `lifemodel-core-storage-read` / `lifemodel-web-storage-read` respectively.
  SA must be `lifemodel:core` / `lifemodel:web`. Owner object reads/marked-only
  selection arrive in .7.5; that adapter must repeat identity verification on
  every read chunk. No control route exists on this listener.

All three TLS listeners share the existing instance-CA leaf and reload path.
Core/web prove their current bound Pod too. Namespace alone, labels, claimed
IDs and SA-only tokens never authorize. Each network peer combines namespace
AND Pod selectors on both ingress and reverse egress. Cluster RBAC permits only
TokenReview creation; namespaced RBAC permits Pod GET in the two caller namespaces
and Job GET only in `lifemodel-motor`. No list/watch, Secret or mutation rights.
The k3s API egress follows the platform's port-6443 exception; it grants no API
right. Task SA has zero RBAC; Job token projection is stage 3's launcher work.

No first-start phase or A0→A→B→C→D dependency changes. D needs SQL schema,
Bao and SeaweedFS, never task Jobs or nonempty authorization rows. Pressure,
reserved workers and request admission caps remain lifemodel-653.7.7; this guard
has finite API/SQL/chunk bounds but does not claim its pressure acceptance.
