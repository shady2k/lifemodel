# ADR-015: Platform storage module for task output

Date: 2026-10-20. Task: lifemodel-653.5 (motor-1).

## Status, context and ownership

Direction confirmed by the owner's 08:40 comment on lifemodel-653.5; record
proposed for independent review. Not built or accepted on a deployed instance.
[ADR-014](014-task-runtime.md) owns launch, live steering and task outcomes;
[this component/sequence view](../features/motor/tasks-design.md) joins them.
This separate record is clearer than a section in 014: storage has independent
platform custody, durable metadata, repair/backup, byte-path availability and
core/web/task consumers. It is not a core library renamed “module”.

The owner rejected coupling task bytes to core: core allocates space, task uses
it directly, core decides when to seal and retain it. The owner also chose
SeaweedFS and accepted that every byte crosses a separate storage module.
The module has its own small API/CLI, not a client-visible S3 endpoint. It alone
holds SeaweedFS credentials. Tasks, core and web never get a storage key.

Today's Motor copies workspaces to local directories and best-effort local
logs. `DATA_PATH` is not durable state. Reuse existing Postgres/domain ports,
platform image/custody/auth patterns of ADR-013 and the selected SeaweedFS
`weed mini` evidence from [task-runtime research](../research/task-runtime.md).
The new storage module owns byte confinement, allocation, quota, mark/seal and
metadata in its own `storage` Postgres schema. The task registry stays core's.
No Seaweed IAM rule is trusted as the task-isolation boundary.

## Decision drivers (same order as ADR-014)

1. **Isolation:** task A cannot list/read/write B; no signing key, presign or
   direct S3/filer/admin route escapes storage custody.
2. **Nothing lost:** ACKed bytes and marked results survive core/module restart;
   revoke/seal/delete are recoverable; one manifest receipt survives lost reply.
3. **Consent:** runtime artifact operations confer no unrelated external access;
   current task state/revocation is checked by module, never client claims.
4. **Live use:** task can save/read output while core is down; Stop/revoke must
   not wait for a slow upload or depend on positive liveness caches.
5. **Replaceability:** small API hides S3 backend; Seaweed replacement changes
   only module adapter/data migration, not harness/core/web callers.
6. **Limits:** enforce actual accepted bytes/reservations and owner retention,
   not claimed Content-Length or a backend prefix policy alone.
7. **Visibility:** sealed hashed manifest, partial-output reason, retained logs,
   current usage/pins and one batched pre-deletion warning.

## Constraints (closed requirements and their checks)

S01–S10 are the complete additional constraints. Tests/walks are **future stage
obligations**, not existing passing tests. Together with ADR-014 T01–T12 there
are **22 constraints**. Size fixtures are concrete evidence, not production
limits beyond the owner-declared 20 GB logical-storage ceiling.

