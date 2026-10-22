# Storage retention and collection

Task: lifemodel-653.7.3. Implements the module side of ADR-015 S-D5, S06/S07.
The core side is lifemodel-653.7.9. This is not deployed acceptance.

## Policy and settings

The loader alone writes the version-1 platform settings document to both
`lifemodel/lifemodel-platform-settings` and
`lifemodel-system/lifemodel-storage-settings`. Its fixed-name RBAC and admission
rules permit those targets only (existing system PKI updates remain allowed).
The module mounts the second ConfigMap read-only at
`/opt/lifemodel/platform-settings/settings.json` and rereads it for each policy
snapshot and collection pass. It has no ConfigMap API rights. Missing/invalid
projections retain the last valid document with safe code/count diagnostics.
Before any valid document is read, freeze records no retention snapshot and
collection cannot age-select that space. The first valid document backfills the
absent snapshot using the original freeze instant. Later setting changes never
rewrite an existing snapshot; per-space changes use the core-only routes.
`storage.retention` is `90d` (default) or `forever`.
`storage.warningLeadDays` is an integer from 1 through 30, default 7.
The optional mount introduces no D-to-loader bootstrap wait: A0 starts loader,
A grants projection rights, B/C create stores, and D starts storage independently
of the settings projection's presence. No generation writes settings.

Freeze snapshots retention and settings revision, terminal instant and expiry
(terminal + 90 days, or no expiry). An unsealed space is never age-selected.
Policies have a separate monotonically increasing revision, pin flag and
`retained`, `deleting`, `deleted` state. A pinned or forever space is never
selected automatically. Changing a policy invalidates its pending candidates.

## Core-only control API

All routes use the existing TLS control listener 8444 and
`lifemodel-core-storage-control` audience with the current live
`lifemodel:core` Pod identity. Task and web tokens are refused.
Unknown/missing fields and invalid values are errors.

| Route | Request / response |
| --- | --- |
| `GET /retention/plans?limit=100&cursor=...` | Stable sequence cursor, 1..100 plans. Returns `{plans,nextCursor}`. A plan has `id`, `sequence`, `reason`, `state`, `leadDays`, `settingsRevision`, `totalBytes`. |
| `POST /retention/warningCommitted` | Exactly `{planId,messageId}`. Returns one persisted receipt `{id,planId,messageId,earliestDeleteAt}`. Same message replays it; another message conflicts, including after deletion/restart. |
| `POST /retention/pin` | `{space,effectKey,expectedRevision}`. |
| `POST /retention/unpin` | `{space,effectKey,expectedRevision}`. |
| `POST /retention/policy` | `{space,effectKey,expectedRevision,retention:"90d"|"forever"}`. |
| `POST /retention/reclaim` | `{effectKey,bytes}`; positive integer <= 20,000,000,000. Returns keyed receipt `{id,effectKey,planId}` (`null` when no eligible bytes). It proposes oldest finite unpinned sealed output; it does not delete or promise immediate capacity. |

Policy revisions are decimal strings, starting at `"0"`. Policy receipts return
`{id,space,effectKey,revision}`. Identical keyed requests replay receipts;
changed requests conflict. Pin that wins the policy lock removes pending
candidates. If deletion won, the new pin returns `409 already_deleting`; it
never acknowledges protection of bytes being removed.

### Core side

Core's `src/core/storage-control-client.ts` uses the control listener at
`https://storage-module.lifemodel-system.svc:8444`. It verifies TLS against only
the projected **public instance CA**, never system roots or an insecure fallback.
One keep-alive agent serves the client. Each request rereads both the projected
service token and CA and has a five-second overall deadline. The projection
reads race the same abort/deadline as HTTP; late filesystem results are discarded
and cannot start a request or hold the single-flight reconciler indefinitely. Errors and logs
contain a safe error ID, route, plan ID where known, HTTP status where received,
and count; they never contain response bodies, tokens, URLs or local paths.
Socket, request and response error listeners remain through teardown.

