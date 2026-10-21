# Storage retention and collection

Task: lifemodel-653.7.3. Implements the module side of ADR-015 S-D5, S06/S07.
This is not deployed acceptance. Core owner notices remain lifemodel-653.7.9.

## Policy and settings

The loader alone writes the version-1 platform settings document to both
`lifemodel/lifemodel-platform-settings` and
`lifemodel-system/lifemodel-storage-settings`. Its fixed-name RBAC and admission
rules permit those targets only (existing system PKI updates remain allowed).
The module mounts the second ConfigMap read-only at
`/opt/lifemodel/platform-settings/settings.json` and rereads it for each policy
snapshot and collection pass. It has no ConfigMap API rights. Missing/invalid
projection values use declared defaults with safe code/count diagnostics.
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

### Core's lifemodel-653.7.9 obligation

Fetch plans, persist one ordinary owner notice keyed by plan ID through core's
existing durable message/outbound path, then call `warningCommitted` with that
persisted message ID. Retry the same ID after lost responses. The module trusts
this authenticated service's receipt assertion, not task, web or LLM input;
it does not query core's message rows or implement outbound delivery. With core
or chat down, plans remain uncommitted and deletion waits indefinitely.
A reference to expired output must display not available, not reupload it.

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
block a restarted process forever.

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
resurrect a heartbeat stale for 60 seconds. Reclamation locks the boot row after
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
Diagnostics contain safe failure IDs, status, code and count, never private keys.
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

This leaf does not send owner notices (.7.9), implement consistent backup/restore
(.7.4), prove pressure/fair workers/RSS (.7.7), or wire stage-3 task lifecycle and
terminal outcomes. It does not replace independent stage review or deployment walks.