| ID | Requirement / origin | Concrete check and fixture |
| --- | --- | --- |
| S01 | Separate signed platform-owned service; **only storage module** holds Seaweed credentials; all clients speak its own API (owner) | `tests/unit/storage-module-boundary.test.ts`: forbidden S3/signing imports outside module; WALK-STORAGE-BOUNDARY: **two tasks + core + web**, direct S3/filer/admin denied, no key in caller specs/env/files/logs |
| S02 | Module validates audience, live Pod/Job/task binding and current mode itself; confinement/revocation independent of Seaweed IAM and core availability (owner) | `tests/integration/storage-module-auth.test.ts`: **two task spaces**, wrong token/UID/path, core down, API down, revoke mid-PUT/GET; no read/write chunk linearizes after revoke ACK |
| S03 | ACK only after immutable bytes and metadata are durable; retry idempotently; no path traversal/symlink/special file or cross-space name (nothing-lost/isolation) | `tests/integration/storage-module-objects.test.ts`: **32 objects**, duplicate/conflicting IDs, byte/hash mismatch, lost ACK, malicious names; restart between object write and metadata commit |
| S04 | Allocate/bind/revoke/seal are keyed, revisioned and recoverable; seal makes space read-only, hashes marked files and deletes the rest (owner) | `tests/integration/storage-module-seal.test.ts`: **two spaces, eight objects each**, kill at freeze/hash/manifest/delete/receipt; replay same sealed receipt and retained marked bytes only |
| S05 | Persist log/result while running; hard Stop keeps only already stored+marked output; unacknowledged bytes are explicitly not guaranteed (owner) | WALK-TASK-STOPS + `tests/integration/task-storage-stop.test.ts`: **two Jobs**, soft wrap vs hard kill during PUT/mark, module restart; logs/result chunks marked incrementally and no fabricated complete artifact |
| S06 | Retention defaults **90 days**, supports forever/pin; instance logical output ceiling **20 GB = 20,000,000,000 bytes**; no silent protected-data eviction (owner + explicit unit choice) | `tests/integration/storage-module-retention.test.ts`: clock at 89/90/91 days, pinned/forever/unpinned; quota ledger fixture at **20 GB** with boundary ±1 byte, **100 object metadata rows**, concurrent reservations and stale settings revision |
| S07 | One batched warning per deletion plan precedes deletion; pin/read/seal races cannot resurrect or delete protected output (owner) | `tests/integration/storage-module-gc.test.ts`: **100 artifacts**, one batch/notification key, owner pin after warning, two GC contenders, active reader and crash before/after delete; zero per-item notices |
| S08 | Owner downloads through authenticated same-origin web→module; no raw S3 client/URL, no unsafe inline artifact execution (ADR-011/012, owner) | `tests/integration/task-artifact-download.test.ts`: **two owner sessions, two artifacts**, expired session, traversal, CRLF filename/HTML content, range/reconnect and mid-read expiry; WALK-TASK-PANEL in Chromium + Firefox |
| S09 | Seaweed **single-node weed mini** with persistent volume, auth fail-closed, internal-only S3; recover objects + filer metadata + IAM/custody + SQL catalog together (owner/research) | WALK-STORAGE-RESTORE: one fresh k3s node, **32 objects of 4 MiB plus 2 partial uploads**, restart and restore into empty instance; hashes/marks/read denial/tombstones match; record measured restore time and backup age |
| S10 | Bounded transfer/memory/client pressure and safe diagnostics; task stream cannot starve another or web; health never reports a failed store as empty (limits/visibility) | `tests/integration/storage-module-pressure.test.ts`: **20 simultaneous streams, 2 tasks + web**, 4 MiB chunks, induced disk/API/SQL failure, quota/429/backpressure; WALK-STORAGE-LOAD records RSS/latency, no unbounded buffer or secret/body in diagnostic logs |

## Decisions

### S-D1. One platform-owned reference monitor, Seaweed behind it

Deploy `storage-module` in `lifemodel-system`, signed/digest-pinned in the
platform release like model gateway (ADR-013), with a separate process/service
account and readiness/metrics listener. It is not generation-editable code.
Its OpenBao role reads only the named Seaweed custody record; secrets live in
memory, refresh/rotation is bounded and fail-closed. No model keys, loader root,
unseal material or unrelated store rights. Module SQL credentials scope only
to its catalog and narrow task-authorization read described below. Seaweed's
own S3 auth configuration is provisioned by trusted bootstrap in platform
custody; no caller or generation holds those signing credentials. Seaweed must
validate service credentials: missing auth config refuses readiness, not an
anonymous mode. Basic static service signing is sufficient; STS inside module
is optional defense in depth, never the task boundary.

SeaweedFS is a single `weed mini` StatefulSet/PVC with explicit flags, one
writer/Recreate updates and all unneeded admin/WebDAV/catalog ports disabled.
Only module→S3 is permitted. Filer/master/volume ports remain private to the
Seaweed process; tasks/core/web cannot bypass the module through them. Do not
use chart defaults (`emptyDir`/anonymous S3) or assume one disk is redundancy.
Persist data, filer metadata and auth/configuration; platform keeps custody.
The initial pin is research's **4.48 digest** after release verification;
upgrades require the same contract/restore checks, not a mutable latest tag.

Module task, trusted control, trusted read and health surfaces are separate
listeners with namespaceSelector **AND** podSelector policy peers. Tasks reach
only task data API; core reaches allocate/bind/revoke/seal/retention control and
read; web reaches owner-read only; loader handles settings, not raw files.
TLS uses platform CA/trust; tokens never travel over plain HTTP. Module egress
only DNS, Kubernetes TokenReview/Pod/Job verification, its scoped SQL/Bao and
Seaweed S3. No Internet and no model route. No caller can choose upstream host,
bucket, prefix or IAM policy in an API argument. The module maps opaque space/
object IDs to private S3 keys internally.

### S-D2. Identity, independent authorization and immediate revocation

Task requests carry a freshly read projected `lifemodel-task-storage` SA token.
Module performs audience-specific TokenReview and verifies the bound Pod UID,
current non-deleting Pod/controller Job UID and recorded space binding. The
launcher's claimed task ID and any label are lookup hints, not proof. Namespace
and zero-RBAC SA alone do not distinguish two tasks. No fallback on API failure;
no positive token/liveness cache can outlive a revoke. Core/web also use their
own service-audience projected identities on their distinct listeners; web
cannot call control operations. Authorization is operation-shaped, not shared
namespace trust.