`src/core/storage-retention.ts` is bounded infrastructure, not a plugin or
cognition. It starts after stores and owner routing are ready, fetches one page
of at most 100 plans immediately, then runs every **five minutes**. The module
has no push contract. This fixed infrastructure reconciliation does not poll
the agent's thinking and does not change Design Principle 2. An outage/refusal
retries after 30 seconds, doubling to five minutes. A page advances only when
all its confirmations succeed; the last page resets the cursor. Each pass
serializes its work. Stop cancels its timer and HTTP work immediately without
waiting on a store operation or extending core's shared shutdown deadline.
A store operation that settles after stop cannot trigger a confirmation.

For each returned pending plan only, the core builds plain text with decimal
human-readable bytes, old task output, the plan's lead in days and an explicit
promise that nothing is deleted before that lead. It never lists files, object
keys or space IDs and never promises a pin tool. Templates support the language
codes already named by the composer (`en`, `ru`, `es`, `de`, `fr`, `zh`, `ja`),
including region codes and English language-name aliases. No preference uses
the existing core notices' English default. An unsupported explicit preference
leaves the plan pending until a supported preference is available; it does not
authorize deletion with a warning the owner might not understand. No LLM runs.

The outbound event ID is `storage-warning_` plus SHA-256 of **only** the plan ID.
Before appending, core checks the physical Postgres owner message row by its
permanent natural key `channel:web:<eventId>`. A Postgres read failure forbids
append and retries later. This lookup ignores clear/compaction views; the row
is the disk-backed, permanent record that the warning was sent. Admission is
closed if either this row or the Valkey hot receipt already exists.

`SnapshotStore.commitNotice` atomically appends a new `send.command` to the normal
outbound stream and retains its original payload in a hot, plan-keyed receipt
under the active Valkey epoch. It never overwrites a tick snapshot. The hot
receipt is not subject to outbound stream/event-key trimming, preserving the
append-to-Postgres gap and the original bytes/lead/language across a crash.
If the permanent Postgres row already exists, core rehydrates a temporary hot
receipt from its original content **without appending another event**. This
also handles a module listing an already-warned plan after restore.

The original event is projected idempotently into the owner's Postgres
conversation using that natural key. **Only after** outbound admission and the
Postgres write does core call `warningCommitted` with the same event ID.
After module acceptance (2xx) or 409, core freshly confirms that the physical
Postgres row is present, then deletes its hot receipt and pending-work index
member. Read/cleanup failures retain hot work for retry; no blind TTL is used.
A bounded 100-entry pending index retries unresolved confirmations even when an
accepted plan disappears from the list after a lost HTTP response. Such retry
uses only a plan already listed and durably admitted; it never invents a notice.
Confirmed historical plans leave no hot receipt. There is no cross-store
transaction; restart at any boundary reuses the same message ID and recovers
from the hot receipt or permanent row. A 409 logs plan/status and never invents
a new notice. Other refusals, token/TLS failures and outages leave unresolved
work pending for a later pass.

The recipient is the web owner (`web`, destination `owner`), as for other
owner-directed core work. A registered channel is not required: the ordinary
committed-event behavior still applies, and the owner can pull the Postgres
conversation. **This counts as warned, not as read or delivered.** It is right
for the existing web pull contract, which has no delivery cursor; this feature
does not add a read receipt. Core or stores being down prevents confirmation.
An owner/browser being offline does not prevent the lead clock after the notice
is committed and available in Postgres. A reference to expired output must
display not available, not reupload it.

The core mounts only `ca.crt` from a public `lifemodel-ca` ConfigMap replica in
its own namespace at `/var/run/secrets/lifemodel-storage-ca/ca.crt`, selected by
`LIFEMODEL_STORAGE_CONTROL_CA_FILE`. A0 precreates the replica and grants loader
get/update on that single name; PKI publishing writes and reads back source and
replica. No CA private key or module leaf Secret reaches core. The mount is
optional so an empty/not-yet-published projection cannot block core startup;
requests fail closed and retry until the CA arrives. Loader's A0 publishing
requires neither core nor stores; A grants other rights, B/C create stores and
D starts storage. There is no D-to-loader or core-to-loader bootstrap wait and
no new NetworkPolicy route. Standalone core omits both storage identity inputs;
a partial token/CA declaration is an error.

## Durable plans and deletion

Migration `20261015000015_create_storage_retention.sql` expands the catalog:
`instance_ledger`, `retention_policies`, `deletion_plans`,
`deletion_candidates`, `retention_receipts`, `reclaim_receipts`,
`retention_tombstones`, `read_leases`, `orphan_gc`, `attempt_gc`.
SQL functions pin `search_path` and revoke PUBLIC execute. All runtime writes
are fixed module-owned parameterized SQL; no caller SQL is accepted.

Plans are `pending` -> `warned` -> `complete`. Candidate states are
`pending`, `deleting`, `deleted`, `removed`. Candidate space/object revisions,
key and size are durable. Unexposed pending batches coalesce. The first list
that returns a plan durably freezes its membership (`exposed_at`) **before**
returning it: output selected while core sends that notice goes into a new plan,
not into a message that did not mention it. Fetching does not start the warning
clock or permit deletion. Pins can only remove protection candidates afterward.
This closes the fetch/send/commit membership race without another claim route.

`warningCommitted` starts the lead clock, never plan creation or fetch.
A later shorter setting cannot shorten an announced window. A larger lead
observed during reconciliation persists a later deadline, which a subsequent
decrease cannot undo. On deletion, the shared policy lock rechecks pins,
policy/object revisions, the warning receipt, lead and live read leases.
Changed candidates leave the plan and need a fresh warning if later selected.

A durable `deleting` intent precedes S3 DELETE. A session SQL advisory lock
serializes healthy contenders across the network step; process death releases it.
It does not fence S3 after the SQL session is lost. Backend DELETE is explicitly
**at-least-once and idempotent**: private keys are random, immutable and never
reused. A lost reply or lost session can cause another DELETE of that same key;
200/204/404 all confirm removal. Conditional SQL ledger updates release the
charge exactly once, even when a confirmation is replayed.

An error or end event on the lock-owning PostgreSQL client immediately aborts
that holder's in-flight S3 work through an AbortController. The holder awaits
transport settlement before its local cleanup completes. Candidate deletion,
expired-attempt cleanup and orphan deletion share this session-lock helper.
This cancels local transport ownership, not a DELETE already accepted by the
remote backend; its completion can remain ambiguous and safe to retry.
Tombstones and notice/policy/reclaim receipts remain; core marked reads of
deleting/deleted output return 404. Existing
bounded read leases finish before deletion; each chunk renews a 30-second lease
and independently rechecks current identity/catalog. Expired leases do not
block a restarted process forever. Stream close awaits a short bounded cleanup;
SQL failures log only a safe code, SQLSTATE and count. A later read retries a
bounded batch, and the tick removes expired leases even if cleanup failed.

## Capacity and private residue

The instance admission ceiling is exactly **20,000,000,000 decimal bytes**.
Transactional quota deltas count accepted staged/retained bytes and outstanding
reservations once across all spaces. Concurrent reservations serialize on one
ledger row. Exactly the ceiling is admitted; the next byte returns
`507 capacity_exhausted`. PUT never invokes deletion. Per-space quota still
applies. Pin, forever and active state never weaken due to pressure.