A platform task-control component maintains a **narrow SQL authorization
projection** (task/attempt/launch IDs, verified Job/Pod UIDs, access revision,
mode active/wrapping/revoked) from committed lifecycle intents and actual API
objects. Core writes lifecycle intents through its fenced operations; storage
cannot edit the core registry or infer liveness solely from an unfenced message.
Module performs its own live checks and reads current revision at each
operation/chunk; no synchronous call to the core process is required. Missing
projection/binding fails closed until reconciled. Control component can revoke
without cognition; lifecycle-watch failure rejects fresh access rather than
assume active. This projection contains no briefing, secret or grants and is
not a second task outcome/launch registry.

`revoke(space, expectedRevision, effectKey)` fences data operations in the
module's own catalog. **Immediate** means linearizable at the durable revoke
commit/ACK, not “wait for JWT expiry”: no PUT/mark/read chunk can authorize after
that point. Streaming work acquires a per-space access revision guard for each
bounded chunk and publication; revoke cancels active streams, invalidates read
leases, increments revision and wins before ACK. Do not hold a long SQL lock
for an entire network transfer. Bytes already sent to a client cannot be
recalled; buffers authorized before revoke can have reached it. No new chunks
are scheduled after revoke. If module is unreachable, hard Job deletion still
starts immediately; a deleting/missing Pod is rejected when the service returns.
No zero-time cross-service revocation is claimed under partition.

Soft wrap sets mode wrapping: task may put/get/list/mark its own space and use
model/channel to finish, but no external-effect grant. Hard revoke closes task
reads and writes; core/web read sealed marked output through their own roles.
At seal, all task rights end even if a token has time left. Task identity grants
no owner retention/pin/delete/control permission and cannot allocate a space.

### S-D3. Small API and workbench CLI, not S3 by another name

Task API semantics (exact route spelling may be fixed by implementation):

| Operation | Contract |
| --- | --- |
| `put(relativeName, uploadId, length, sha256, bytes)` | Write immutable version in **own** allocated space; measured bytes/hash must match; conflicting retry ID rejected, same completed ID returns same object receipt |
| `get(objectId, range?)` | Own space only while active/wrapping; bounded range under current revision; after seal task loses access, core/web use read role |
| `list(cursor, limit)` | Own names/IDs/size/hash/mark only; opaque stable page cursor, no buckets/root/prefix selector |
| `markResult(objectId, role)` | Mark a completed immutable object version as artifact, result or log; binding survives restart; idempotent; never a command to publish outside storage |

Small `lifemodel-storage` CLI is baked into the workbench, reading the projected
token from its mounted file. Harness uses it as a tool; caller supplies no key
or presign. The CLI resolves local files with no symlink following, rejects
special files/path escape and uses canonical relative UTF-8 names; server
validates names/bytes independently and stores IDs rather than filesystem paths.
Reject empty, absolute, dot-segment, NUL/control, ambiguous normalized or encoded
separator names; name is display metadata, never directly concatenated to key.
No credential parameters or raw URL output. Core/web domain adapters implement
the same API, no SDK route around it. Marking is not a grant to send a file to
another service; owner attachment is a separate read reference.

Transfer design default: at most **4 MiB per chunk**, server bounds headers,
body, listing and open transfers before reading. Chunking is module protocol,
not task-facing S3 multipart; objects commit only after every chunk/hash check.
Reserve declared bytes transactionally against quota before accepting chunks;
count actual bytes, reject surplus early. An upload ID cannot be reused to
change name/content. Incomplete uploads have finite lease/GC and consume a
reservation until canceled/collected. Logs/results use immutable small chunk
objects and mark each acknowledged chunk immediately; final logical log index
references these in order. Complete regular artifacts require successful PUT
**and** mark ACK; a half upload never becomes a named complete artifact.

S3 write first, catalog publication second: use private unique immutable keys,
verify backend persistence/checksum response, then commit SQL receipt/charged
bytes and return ACK. Lost SQL response retries by upload ID; pre-publication
objects are private orphans tracked by intent, never listed. A crash after SQL
commit returns the saved receipt. Never claim an atomic S3+SQL transaction.
Diagnostics contain IDs, byte counts, status/check codes only; retained task
logs are separately authorized private content, credential-filtered at source.

### S-D4. Allocate, bind, freeze, seal, publish