Backend completion after a crashed PUT can create private bytes after cleanup
confirmed absence. The sweep lists only the module bucket's `private/` keys,
with bounded authenticated SigV4 pages. Unreferenced keys are durably accounted
as orphan debt, then removed after a two-day age bound. A live non-retired
pending attempt and any catalog version protect their keys. Expired attempts
older than two days first receive a durable retirement marker under the same
quota/intent locks used by publication, but reservation expiry alone never proves
that a PUT stopped. Every real attempt records a random process boot ID in
`upload_attempts.owner_boot_id`; `upload_owners` holds its durable heartbeat.
Each module renews that heartbeat every five seconds using database wall time
(independent of retention's test clock). After 30 seconds without a timely
renewal the module aborts its transfers and refuses new ones; renewal cannot
resurrect a heartbeat stale for 60 seconds. Once the old boot is provably stale
by that same database predicate, a readiness/transfer request registers a new
boot and resumes service without a process restart. Old attempts remain under
the old boot and the staleness rule. Reclamation locks the boot row after
the quota/intent rows and requires either a stale foreign boot or its own boot
with no registered live transfer. Registration precedes begin-attempt publication
and lasts through settled transport and publication/cleanup. A live foreign boot
protects all its attempts, even after the original reservation lease expires.
Ownerless pre-expansion attempts are abandoned; they still need expired leases
and the two-day grace. Late publication of retired attempts is refused.
Reservation release follows backend confirmation. A retry creates a fresh private key.
Seal may return bounded `cleanup_pending` while a same-space collector transport is unsettled; keyed seal replay finishes after it settles. This cannot double-release a reservation.
Zero-attempt expired reservations can also be released; beginning an attempt
checks the current reservation/lease under that lock.

Discovery of already-existing late bytes can truthfully put the measured ledger
above the admission ceiling. It never admits new growth in this state. Confirmed
removal/release may reduce the debt even while still above the ceiling. Pretending
those bytes were absent, rejecting discovery, or deleting protected data would
be unsafe. Orphan tombstones are revived and charged again if the backend key
reappears. This is reconciliation of backend ambiguity, not a physical PVC bound.

One bounded background reconciliation loop runs in the single-replica/Recreate
module, with injected virtual clock and explicit `runOnce` in tests. Work pages
are bounded to 100. SQL locks/CAS and session ownership, not local maps, protect
against two healthy GC contenders. A failed orphan discovery or deletion keeps
its durable accounting state for retry and does not stop other keys in the page.
Unexpected private listing entries are skipped and counted as
`object_key_skipped`; structural page damage still fails the page without
advancing its cursor. The tick prunes at most 100 stale (seven-day) owner rows
and 100 confirmed attempt/orphan garbage rows older than the two-day grace per
table. A confirmed attempt and its publication identity retire together so
pruning cannot reopen publication. Diagnostics contain safe failure IDs, status,
code and count, never private keys.
One space's active reader is excluded before the candidate limit and rechecked
under lock so it does not block independent spaces.

## Evidence and remaining work

`tests/integration/storage-module-retention.test.ts` covers policy/age/leads,
coalescing, notices, quota proposals, identity refusal and 100-artifact restart.
`storage-module-gc.test.ts` covers pin/delete ordering, revisions, two processes,
active reads, lost replies, crashes and late private PUT reconciliation.
`storage-module-lock-loss.test.ts` terminates the lock-owning SQL backend while
a real child DELETE is held. It observes the first HTTP transport abort before a
second child confirms a retry, with one candidate and one ledger release.
`storage-module-ledger.test.ts` covers 100 metadata rows, exact boundary,
concurrent reservations, rollback and discovered debt. `storage-module-orphan.test.ts`
covers HTTP capacity and retirement fencing. `storage-module-upload-liveness.test.ts`
covers heartbeat renewal, held PUTs past their original leases, two live boot
owners, stale SIGKILL recovery, and per-key attempt/orphan retry isolation.
`storage-module-lock-loss.test.ts` terminates the actual PostgreSQL lock backend,
observes the first DELETE socket abort, then confirms an idempotent second DELETE
and a single ledger release. Unit settings and S3-list tests
exercise projection/defaults/RBAC and bounded authenticated backend enumeration.

This work does not implement consistent backup/restore (.7.4), prove
pressure/fair workers/RSS (.7.7), or wire stage-3 task lifecycle and
terminal outcomes. It does not replace independent stage review or deployment walks.