Core `allocate(taskId, launchId, effectKey, retentionRevision)` creates exactly
one space before Job launch. Allocate response carries opaque space ID, not a
secret. `bind` accepts only the registered actual Job/Pod UIDs through the
platform control identity; the task cannot self-bind. Restart returns same space.
Core can read task output through module while running; web only sees objects
already marked, never arbitrary unmarked workspace staging. Owner downloads
need not wait for final seal if a marked immutable object already exists.

Core records terminal candidate and ends compute, then requests keyed seal.
Seal is a recoverable state machine owned by module:
`open/wrapping → frozen → manifest-committed → sealed`; cleanup is tracked
separately. Freeze increments access revision and closes task writes/mark calls.
For normal/soft end a prior write-quiescence barrier lets acknowledged marks
settle before freeze; hard Stop imposes no such wait. Include only marks
committed before freeze, validate immutable object hashes, and include the
incrementally marked result/log records. Result can be partial/missing with
an explicit reason on failed/stopped tasks. Module never invents success.

Persist manifest version/content hash and exact object IDs before deleting
anything. Delete unmarked objects and incomplete chunks/reservations by tracked
GC; report `sealed` only after this cleanup is confirmed, then return immutable
receipt. Delete failures retry while read-only with `seal cleanup pending`.
Same seal effect key returns same receipt/manifest, never scans a changing
workspace or reopens access. Core terminal outcome/outbox uses receipt ID and
manifest hash; loss of response means read/retry, not regenerate result.
Regular container working files are not magically retained: task must upload
and mark them. Pod/working volume deletion and module space GC are independent.

### S-D5. Retention, logical ceiling and batched warning

Core chooses retention policy through module control API: **90 days from
terminal time** default, `forever`, and per-space/artifact pin. Policy snapshots
and subsequent changes have revisions. Module is the sole executor/ledger of
retention and deletion; core decides policy and emits the ordinary owner notice.
An active/open task space is not age-evicted. 20 GB is logical retained + staged
accepted bytes + outstanding reservations, not a claim that physical PVC size
can equal 20 GB; S3 metadata/replication/backup headroom is additional capacity.
Use decimal **20,000,000,000 bytes**, displayed as GB, with exact byte ledger.
Physical free-space pressure fails uploads visibly, never evicts without policy.

Pin forbids automatic deletion. Forever disables age expiry; size-pressure
reclamation may select **unpinned forever** output only after the same warning
(the UI states this explicitly). If only pins/active spaces remain, reject new
uploads with `capacity_exhausted`, preserving existing output; do not delete
protected data. This engineering interpretation keeps forever meaningful for
age while honoring a finite ceiling; reviewer/owner must flag any mismatch.
Reservation at limit rejects the next byte; it does not silently delete during
PUT. Core can then propose oldest unpinned sealed spaces for reclaim. No user
prompt per item and no eviction hidden behind a failed upload retry.

Module builds one durable deletion plan with candidate IDs/revisions, total
bytes/reason and earliest-delete time. Default warning lead is **24 hours**
(engineering default), both for age and quota reclamation. A single ordinary
batched notice covers the plan, keyed by plan ID; core writes it through its
existing durable outbound/message path. `warningCommitted(planId, messageId)`
is accepted only with the matching persisted owner-notice receipt, not an LLM
assertion. No deletion until receipt exists and lead time elapsed. If core/chat
is down, deletion waits and capacity can block; nothing silently evicts.
Updates to the same pending batch coalesce; new candidates cannot inherit an
already elapsed warning window. No repeated notice on restart/delivery retry.

Before delete, atomically recheck pins/policy/object revisions and active-read
lease; changed/protected objects leave the plan. `deleting` tombstone prevents
new reads/marks; bounded existing read leases finish first (revoke for hard
space revoke is separate). SQL intent precedes S3 deletes; acknowledge removed
bytes only after backend confirms. Lost responses retry deletes safely; retain
tombstones/plan receipts while any retry path can name them. Owner manual delete
is an explicit authenticated action with its own receipt, not age GC pretending
consent. A reference in chat stores an artifact ID; after deletion show expired,
not an old URL or an automatic reupload.

### S-D6. Owner downloads and content boundary

Web gets narrow `openTaskArtifact(artifactId, range)` domain operation, which
resolves access/manifest and obtains bytes from module via its read-only service
identity. Web never holds S3 credentials or returns a presigned URL. ForwardAuth,
ADR-012 HTTPS and same-origin app route remain the owner boundary. No public
storage ingress or CORS. Server derives owner/recipient; a task ID alone is not
owner authorization. Attachment IDs in transcript refer to same download path.

Return no-store, nosniff, safe Content-Disposition `attachment` and escaped
filename metadata; arbitrary HTML/SVG must not execute as same-origin documents.
Ranges are validated/bounded, forwarded to the module with current read lease;
expired/tombstoned IDs return a safe not-available reason. Download response has
a bounded session lifetime and renews only after a fresh owner-auth check;
logout/expiry cancels further chunks, not merely the next tab navigation.
Backend response headers are allowlisted, never reflect S3/Bao errors or URLs.
Read metadata/log routes apply same auth; logs are not public troubleshooting
files. hf2k owns panel UI/walk, while storage owns API authorization checks.

### S-D7. Recovery, health and safe failure

Backup SQL catalog/space revisions/manifests/deletion tombstones plus Seaweed
volume data, filer metadata and IAM/config/custody as one recoverable set.
Record backup generation/cut and pause writes/GC for a consistent recovery
point; generic S3 copy or volume mirror alone is not enough. Keep recovery
copy outside the node's failure domain before claiming disk-loss recovery.
Restore into an empty instance, verify 32×4 MiB hashes and prefix/read denial,
then reconcile private orphans/incomplete uploads and deletion plans before
resuming writes. Never mark catalog-only objects healthy when bytes are absent.
Single-node/pod restart durability is required; **no disk-loss RPO/RTO promise**
is made until owner sets objectives and this drill records measured evidence.
Backups and private logs may contain personal data; apply same access custody.

Readiness fails on inaccessible catalog/backend, missing auth or unreconciled
unsafe catalog version. Empty/unset is not storage_unavailable. Liveness tests
process health, not absence of artifacts. Expose safe counters for reserved/
charged bytes, active transfers, denied cross-space calls, pending seal/GC,
oldest plan and backend failures; label only bounded status classes, not file
names/token/session values. Stage runbook must cover seal pending, auth failure,
capacity/pin pressure and restore hold. Bounded retries only for infrastructure
ambiguity; malformed names/tokens/quota do not launch retry storms.

## Options rejected and consequences

Options are from step A §4, judged in driver order, not reopened vendor ranking:

- **Core relay/proxy (Proxy/complete mediation):** kept byte mediation, rejected
  core ownership/data coupling by owner. Separate module lets tasks save during
  core restart and centralizes confinement for all consumers.
- **Per-object presigns (capability URLs):** key custody works but revocation
  lasts to URL expiry, size control needs separate validation, and S3 leaks to
  callers. Loses isolation/revocation before throughput matters. Not chosen.
- **Task STS/web identity (federation):** distributes signing secrets, violates
  no-key requirement even if short-lived. Seaweed IAM is not the module's
  complete-mediation boundary. Broker-held STS is defense in depth only.
- **Direct shared volume:** rejects the API assumption but couples lifetimes,
  leaks files and cannot satisfy retained downloads after task volume removal.
- **Swap SeaweedFS for RustFS/Garage:** not open; owner selected SeaweedFS for
  maturity/released authorization/backup evidence, not measured developer RSS.

All bytes cross module; capacity and failure monitoring are real costs accepted
by owner. Separate Postgres catalog/S3 means explicit intent/receipt recovery,
not transactions by assertion. Transferable projected tokens still matter:
keep them out of prompts/logs and bound to live Pods. Module independent of core
availability does not mean independent of SQL/API/Bao/Seaweed. No state-file
fallback or anonymous emergency mode is allowed. New direct-S3 consumers,
multi-node scale or a changed no-key rule reopen this record, not bypass it.

## Kept principles and stage checks

ADR-014's AGENTS.md principles/lessons apply here too: explicit durable home,
no compatibility paths, narrow symmetric domain operations, deterministic
validation, atomic history references, exact cursor/gap handling, secret-safe
logs and standards-aligned S3 **behind**, not instead of, the policy API.
Module never wakes an LLM on a timer; usage/GC Signals reach core through its
normal domain seam. Lifecycle watches/timers are infrastructure reconciliation.

Stages carry S01/S02 boundary and revoke tests first; S03–S05 upload/seal/crash
checks before terminal integration; S06/S07 ledger/clock/notice/read races before
GC is enabled; S08 plus hf2k browser walk before owner download acceptance;
S09 restore evidence before disk-loss claims; S10 pressure/failure tests and
runbook before deployment acceptance. All SQL tests use real stores through
`tests/helpers/test-stores.ts`; schema implementation adds expanding dbmate
migrations with squawk, not hidden loader files.

Sources: owner leaf comments; [ADR-013](013-model-gateway.md) platform custody;
[ADR-014](014-task-runtime.md) orchestration; [step A](../features/motor/tasks-options.md)
pattern/source inventory; [research both rounds](../research/task-runtime.md)
release-specific Seaweed/STS/probe/backup limitations. No new probe is claimed.
